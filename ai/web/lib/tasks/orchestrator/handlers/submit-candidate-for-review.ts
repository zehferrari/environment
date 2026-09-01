// ORCH-06 — submit_candidate_for_review procedure handlers.
//
// Trigger: assignee intent submit_for_review while In Progress.
//
// §17 side-effect ownership audit (PHASEE-06):
//   Row: submitted for review — command owns: comment, execution freeze,
//   candidate intent, procedure, receipt. This procedure owns: candidate prep,
//   validation, lease, Review, reviewer wake. No dual ownership.
//   Row: validation failed — mechanical command owns: To Do, cycle close,
//   repo state, receipt. This procedure owns: one feedback wake only.
//   Fixed: applyValidationResult now submits through submitWorkflowCommand
//   instead of calling applyTaskTransition directly.
//
// Ordered steps (§9):
//   1. freeze_execution — close the assignee execution episode for the active
//      cycle. Reject further implementation actions from that message/cycle
//      except a final checkpoint.
//   2. prepare_candidate — for code tasks, let PM create the submission commit
//      and push only when project policy permits. Epic-child branches remain
//      local-only. For repoTouched=false, verify a clean worktree and
//      establish the exact no-change candidate/base. Store candidate SHA on
//      the cycle and repository run.
//   3. run_validation — enqueue the branch verifier with cycle ID, procedure/
//      step IDs, expected base, candidate, branch, worktree registration, and
//      validation-profile snapshot. Enter waiting_callback.
//   4. apply_validation_result — match callback identifiers and candidate
//      exactly. Persist validation checks and outcome. On invalid evidence,
//      close the cycle as validation failed, move to the front of To Do, and
//      enqueue one assignee feedback notification. On operational failure,
//      retain recoverable state and retry/escalate.
//   5. create_review_lease — create a new immutable ReviewRun for the cycle.
//      Resolve reviewer: task acting manager -> actionable Epic acting
//      manager -> reporter.
//   6. enter_review — move In Progress to Review through the transition kernel
//      with cycle-scoped idempotency.
//   7. wake_reviewer — send one deduplicated notification containing the exact
//      candidate, validation summary, cycle ID, and allowed reviewer actions.
//
// Critical rule (§9): the procedure must make the intermediate
// In Progress + review_ready state visible and recoverable — no undetectable
// half-states.

import { db } from "@/lib/db";
import { updateTaskWorkflowCycleCandidate } from "@/lib/tasks/workflow-cycle";
import { updateTaskRepositoryState } from "@/lib/tasks/repository-state";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { registerStepHandler } from "@/lib/tasks/orchestrator/procedure-runner";
import type { StepHandlerResult, StepHandlerContext } from "@/lib/tasks/orchestrator/procedure-runner";
import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";
import { resolveEffectiveProjectSettings } from "@/lib/settings/effective";
import { resolveValidationProfileSnapshot } from "@/lib/tasks/validation-profile";
import { effectiveTaskBranchName, effectiveEpicBranchName } from "@/lib/work-items/branches";
import { effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import type { BranchVerifyJob } from "@/lib/deploy/branch-verify";
import { REPOSITORY_JOB_SCHEMA_V2 } from "@/lib/deploy/branch-verify";

const PROCEDURE_TYPE: TaskProcedureType = "submit_candidate_for_review";

// --- Step 1: freeze_execution -------------------------------------------
// Close the assignee execution episode for the active cycle. This prevents
// further implementation actions from the same episode.
async function freezeExecution(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      status: true,
      assigneeId: true,
      assignee: { select: { agent: { select: { slug: true } } } },
    },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  if (task.status !== "In Progress") {
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  // Close the latest open execution episode for this task+agent.
  if (task.assigneeId && task.assignee?.agent) {
    const openEpisode = await db.taskExecutionEpisode.findFirst({
      where: { taskId: task.id, agentSlug: task.assignee.agent.slug, status: "open" },
      orderBy: { episodeNo: "desc" },
    });
    if (openEpisode) {
      await db.taskExecutionEpisode.update({
        where: { id: openEpisode.id },
        data: {
          status: "closed",
          closedAt: new Date(),
          closeReason: "review_submission",
        },
      });
    }
  }
  return { status: "completed", output: { frozen: true } };
}

// --- Step 2: prepare_candidate ------------------------------------------
// For code tasks, the repository runner commits and pushes (if policy
// permits). For non-code tasks, verify a clean worktree. Store the candidate
// SHA on the cycle and repository run.
// In the procedure engine, this step is a simplified version: it records the
// candidate SHA from the repository run (which was set by the assignee's
// ready_for_review action) and updates the cycle. The actual commit/push is
// handled by the existing repository runner spool.
async function prepareCandidate(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      status: true,
      projectId: true,
      project: { select: { repositoryPath: true } },
      repositoryRun: { select: { phase: true, candidateSha: true, baseSha: true, worktreePath: true, branchName: true } },
    },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  if (task.status !== "In Progress") {
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  // Non-code task: no candidate SHA in the repository run. Use the candidate
  // from the procedure run's input (command payload) or fall back to a
  // no-repo marker.
  if (!task.project.repositoryPath) {
    // Read the procedure run's input for the candidateSha from the command payload.
    const procRun = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: ctx.procedureRunId }, select: { input: true } });
    let procInput: Record<string, unknown> | null = null;
    if (procRun.input) { try { procInput = JSON.parse(procRun.input); } catch { /* ignore */ } }
    const candidateSha = (procInput?.candidateSha as string) ?? "non-repo";
    await db.$transaction((tx) =>
      updateTaskWorkflowCycleCandidate(tx, {
        taskId: task.id,
        candidateSha,
        baseSha: task.repositoryRun?.baseSha ?? null,
      }),
    );
    return { status: "completed", output: { codeTouching: false, candidateSha } };
  }
  // Code task: read the candidate SHA from the procedure input (command
  // payload) first, then fall back to the repository run. The procedure
  // input carries the validated context from the route's tryV2CanaryMutation
  // call, which may include a candidateSha that was not yet persisted to
  // TaskRepositoryRun (e.g. when the legacy handoff hasn't run yet).
  const procRun = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: ctx.procedureRunId }, select: { input: true } });
  let procInput: Record<string, unknown> | null = null;
  if (procRun.input) { try { procInput = JSON.parse(procRun.input); } catch { /* ignore */ } }
  const candidateSha = (procInput?.candidateSha as string) ?? task.repositoryRun?.candidateSha ?? null;
  const baseSha = task.repositoryRun?.baseSha ?? null;
  if (!candidateSha) {
    // The branch verifier is the sole owner of submission-commit creation. A
    // dirty worktree therefore has no candidate SHA yet; carry null as the
    // previous candidate and let the correlated verifier callback establish
    // the authoritative candidate after it creates/validates the commit.
    return { status: "completed", output: { codeTouching: true, candidateSha: null, baseSha } };
  }
  // Update the cycle with the candidate SHA.
  await db.$transaction((tx) =>
    updateTaskWorkflowCycleCandidate(tx, {
      taskId: task.id,
      candidateSha,
      baseSha,
    }),
  );
  return { status: "completed", output: { codeTouching: true, candidateSha, baseSha } };
}

// --- Step 3: run_validation ---------------------------------------------
// Enqueue the branch verifier with a COMPLETE BranchVerifyJob including all
// required repository, project, identity, requester, and validation-profile
// fields. Enter waiting_callback. For non-code tasks, skip validation.
async function runValidation(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const prevStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "prepare_candidate" },
    select: { output: true },
  });
  let candidateOutput: Record<string, unknown> | null = null;
  if (prevStep?.output) {
    try { candidateOutput = JSON.parse(prevStep.output); } catch { /* ignore */ }
  }
  if (candidateOutput?.superseded === true) {
    return { status: "completed", output: { superseded: true, reason: candidateOutput.reason } };
  }
  // Non-code task: skip validation.
  if (candidateOutput?.codeTouching === false) {
    return { status: "completed", output: { skipped: true, reason: "non_code_task", validationOutcome: "valid" } };
  }
  // Code task: build a complete BranchVerifyJob with all required fields.
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      title: true,
      description: true,
      projectId: true,
      epicId: true,
      workItemKey: true,
      branchName: true,
      commitPrefix: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true, agent: { select: { slug: true } } } },
      project: {
        select: {
          slug: true,
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
          deploymentPrTargetBranch: true,
        },
      },
      epic: { select: { workItemKey: true, branchName: true, commitPrefix: true, status: true, actingManagerId: true } },
      repositoryRun: { select: { branchName: true, baseSha: true, candidateSha: true, worktreePath: true, attempt: true } },
    },
  });
  if (!task?.project.repositoryPath) {
    return { status: "failed", error: "Task has no repository path for validation.", retryable: false };
  }
  const branchName = task.repositoryRun?.branchName ?? effectiveTaskBranchName(task);
  if (!branchName) {
    return { status: "failed", error: "No effective branch name for validation.", retryable: false };
  }
  // Resolve effective settings for git identity and base branch.
  const effectiveSettings = await resolveEffectiveProjectSettings({
    id: task.projectId,
    defaultGitUserName: task.project.defaultGitUserName,
    defaultGitUserEmail: task.project.defaultGitUserEmail,
    deploymentProductionBranch: null,
    deploymentPrTargetBranch: task.project.deploymentPrTargetBranch,
  });
  const validationProfile = await resolveValidationProfileSnapshot(task.projectId);
  // PHASEE-07 Fix #3: Deterministic job ID based on procedure run + step —
  // a crash-replay re-publishes the same jobId, hitting the same spool path,
  // so no duplicate spool file is created.
  const jobId = `proc-val-${ctx.procedureRunId}-${ctx.stepId}`;
  // PHASEE-07: Resolve repository run for V2 identity fields.
  const repoRun = await db.taskRepositoryRun.findUnique({
    where: { taskId: task.id },
    select: { id: true, version: true, baseSha: true, candidateSha: true },
  });
  const job: BranchVerifyJob = {
    jobId,
    taskId: task.id,
    projectId: task.projectId,
    projectSlug: task.project.slug,
    repositoryPath: task.project.repositoryPath,
    branchName,
    // PHASEE-07: emit schema-v2 job with mandatory V2 identity fields.
    schemaVersion: REPOSITORY_JOB_SCHEMA_V2,
    procedureRunId: ctx.procedureRunId,
    procedureStepId: ctx.stepId,
    workflowCycleId: ctx.workflowCycleId,
    commandReceiptId: null, // populated when command receipt is available in ctx
    repositoryRunId: repoRun?.id ?? null,
    repositoryRunVersion: repoRun?.version ?? null,
    baseBranch: effectiveSettings.deployment.prTargetBranch.value,
    epicChild: Boolean(task.epicId),
    epicBranch: task.epic ? effectiveEpicBranchName(task.epic) : null,
    commitPrefix: effectiveTaskCommitPrefix(task),
    expectedGitUserName: effectiveSettings.gitIdentity.name.value,
    expectedGitUserEmail: effectiveSettings.gitIdentity.email.value,
    taskTitle: task.title,
    taskDescription: task.description,
    assigneeNote: null,
    baseSha: typeof candidateOutput?.baseSha === "string" ? candidateOutput.baseSha : task.repositoryRun?.baseSha ?? null,
    previousCandidateSha: typeof candidateOutput?.candidateSha === "string" ? candidateOutput.candidateSha : task.repositoryRun?.candidateSha ?? null,
    monitorUserId: undefined,
    monitorAgentSlug: undefined,
    attempt: (task.repositoryRun?.attempt ?? 0) + 1,
    requestedByAgentSlug: task.assignee?.agent?.slug ?? "procedure-engine",
    requestedByUserId: task.assigneeId ?? "procedure-engine",
    requestedAt: new Date().toISOString(),
    validationProfile,
  };
  // Enqueue the branch_verify outbox effect. The outbox drain enqueues the
  // actual verifier job file. The verifier callback will come back via
  // applyProcedureCallback.
  await enqueueWorkflowEffects(db, {
    taskId: task.id,
    projectId: task.projectId,
    aggregateVersion: 0,
    effects: [{
      type: "branch_verify",
      key: `procedure-validation:${jobId}`,
      payload: { job: job as unknown as Record<string, unknown> },
    }],
  });
  // Update repository state to validating.
  await updateTaskRepositoryState(task.id, {
    phase: "validating",
    branchName,
    repoTouched: true,
    validationOutcome: null,
    lastError: null,
    incrementAttempt: true,
  });
  // PHASEE-07: Publication lifecycle:
  //   publishing  → set here at enqueue time.
  //   published   → set by procedure-runner when the callback is applied (step completes).
  //   pending     → set by procedure-runner when a duplicate callback arrives for an
  //                 already-completed step; replayCount is incremented there.
  // A re-enqueue after crash-recovery sees publicationState="published" and
  // increments replayCount here, then sets "publishing" for the new enqueue.
  // PHASEE-07 Fix #3: Store full V2 identity packet in waiting_callback output
  // so a crash-replay can re-publish the same job deterministically.
  const existingRepoRun = await db.taskRepositoryRun.findUnique({
    where: { taskId: task.id },
    select: { id: true, publicationState: true, replayCount: true },
  });
  const isReplay = existingRepoRun?.publicationState === "published";
  await db.taskRepositoryRun.update({
    where: { taskId: task.id },
    data: {
      publicationState: "publishing",
      replayCount: isReplay ? (existingRepoRun?.replayCount ?? 0) + 1 : existingRepoRun?.replayCount ?? 0,
    },
  });
  const v2Identity = {
    schemaVersion: REPOSITORY_JOB_SCHEMA_V2,
    jobId,
    taskId: task.id,
    workflowCycleId: ctx.workflowCycleId,
    procedureRunId: ctx.procedureRunId,
    procedureStepId: ctx.stepId,
    commandReceiptId: null,
    repositoryRunId: repoRun?.id ?? null,
    repositoryRunVersion: repoRun?.version ?? null,
    // PHASEE-07 Fix #1: Use the same source as job.previousCandidateSha/job.baseSha
    // (candidateOutput) so exact correlation never rejects a legitimate callback.
    // The DB row's candidateSha can lag behind on resubmission after review_feedback.
    candidateSha: typeof candidateOutput?.candidateSha === "string" ? candidateOutput.candidateSha : task.repositoryRun?.candidateSha ?? null,
    baseSha: typeof candidateOutput?.baseSha === "string" ? candidateOutput.baseSha : task.repositoryRun?.baseSha ?? null,
  };
  return { status: "waiting_callback", jobId, output: { ...v2Identity, branchName } };
}

// --- Step 4: apply_validation_result ------------------------------------
// This step runs after the callback marks step 3 as completed. It reads the
// callback data from step 3's output and applies the validation result.
// On valid: proceed to create_review_lease. On invalid: close the cycle,
// move to To Do (front), enqueue feedback. On operational failure: retry.
async function applyValidationResult(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const validationStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "run_validation" },
    select: { output: true },
  });
  let validationOutput: Record<string, unknown> | null = null;
  if (validationStep?.output) {
    try { validationOutput = JSON.parse(validationStep.output); } catch { /* ignore */ }
  }
  if (validationOutput?.superseded === true) {
    return { status: "completed", output: { superseded: true, reason: validationOutput.reason } };
  }
  if (validationOutput?.skipped === true) {
    // Non-code task: validation was skipped, outcome is "valid".
    return { status: "completed", output: { validationOutcome: "valid", skipped: true } };
  }
  // The callback data is in the validation step's output (updated by
  // applyProcedureCallback). It should contain the validation outcome.
  const outcome = validationOutput?.validationOutcome as string | undefined;
  const candidateSha = validationOutput?.candidateSha as string | undefined;
  if (!outcome) {
    // No validation outcome in the callback — this is an operational error.
    return { status: "failed", error: "Validation callback did not include an outcome.", retryable: true };
  }
  if (outcome === "valid" || outcome === "valid_with_warning") {
    // Validation passed — proceed to create_review_lease.
    await updateTaskRepositoryState(ctx.taskId, {
      phase: "review_ready",
      candidateSha: candidateSha ?? undefined,
      validationOutcome: outcome as "valid" | "valid_with_warning",
      lastError: null,
    });
    return { status: "completed", output: { validationOutcome: outcome, candidateSha } };
  }
  if (outcome === "invalid") {
    // Validation failed — close the cycle, move to To Do (front), enqueue
    // feedback. Per §17 ownership matrix, the mechanical command (To Do,
    // cycle close, repo state, receipt) is owned by the command boundary,
    // NOT the procedure handler. The procedure submits the mechanical intent
    // through submitWorkflowCommand so the orchestrator's execute path owns
    // the transition atomically. The procedure only owns the feedback
    // notification (outbox effect).
    const error = (validationOutput?.error as string) ?? "Repository validation failed.";
    await updateTaskRepositoryState(ctx.taskId, {
      phase: "action_required",
      validationOutcome: "invalid",
      lastError: error,
    });
    // Submit the mechanical validation_failed intent through the command
    // boundary (§17 row: validation_failed — atomic DB owner is the
    // mechanical command, NOT the procedure handler).
    const freshTask = await db.task.findUniqueOrThrow({
      where: { id: ctx.taskId },
      select: { workflowVersion: true, activeWorkflowCycleId: true, assigneeId: true, status: true },
    });
    if (freshTask.status === "In Progress") {
      const result = await submitWorkflowCommand({
        taskId: ctx.taskId,
        intent: "repository_validation_failed",
        actor: { id: freshTask.assigneeId ?? "procedure-engine", kind: "agent", username: "procedure-engine", role: "monitor" },
        expectedWorkflowVersion: freshTask.workflowVersion,
        workflowCycleId: freshTask.activeWorkflowCycleId,
        idempotencyKey: `procedure-validation-failed:${ctx.procedureRunId}`,
        source: "callback",
        evidence: { validationOutcome: "invalid", candidateSha, error, procedureRunId: ctx.procedureRunId, mechanical: true },
        payload: {
          procedureRunId: ctx.procedureRunId,
          procedureStepId: ctx.stepId,
          jobId: null,
          candidateSha: candidateSha ?? null,
          baseSha: null,
          outcome: "failed",
          failureReason: error,
        },
      });
      if (result.status !== "accepted" && result.status !== "replayed") {
        return { status: "failed", error: `Failed to submit validation failure: ${result.status} — ${result.reason ?? "no reason"}`, retryable: result.status === "stale" };
      }
    }
    // submitWorkflowCommand owns the single validation-feedback effect. Do not
    // enqueue another procedure-local notification here: two distinct outbox
    // keys used to dispatch duplicate Carmen turns for the same failure.
    // Mark the procedure as completed (it handled the failure path).
    return { status: "completed", output: { validationOutcome: "invalid", cycleClosed: true, movedToTodo: true } };
  }
  // operational_error: retryable.
  return { status: "failed", error: `Validation returned operational_error: ${validationOutput?.error ?? "unknown"}`, retryable: true };
}

// --- Step 5: create_review_lease ----------------------------------------
// Create a new immutable ReviewRun for the cycle. Resolve reviewer: task
// acting manager -> actionable Epic acting manager -> reporter. Store the
// resolved reviewer ID on the lease.
async function createReviewLease(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const validationStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "apply_validation_result" },
    select: { output: true },
  });
  let validationOutput: Record<string, unknown> | null = null;
  if (validationStep?.output) {
    try { validationOutput = JSON.parse(validationStep.output); } catch { /* ignore */ }
  }
  if (validationOutput?.superseded === true || validationOutput?.cycleClosed === true) {
    return { status: "completed", output: { skipped: true, reason: validationOutput.superseded ? "superseded" : "cycle_closed" } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      status: true,
      projectId: true,
      actingManagerId: true,
      reporterId: true,
      epicId: true,
      activeWorkflowCycleId: true,
      repositoryRun: { select: { candidateSha: true, baseSha: true, repoTouched: true } },
      epic: { select: { status: true, actingManagerId: true } },
      project: { select: { onlyReportersCanSetTasksDone: true } },
    },
  });
  if (!task || !task.activeWorkflowCycleId) {
    return { status: "failed", error: "No active workflow cycle for review lease.", retryable: false };
  }
  if (task.status !== "In Progress") {
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  // Read the candidate SHA from the prepare_candidate step's output (the
  // authoritative source within the procedure), falling back to the
  // repository run, then to the cycle's candidateSha.
  const prepareStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "prepare_candidate" },
    select: { output: true },
  });
  let prepareOutput: Record<string, unknown> | null = null;
  if (prepareStep?.output) {
    try { prepareOutput = JSON.parse(prepareStep.output); } catch { /* ignore */ }
  }
  const candidateSha = (prepareOutput?.candidateSha as string) ?? task.repositoryRun?.candidateSha ?? "no-repo";
  const reviewerId = resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
  });
  const validationOutcome = (validationOutput?.validationOutcome as string) ?? "valid";
  // P1-6: persist the resolved reviewer on the lease so the guard can
  // verify reviewer identity at decision time.
  await db.reviewRun.upsert({
    where: { workflowCycleId: task.activeWorkflowCycleId },
    create: {
      taskId: task.id,
      workflowCycleId: task.activeWorkflowCycleId,
      candidateSha,
      baseSha: task.repositoryRun?.baseSha ?? null,
      repoTouched: task.repositoryRun?.repoTouched ?? false,
      validationOutcome: validationOutcome as "valid" | "valid_with_warning",
      status: "awaiting_review",
    },
    update: {
      candidateSha,
      baseSha: task.repositoryRun?.baseSha ?? null,
      repoTouched: task.repositoryRun?.repoTouched ?? false,
      validationOutcome: validationOutcome as "valid" | "valid_with_warning",
      status: "awaiting_review",
      reviewerId: null,
      reviewedAt: null,
      invalidatedAt: null,
      invalidatedReason: null,
    },
  });
  // P1-6: the resolved reviewer is stored in the step output for the guard
  // and wake_reviewer to consume, NOT on the ReviewRun.reviewerId field —
  // that field is the DECISION actor, set only when the reviewer accepts or
  // requests changes (by execute.ts).
  return { status: "completed", output: { reviewRunCreated: true, candidateSha, resolvedReviewerId: reviewerId } };
}

// --- Step 6: enter_review -----------------------------------------------
// Move In Progress to Review through the transition kernel with cycle-scoped
// idempotency. This is a mechanical transition performed by the procedure
// engine (not a human decision).
async function enterReview(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const leaseStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "create_review_lease" },
    select: { output: true },
  });
  let leaseOutput: Record<string, unknown> | null = null;
  if (leaseStep?.output) {
    try { leaseOutput = JSON.parse(leaseStep.output); } catch { /* ignore */ }
  }
  if (leaseOutput?.skipped === true || leaseOutput?.superseded === true) {
    return { status: "completed", output: { skipped: true, reason: leaseOutput.reason } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: { id: true, status: true, projectId: true, workflowVersion: true, activeWorkflowCycleId: true },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  if (task.status !== "In Progress") {
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  // Use the orchestrator's mechanical callback intent to move to Review.
  // This goes through the kernel via the orchestrator boundary (single
  // status writer invariant). Read the current workflow version fresh —
  // it may have changed since the procedure was created. Use the assignee's
  // user ID as the mechanical actor (the procedure acts on the assignee's
  // behalf; the decision actor is recorded separately by the orchestrator).
  const freshTask = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { workflowVersion: true, activeWorkflowCycleId: true, assigneeId: true, repositoryRun: { select: { baseSha: true } } } });
  const candidateSha = (leaseOutput?.candidateSha as string) ?? null;
  const realBaseSha = freshTask.repositoryRun?.baseSha ?? null;
  const result = await submitWorkflowCommand({
    taskId: task.id,
    intent: "repository_validation_succeeded",
    actor: { id: freshTask.assigneeId ?? "procedure-engine", kind: "agent", username: "procedure-engine", role: "monitor" },
    expectedWorkflowVersion: freshTask.workflowVersion,
    workflowCycleId: freshTask.activeWorkflowCycleId,
    idempotencyKey: `procedure-enter-review:${ctx.procedureRunId}`,
    source: "callback",
    evidence: { candidateSha, procedureRunId: ctx.procedureRunId },
    payload: {
      procedureRunId: ctx.procedureRunId,
      procedureStepId: ctx.stepId,
      jobId: null,
      candidateSha: candidateSha ?? null,
      baseSha: realBaseSha ?? null,
      outcome: "succeeded",
    },
  });
  if (result.status !== "accepted" && result.status !== "replayed") {
    return { status: "failed", error: `Failed to enter Review: ${result.status} — ${result.reason ?? "no reason"}`, retryable: result.status === "stale" };
  }
  return { status: "completed", output: { enteredReview: true, transitionId: result.status === "accepted" ? result.transitionId : null } };
}

// --- Step 7: wake_reviewer ----------------------------------------------
// Send one deduplicated notification containing the exact candidate,
// validation summary, cycle ID, and allowed reviewer actions.
async function wakeReviewer(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const enterStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "enter_review" },
    select: { output: true },
  });
  let enterOutput: Record<string, unknown> | null = null;
  if (enterStep?.output) {
    try { enterOutput = JSON.parse(enterStep.output); } catch { /* ignore */ }
  }
  if (enterOutput?.skipped === true || enterOutput?.superseded === true) {
    return { status: "completed", output: { skipped: true, reason: enterOutput.reason } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      activeWorkflowCycleId: true,
      actingManagerId: true,
      reporterId: true,
      epic: { select: { status: true, actingManagerId: true } },
      assignee: { select: { id: true, username: true } },
      repositoryRun: { select: { candidateSha: true, validationOutcome: true } },
    },
  });
  if (!task) {
    return { status: "completed", output: { skipped: true, reason: "task_not_found" } };
  }
  const reviewerId = resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
  });
  if (!reviewerId) {
    return { status: "completed", output: { skipped: true, reason: "no_reviewer" } };
  }
  const candidateSha = task.repositoryRun?.candidateSha ?? "no-repo";
  const validationOutcome = task.repositoryRun?.validationOutcome ?? "valid";
  const actor = task.assignee ?? { id: "pm", username: "pm" };
  await enqueueWorkflowEffects(db, {
    taskId: task.id,
    projectId: task.projectId,
    aggregateVersion: 0,
    effects: [{
      type: "task_notification",
      key: `submit_candidate_for_review:wake:${task.id}:${ctx.procedureRunId}`,
      payload: {
        taskId: task.id,
        targetUserId: reviewerId,
        actor: { id: actor.id, kind: "agent", username: actor.username },
        reason: "review_requested",
        body: [
          `Repository validation ${validationOutcome === "valid_with_warning" ? "passed with an advisory warning" : "passed"} for "${task.title}".`,
          `Candidate: ${candidateSha}`,
          `Cycle: ${task.activeWorkflowCycleId ?? "unknown"}`,
          "Review the exact validated candidate. If satisfied, use action=accept_review. If changes remain, use action=request_review_changes with one consolidated comment.",
        ].join("\n"),
      },
    }],
  });
  return { status: "completed", output: { woke: true, reviewerId } };
}

// --- Register handlers ----------------------------------------------------
export function registerSubmitCandidateForReviewHandlers(): void {
  registerStepHandler(PROCEDURE_TYPE, 1, "freeze_execution", freezeExecution);
  registerStepHandler(PROCEDURE_TYPE, 1, "prepare_candidate", prepareCandidate);
  registerStepHandler(PROCEDURE_TYPE, 1, "run_validation", runValidation);
  registerStepHandler(PROCEDURE_TYPE, 1, "apply_validation_result", applyValidationResult);
  registerStepHandler(PROCEDURE_TYPE, 1, "create_review_lease", createReviewLease);
  registerStepHandler(PROCEDURE_TYPE, 1, "enter_review", enterReview);
  registerStepHandler(PROCEDURE_TYPE, 1, "wake_reviewer", wakeReviewer);
}
