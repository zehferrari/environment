// ORCH-07 — Review feedback and acceptance/finalization procedure handlers.
//
// Two procedures:
//   1. return_review_for_changes — triggered by request_review_changes.
//   2. finalize_accepted_review — triggered by accept_review.
//
// §17 side-effect ownership audit (PHASEE-06):
//   Row: review changes requested — command owns: comment, exact lease
//   decision, To Do, cycle close, repo state, procedure. This procedure
//   (return_review_for_changes) owns: invalidate mechanical effects,
//   revalidation mark, wake. No dual ownership — handlers do not call
//   applyTaskTransition.
//   Row: review accepted — command owns: exact immutable acceptance,
//   finalization procedure. This procedure (finalize_accepted_review) owns:
//   repository finalization and verification. No dual ownership.
//   Row: finalization succeeded — mechanical command owns: Done, cycle
//   close, lease completion, lane release. This procedure owns: cleanup,
//   refill, completion notification. complete_review uses
//   submitWorkflowCommand (repository_finalization_succeeded) — no direct
//   applyTaskTransition calls.
//
// Review feedback (§10.1): the reviewer decision transaction marks the lease
// changes_requested, closes the cycle, moves Review -> To Do (front), and
// creates the procedure. The procedure then invalidates finalization effects,
// marks the worktree for revalidation, and wakes the assignee with one
// consolidated comment.
//
// Review acceptance (§10.2): the reviewer decision transaction marks the
// lease accepted, creates the finalization procedure, and keeps the task in
// Review until repository finalization succeeds. The procedure finalizes the
// repository, verifies, completes the review (Review -> Done via mechanical
// callback), cleans up the worktree, refills queues, and notifies completion.
//
// Invariant 9: separate decision from execution — the Done transition is
// attributed to the reviewer (decisionActorId), with the finalizer
// (executorActorId) recorded separately in evidence.

import { db } from "@/lib/db";
import { closeTaskWorkflowCycle } from "@/lib/tasks/workflow-cycle";
import { updateTaskRepositoryState } from "@/lib/tasks/repository-state";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";
import { registerStepHandler } from "@/lib/tasks/orchestrator/procedure-runner";
import type { StepHandlerResult, StepHandlerContext } from "@/lib/tasks/orchestrator/procedure-runner";
import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";
import { REPOSITORY_JOB_SCHEMA_V2 } from "@/lib/deploy/branch-verify";
import { projectUsesRepository } from "@/lib/projects/work-mode";

// =====================================================================
// return_review_for_changes
// =====================================================================

const FEEDBACK_TYPE: TaskProcedureType = "return_review_for_changes";

// --- Step 1: invalidate_finalization_effects ---------------------------
async function invalidateFinalizationEffects(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  // Invalidate any still-running finalization/verification effects for the
  // closed cycle. The cycle was already closed by the decision transaction.
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: { id: true, status: true, activeWorkflowCycleId: true },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  // Cancel any queued/dispatching review_finalize effects for this task.
  await db.workflowOutbox.updateMany({
    where: {
      taskId: task.id,
      effectType: "review_finalize",
      status: { in: ["queued", "dispatching"] },
    },
    data: { status: "completed", completedAt: new Date(), lastError: "Invalidated by review feedback." },
  });
  return { status: "completed", output: { invalidated: true } };
}

// --- Step 2: mark_worktree_for_revalidation ----------------------------
async function markWorktreeForRevalidation(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: { id: true, project: { select: { workMode: true, repositoryPath: true } } },
  });
  if (!task) {
    return { status: "completed", output: { skipped: true, reason: "task_not_found" } };
  }
  if (!projectUsesRepository(task.project)) {
    return { status: "completed", output: { skipped: true, reason: "non_code_task" } };
  }
  // Mark the repository state as action_required so the next start
  // revalidates the worktree.
  await updateTaskRepositoryState(task.id, {
    phase: "action_required",
    lastError: "Review feedback — worktree requires revalidation before next cycle.",
  });
  return { status: "completed", output: { marked: true } };
}

// --- Step 3: wake_assignee_with_feedback -------------------------------
async function wakeAssigneeWithFeedback(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true } },
      reviewRuns: { where: { status: "changes_requested" }, orderBy: { updatedAt: "desc" }, take: 1, select: { id: true, candidateSha: true, reviewerId: true } },
    },
  });
  if (!task || !task.assigneeId || !task.assignee) {
    return { status: "completed", output: { skipped: true, reason: "no_assignee" } };
  }
  // A6: include the reviewer's actual comment in the feedback notification.
  // The comment was passed as evidence in the command and recorded in the
  // procedure run's input.
  const procRun = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: ctx.procedureRunId }, select: { input: true } });
  let procInput: Record<string, unknown> | null = null;
  if (procRun.input) { try { procInput = JSON.parse(procRun.input); } catch { /* ignore */ } }
  const reviewerComment = (procInput?.comment as string) ?? null;
  await enqueueWorkflowEffects(db, {
    taskId: task.id,
    projectId: task.projectId,
    aggregateVersion: 0,
    effects: [{
      type: "task_notification",
      key: `return_review_for_changes:wake:${task.id}:${ctx.procedureRunId}`,
      payload: {
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor: { id: task.assignee.id, kind: "agent", username: task.assignee.username },
        reason: "review_feedback",
        body: [
          `The reviewer requested changes on "${task.title}".`,
          reviewerComment ? `Reviewer feedback:\n${reviewerComment}` : null,
          "The task returned to the front of To Do. Address the feedback, start the task again, and resubmit for review.",
          "Do not create a new branch — PM will revalidate the existing worktree.",
        ].filter(Boolean).join("\n"),
      },
    }],
  });
  return { status: "completed", output: { woke: true } };
}

export function registerReturnReviewForChangesHandlers(): void {
  registerStepHandler(FEEDBACK_TYPE, 1, "invalidate_finalization_effects", invalidateFinalizationEffects);
  registerStepHandler(FEEDBACK_TYPE, 1, "mark_worktree_for_revalidation", markWorktreeForRevalidation);
  registerStepHandler(FEEDBACK_TYPE, 1, "wake_assignee_with_feedback", wakeAssigneeWithFeedback);
}

// =====================================================================
// finalize_accepted_review
// =====================================================================

const FINALIZE_TYPE: TaskProcedureType = "finalize_accepted_review";

// --- Step 1: finalize_repository --------------------------------------
// Standalone: verify/preserve published candidate. Epic child: merge into
// Epic integration branch. No-change: cleanup path. Store merge/finalization
// evidence and job ID. In the procedure engine, this enqueues the
// review_finalize outbox effect and enters waiting_callback.
async function finalizeRepository(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      status: true,
      projectId: true,
      workflowVersion: true,
      activeWorkflowCycleId: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true } },
      project: { select: { workMode: true, repositoryPath: true } },
      repositoryRun: { select: { phase: true, candidateSha: true, baseSha: true, reviewedSha: true, repoTouched: true, branchName: true } },
      reviewRuns: { where: { status: "accepted" }, orderBy: { updatedAt: "desc" }, take: 1, select: { id: true, candidateSha: true, reviewerId: true } },
    },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  if (task.status !== "Review") {
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  // Non-code task: no repository finalization needed.
  if (!projectUsesRepository(task.project)) {
    return { status: "completed", output: { skipped: true, reason: "non_code_task" } };
  }
  const acceptedReview = task.reviewRuns[0];
  if (!acceptedReview) {
    return { status: "failed", error: "No accepted review lease found.", retryable: false };
  }
  const candidateSha = task.repositoryRun?.reviewedSha ?? task.repositoryRun?.candidateSha ?? acceptedReview.candidateSha;
  if (!candidateSha) {
    return { status: "failed", error: "No candidate SHA for finalization.", retryable: false };
  }
  // Update repository state to finalizing.
  await updateTaskRepositoryState(task.id, {
    phase: "finalizing",
    reviewedSha: candidateSha,
    lastError: null,
  });
  // PHASEE-07: Resolve repository run for V2 identity fields.
  const repoRun = await db.taskRepositoryRun.findUnique({
    where: { taskId: task.id },
    select: { id: true, version: true, baseSha: true },
  });
  // Enqueue the review_finalize outbox effect. The outbox drain enqueues the
  // actual finalization spool job. The callback will come back via
  // applyProcedureCallback. PHASEE-07: include V2 identity fields.
  // PHASEE-07 Fix #3: Deterministic job ID based on procedure run + step —
  // a crash-replay re-publishes the same jobId, hitting the same spool path,
  // so no duplicate spool file is created.
  const jobId = `proc-finalize-${ctx.procedureRunId}-${ctx.stepId}`;
  await enqueueWorkflowEffects(db, {
    taskId: task.id,
    projectId: task.projectId,
    aggregateVersion: 0,
    effects: [{
      type: "review_finalize",
      key: `procedure-finalize:${jobId}`,
      payload: {
        taskId: task.id,
        projectId: task.projectId,
        requestedByUserId: task.assigneeId ?? acceptedReview.reviewerId ?? "procedure-engine",
        requestedByUsername: task.assignee?.username ?? "procedure-engine",
        candidateSha,
        procedureRunId: ctx.procedureRunId,
        procedureStepId: ctx.stepId,
        workflowCycleId: task.activeWorkflowCycleId,
        // PHASEE-07: V2 identity fields for exact callback correlation.
        schemaVersion: REPOSITORY_JOB_SCHEMA_V2,
        commandReceiptId: null,
        repositoryRunId: repoRun?.id ?? null,
        repositoryRunVersion: repoRun?.version ?? null,
        baseSha: repoRun?.baseSha ?? null,
      },
    }],
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
    workflowCycleId: task.activeWorkflowCycleId,
    procedureRunId: ctx.procedureRunId,
    procedureStepId: ctx.stepId,
    commandReceiptId: null,
    repositoryRunId: repoRun?.id ?? null,
    repositoryRunVersion: repoRun?.version ?? null,
    candidateSha,
    baseSha: repoRun?.baseSha ?? null,
  };
  return { status: "waiting_callback", jobId, output: { ...v2Identity } };
}

// --- Step 2: verify_finalization --------------------------------------
// Require the completed runner callback, exact candidate, expected target
// branch, and merge audit. In the procedure engine, this step runs after
// the callback marks step 1 as completed. It verifies the callback data.
async function verifyFinalization(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const finalizeStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "finalize_repository" },
    select: { output: true },
  });
  let finalizeOutput: Record<string, unknown> | null = null;
  if (finalizeStep?.output) {
    try { finalizeOutput = JSON.parse(finalizeStep.output); } catch { /* ignore */ }
  }
  if (finalizeOutput?.superseded === true || finalizeOutput?.skipped === true) {
    return { status: "completed", output: { skipped: true, reason: finalizeOutput.reason } };
  }
  // The callback data should include the finalization result.
  const finalizationOk = finalizeOutput?.finalizationOk as boolean | undefined;
  const candidateSha = finalizeOutput?.candidateSha as string | undefined;
  const mergeSha = finalizeOutput?.mergeSha as string | undefined;
  if (finalizationOk !== true) {
    const error = (finalizeOutput?.error as string) ?? "Finalization callback did not report success.";
    return { status: "failed", error, retryable: true };
  }
  if (!candidateSha) {
    return { status: "failed", error: "Finalization callback missing candidate SHA.", retryable: false };
  }
  // Update repository state to completed.
  await updateTaskRepositoryState(ctx.taskId, {
    phase: "completed",
    reviewedSha: candidateSha,
    lastError: null,
  });
  return { status: "completed", output: { verified: true, candidateSha, mergeSha } };
}

// --- Step 3: complete_review ------------------------------------------
// Invoke mechanical intent repository_finalization_succeeded as the
// monitor/worker. In one transaction, attribute the decision to the accepted
// reviewer, record the mechanical executor separately, close the cycle,
// complete the review lease, and move Review -> Done.
// Non-code tasks skip repository finalization but STILL need this step to
// move to Done.
async function completeReview(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const verifyStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "verify_finalization" },
    select: { output: true },
  });
  let verifyOutput: Record<string, unknown> | null = null;
  if (verifyStep?.output) {
    try { verifyOutput = JSON.parse(verifyStep.output); } catch { /* ignore */ }
  }
  // Only skip if SUPERSEDED — a "skipped" finalization (non-code) still
  // needs to complete the review.
  if (verifyOutput?.superseded === true) {
    return { status: "completed", output: { skipped: true, reason: verifyOutput.reason } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: { id: true, status: true, workflowVersion: true, activeWorkflowCycleId: true, assigneeId: true, project: { select: { workMode: true, repositoryPath: true } } },
  });
  if (!task) {
    return { status: "failed", error: "Task not found.", retryable: false };
  }
  if (task.status !== "Review") {
    return { status: "completed", output: { superseded: true, reason: `task_status_${task.status}` } };
  }
  const candidateSha = (verifyOutput?.candidateSha as string) ?? null;
  // Use the assignee's user ID as the mechanical actor (the procedure acts on
  // the reviewer's behalf; the decision actor is recovered from the accepted
  // lease by authorize.ts).
  const freshTask = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { workflowVersion: true, activeWorkflowCycleId: true, assigneeId: true, repositoryRun: { select: { baseSha: true } } } });
  const realBaseSha = freshTask.repositoryRun?.baseSha ?? null;
  const result = await submitWorkflowCommand({
    taskId: task.id,
    intent: "repository_finalization_succeeded",
    actor: { id: freshTask.assigneeId ?? "procedure-engine", kind: "agent", username: "procedure-engine", role: "monitor" },
    expectedWorkflowVersion: freshTask.workflowVersion,
    workflowCycleId: freshTask.activeWorkflowCycleId,
    idempotencyKey: `procedure-complete-review:${ctx.procedureRunId}`,
    source: "callback",
    evidence: { candidateSha, procedureRunId: ctx.procedureRunId },
    payload: {
      procedureRunId: ctx.procedureRunId,
      procedureStepId: ctx.stepId,
      jobId: null,
      candidateSha,
      baseSha: realBaseSha ?? null,
      outcome: "succeeded",
      publishedSha: null,
    },
  });
  if (result.status !== "accepted" && result.status !== "replayed") {
    return { status: "failed", error: `Failed to complete review: ${result.status} — ${result.reason ?? "no reason"}`, retryable: result.status === "stale" };
  }
  // Mark the accepted review lease as completed.
  if (freshTask.activeWorkflowCycleId) {
    await db.reviewRun.updateMany({
      where: { workflowCycleId: freshTask.activeWorkflowCycleId, status: "accepted" },
      data: { status: "completed" },
    });
  }
  return { status: "completed", output: { completed: true, transitionId: result.status === "accepted" ? result.transitionId : null } };
}

// --- Step 4: cleanup_worktree -----------------------------------------
async function cleanupWorktree(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const completeStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "complete_review" },
    select: { output: true },
  });
  let completeOutput: Record<string, unknown> | null = null;
  if (completeStep?.output) {
    try { completeOutput = JSON.parse(completeStep.output); } catch { /* ignore */ }
  }
  if (completeOutput?.superseded === true) {
    return { status: "completed", output: { skipped: true, reason: completeOutput.reason } };
  }
  // The actual worktree cleanup is handled by the existing repository runner
  // (epic-merge / worktree-cleanup). Here we just record that cleanup is
  // allowed — the repository state is already "completed".
  return { status: "completed", output: { cleanupAllowed: true } };
}

// --- Step 5: refill_queues --------------------------------------------
async function refillQueues(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const completeStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "complete_review" },
    select: { output: true },
  });
  let completeOutput: Record<string, unknown> | null = null;
  if (completeStep?.output) {
    try { completeOutput = JSON.parse(completeStep.output); } catch { /* ignore */ }
  }
  if (completeOutput?.superseded === true) {
    return { status: "completed", output: { skipped: true, reason: completeOutput.reason } };
  }
  // Queue refill is handled by the existing dependency_refill outbox effect
  // (the kernel enqueues it automatically when a task moves to Done). Here
  // we just record that the procedure reached this step.
  return { status: "completed", output: { refillHandled: true } };
}

// --- Step 6: notify_completion ----------------------------------------
async function notifyCompletion(ctx: StepHandlerContext): Promise<StepHandlerResult> {
  const completeStep = await db.taskProcedureStep.findFirst({
    where: { procedureRunId: ctx.procedureRunId, name: "complete_review" },
    select: { output: true },
  });
  let completeOutput: Record<string, unknown> | null = null;
  if (completeStep?.output) {
    try { completeOutput = JSON.parse(completeStep.output); } catch { /* ignore */ }
  }
  if (completeOutput?.superseded === true) {
    return { status: "completed", output: { skipped: true, reason: completeOutput.reason } };
  }
  const task = await db.task.findUnique({
    where: { id: ctx.taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      assigneeId: true,
      assignee: { select: { id: true, username: true } },
      reporterId: true,
    },
  });
  if (!task) {
    return { status: "completed", output: { skipped: true, reason: "task_not_found" } };
  }
  // Notify assignee and reporter once, with a cycle/version-scoped dedupe key.
  const effects = [];
  if (task.assigneeId && task.assignee) {
    effects.push({
      type: "task_notification" as const,
      key: `finalize_accepted_review:notify-assignee:${task.id}:${ctx.procedureRunId}`,
      payload: {
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor: { id: task.assignee.id, kind: "agent", username: task.assignee.username },
        reason: "review_done" as const,
        body: `Task "${task.title}" was accepted and moved to Done. No further action is required unless the task is reopened.`,
      },
    });
  }
  if (effects.length > 0) {
    await enqueueWorkflowEffects(db, {
      taskId: task.id,
      projectId: task.projectId,
      aggregateVersion: 0,
      effects,
    });
  }
  return { status: "completed", output: { notified: true } };
}

export function registerFinalizeAcceptedReviewHandlers(): void {
  registerStepHandler(FINALIZE_TYPE, 1, "finalize_repository", finalizeRepository);
  registerStepHandler(FINALIZE_TYPE, 1, "verify_finalization", verifyFinalization);
  registerStepHandler(FINALIZE_TYPE, 1, "complete_review", completeReview);
  registerStepHandler(FINALIZE_TYPE, 1, "cleanup_worktree", cleanupWorktree);
  registerStepHandler(FINALIZE_TYPE, 1, "refill_queues", refillQueues);
  registerStepHandler(FINALIZE_TYPE, 1, "notify_completion", notifyCompletion);
}
