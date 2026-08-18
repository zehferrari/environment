// ORCH-06 — submit_candidate_for_review procedure handlers.
//
// Trigger: assignee intent submit_for_review while In Progress.
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
import { updateTaskWorkflowCycleCandidate, closeTaskWorkflowCycle } from "@/lib/tasks/workflow-cycle";
import { updateTaskRepositoryState } from "@/lib/tasks/repository-state";
import { enqueueWorkflowEffects, applyTaskTransition } from "@/lib/tasks/transition-kernel";
import { resolveReviewOwnerIdFromSnapshot } from "@/lib/tasks/orchestrator/authorize";
import { registerStepHandler } from "@/lib/tasks/orchestrator/procedure-runner";
import type { StepHandlerResult, StepHandlerContext } from "@/lib/tasks/orchestrator/procedure-runner";
import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";

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
  // Code task: the candidate SHA should already be set by the assignee's
  // ready_for_review action (via the existing review-handoff). Read it from
  // the repository run. If not set, this is an operational error.
  const candidateSha = task.repositoryRun?.candidateSha ?? null;
  const baseSha = task.repositoryRun?.baseSha ?? null;
  if (!candidateSha) {
    return { status: "failed", error: "No candidate SHA recorded on the repository run.", retryable: true };
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
// Enqueue the branch verifier. Enter waiting_callback. The callback must
// include procedure ID, step ID, task ID, cycle ID, job ID, and expected
// candidate/base SHA. For non-code tasks, skip validation and proceed
// directly to create_review_lease.
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
  // Code task: enqueue the branch verifier via the outbox. The existing
  // review-handoff.ts already enqueues branch_verify effects; here we
  // enqueue it as a procedure step that waits for a callback.
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      projectId: true,
      repositoryRun: { select: { branchName: true, baseSha: true, candidateSha: true, worktreePath: true } },
    },
  });
  if (!task?.repositoryRun?.candidateSha) {
    return { status: "failed", error: "No candidate SHA for validation.", retryable: false };
  }
  // Enqueue a branch_verify outbox effect. The outbox drain enqueues the
  // actual verifier job. The callback will come back via
  // applyProcedureCallback.
  const jobId = `proc-val-${ctx.procedureRunId}-${Date.now()}`;
  await enqueueWorkflowEffects(db, {
    taskId: task.id,
    projectId: task.projectId,
    aggregateVersion: 0,
    effects: [{
      type: "branch_verify",
      key: `procedure-validation:${jobId}`,
      payload: {
        job: {
          jobId,
          taskId: task.id,
          projectId: task.projectId,
          branchName: task.repositoryRun.branchName,
          baseSha: task.repositoryRun.baseSha,
          candidateSha: task.repositoryRun.candidateSha,
          worktreePath: task.repositoryRun.worktreePath,
          procedureRunId: ctx.procedureRunId,
          stepId: ctx.stepId,
          workflowCycleId: ctx.workflowCycleId,
        },
      },
    }],
  });
  // Enter waiting_callback. The verifier callback will apply via
  // applyProcedureCallback with the jobId.
  return { status: "waiting_callback", jobId, output: { candidateSha: task.repositoryRun.candidateSha } };
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
    // feedback. This is a mechanical transition performed by the procedure
    // engine (not a human decision).
    const error = (validationOutput?.error as string) ?? "Repository validation failed.";
    await updateTaskRepositoryState(ctx.taskId, {
      phase: "action_required",
      validationOutcome: "invalid",
      lastError: error,
    });
    // Close the cycle as validation_failed.
    await db.$transaction(async (tx) => {
      await closeTaskWorkflowCycle(tx, {
        taskId: ctx.taskId,
        outcome: "validation_failed",
        candidateSha: candidateSha ?? null,
      });
      // Move In Progress -> To Do (front) via the kernel.
      const task = await tx.task.findUniqueOrThrow({ where: { id: ctx.taskId }, select: { projectId: true, status: true } });
      if (task.status === "In Progress") {
        await applyTaskTransition(tx, {
          taskId: ctx.taskId,
          projectId: task.projectId,
          intent: "repository_validation_failed",
          from: "In Progress",
          to: "To Do",
          source: "procedure-validation",
          idempotencyKey: `procedure-validation-failed:${ctx.procedureRunId}`,
          rank: "front",
          evidence: { validationOutcome: "invalid", candidateSha, error, mechanical: true },
        });
      }
    });
    // Enqueue feedback notification to assignee.
    const taskForFeedback = await db.task.findUnique({ where: { id: ctx.taskId }, select: { id: true, projectId: true, assigneeId: true, assignee: { select: { id: true, username: true } }, title: true } });
    if (taskForFeedback?.assigneeId && taskForFeedback.assignee) {
      await enqueueWorkflowEffects(db, {
        taskId: taskForFeedback.id,
        projectId: taskForFeedback.projectId,
        aggregateVersion: 0,
        effects: [{
          type: "task_notification",
          key: `validation-feedback:${taskForFeedback.id}:${ctx.procedureRunId}`,
          payload: {
            taskId: taskForFeedback.id,
            targetUserId: taskForFeedback.assigneeId,
            actor: { id: taskForFeedback.assignee.id, kind: "agent", username: taskForFeedback.assignee.username },
            reason: "review_feedback",
            body: `Repository validation failed for "${taskForFeedback.title}": ${error}\nThe task returned to the front of To Do. Correct the issue and resubmit.`,
          },
        }],
      });
    }
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
  const reviewerId = resolveReviewOwnerIdFromSnapshot({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
  });
  const validationOutcome = (validationOutput?.validationOutcome as string) ?? "valid";
  // Create the immutable ReviewRun for this cycle. The @@unique on
  // workflowCycleId ensures one lease per cycle.
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
  return { status: "completed", output: { reviewRunCreated: true, candidateSha, reviewerId } };
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
  const freshTask = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { workflowVersion: true, activeWorkflowCycleId: true, assigneeId: true } });
  const candidateSha = (leaseOutput?.candidateSha as string) ?? null;
  const result = await submitWorkflowCommand({
    taskId: task.id,
    intent: "repository_validation_succeeded",
    actor: { id: freshTask.assigneeId ?? "procedure-engine", kind: "agent", username: "procedure-engine", role: "monitor" },
    expectedWorkflowVersion: freshTask.workflowVersion,
    workflowCycleId: freshTask.activeWorkflowCycleId,
    idempotencyKey: `procedure-enter-review:${ctx.procedureRunId}`,
    source: "procedure-submit-candidate",
    evidence: { candidateSha, procedureRunId: ctx.procedureRunId },
    payload: { candidateSha },
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
  const reviewerId = resolveReviewOwnerIdFromSnapshot({
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
  registerStepHandler(PROCEDURE_TYPE, "freeze_execution", freezeExecution);
  registerStepHandler(PROCEDURE_TYPE, "prepare_candidate", prepareCandidate);
  registerStepHandler(PROCEDURE_TYPE, "run_validation", runValidation);
  registerStepHandler(PROCEDURE_TYPE, "apply_validation_result", applyValidationResult);
  registerStepHandler(PROCEDURE_TYPE, "create_review_lease", createReviewLease);
  registerStepHandler(PROCEDURE_TYPE, "enter_review", enterReview);
  registerStepHandler(PROCEDURE_TYPE, "wake_reviewer", wakeReviewer);
}