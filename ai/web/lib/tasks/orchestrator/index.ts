// ORCH-02 — Canonical workflow orchestrator entry point.
//
// Routes translate UI/API/agent actions into a TaskWorkflowCommand and call
// `submitWorkflowCommand`. The orchestrator:
//   1. Loads the TaskStateSnapshot.
//   2. Authorizes the command (authorize.ts).
//   3. Runs pure guards (guards.ts).
//   4. Computes the pure decision (decide.ts).
//   5. Executes the decision atomically (execute.ts).
//
// Returns an OrchestratorResult. Routes map the result to HTTP status codes
// per §5.5:
//   200 replayed, 202 accepted, 409 stale/conflict, 403 forbidden,
//   422 invalid, 503 operational.

import { db } from "@/lib/db";
import { authorizeCommand } from "@/lib/tasks/orchestrator/authorize";
import { runGuards } from "@/lib/tasks/orchestrator/guards";
import { decideCommand } from "@/lib/tasks/orchestrator/decide";
import { executeWorkflowCommand } from "@/lib/tasks/orchestrator/execute";
import { resolveReviewOwnerIdFromSnapshot } from "@/lib/tasks/orchestrator/authorize";
import type {
  OrchestrationDecision,
  OrchestratorResult,
  TaskStateSnapshot,
  TaskWorkflowCommand,
} from "@/lib/tasks/orchestrator/types";

/**
 * Build a TaskStateSnapshot from the DB for the decision function. The
 * snapshot is a frozen view of the task's current state; the decision
 * function is pure and does not touch the DB.
 */
export async function loadTaskStateSnapshot(taskId: string): Promise<TaskStateSnapshot | null> {
  const task = await db.task.findUnique({
    where: { id: taskId, deletedAt: null },
    select: {
      id: true,
      status: true,
      workflowVersion: true,
      projectId: true,
      epicId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      approvedById: true,
      activeWorkflowCycleId: true,
      project: {
        select: {
          onlyReportersCanApproveActionPlans: true,
          onlyReportersCanSetTasksDone: true,
          repositoryPath: true,
        },
      },
      epic: { select: { status: true, actingManagerId: true } },
      repositoryRun: {
        select: {
          phase: true,
          candidateSha: true,
          baseSha: true,
          repoTouched: true,
          reviewedSha: true,
        },
      },
    },
  });
  if (!task) return null;

  const reviewRun = task.activeWorkflowCycleId
    ? await db.reviewRun.findUnique({
        where: { workflowCycleId: task.activeWorkflowCycleId },
        select: { id: true, status: true, candidateSha: true, reviewerId: true },
      })
    : null;

  return {
    id: task.id,
    status: task.status as TaskStateSnapshot["status"],
    workflowVersion: task.workflowVersion,
    projectId: task.projectId,
    epicId: task.epicId,
    assigneeId: task.assigneeId,
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    approvedOn: task.approvedOn,
    approvedById: task.approvedById,
    activeWorkflowCycleId: task.activeWorkflowCycleId,
    resolvedReviewOwnerId: resolveReviewOwnerIdFromSnapshot({
      actingManagerId: task.actingManagerId,
      reporterId: task.reporterId,
      epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
    }),
    activeReviewRun: reviewRun
      ? { id: reviewRun.id, status: reviewRun.status, candidateSha: reviewRun.candidateSha, reviewerId: reviewRun.reviewerId }
      : null,
    repositoryRun: task.repositoryRun
      ? {
          phase: task.repositoryRun.phase,
          candidateSha: task.repositoryRun.candidateSha,
          baseSha: task.repositoryRun.baseSha,
          repoTouched: task.repositoryRun.repoTouched,
          reviewedSha: task.repositoryRun.reviewedSha,
        }
      : null,
    project: {
      onlyReportersCanApproveActionPlans: task.project.onlyReportersCanApproveActionPlans,
      onlyReportersCanSetTasksDone: task.project.onlyReportersCanSetTasksDone,
      repositoryPath: task.project.repositoryPath,
    },
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
  };
}

/**
 * Submit a workflow command to the orchestrator. The single entry point for
 * every workflow mutation. Returns an OrchestratorResult.
 */
export async function submitWorkflowCommand(command: TaskWorkflowCommand): Promise<OrchestratorResult> {
  const state = await loadTaskStateSnapshot(command.taskId);
  if (!state) {
    return { status: "invalid", reason: "Task not found." };
  }

  // --- Idempotency replay check (before guards, per kernel semantics) ----
  // The transition kernel deduplicates by idempotencyKey. A replay of the
  // same command returns the original transition without side effects, even
  // if the workflow version has since moved on. We check here so the guard's
  // version check doesn't reject a legitimate replay.
  const existingTransition = await db.workflowTransition.findUnique({
    where: {
      taskId_idempotencyKey: {
        taskId: command.taskId,
        idempotencyKey: command.idempotencyKey,
      },
    },
    select: { id: true, workflowVersion: true },
  });
  if (existingTransition) {
    return { status: "replayed", transitionId: existingTransition.id, workflowVersion: existingTransition.workflowVersion, procedureId: null };
  }
  // For no-op decisions (accept_review, checkpoint, etc.) that don't create a
  // kernel transition, check for an existing activity log with the same
  // idempotency key. This makes no-op decisions replay-safe too.
  const existingActivity = await db.activityLog.findFirst({
    where: {
      taskId: command.taskId,
      kind: { startsWith: "task.workflow." },
      payload: { contains: command.idempotencyKey },
    },
    select: { id: true },
  });
  if (existingActivity) {
    return { status: "replayed", transitionId: existingActivity.id, workflowVersion: state.workflowVersion, procedureId: null };
  }

  // --- Authorize ---------------------------------------------------------
  const auth = authorizeCommand(state, command);
  if (!auth.allowed) {
    return { status: "forbidden", reason: auth.reason };
  }

  // --- Guards (pure preconditions) --------------------------------------
  const guardResult = runGuards(state, command);
  if (!guardResult.ok) {
    return guardResult.status === "stale"
      ? { status: "stale", reason: guardResult.reason }
      : { status: "invalid", reason: guardResult.reason };
  }

  // --- Decide (pure) -----------------------------------------------------
  const decision = decideCommand(state, command, auth);
  if ("status" in decision && decision.status === "invalid") {
    return { status: "invalid", reason: decision.reason };
  }
  const orchestrationDecision = decision as OrchestrationDecision;

  // --- Execute (atomic) --------------------------------------------------
  return executeWorkflowCommand(command, orchestrationDecision);
}

// Re-export the public API so routes can import from a single module.
export { authorizeCommand } from "@/lib/tasks/orchestrator/authorize";
export { runGuards } from "@/lib/tasks/orchestrator/guards";
export { decideCommand } from "@/lib/tasks/orchestrator/decide";
export { executeWorkflowCommand } from "@/lib/tasks/orchestrator/execute";
export { buildTaskWorkflowProjection } from "@/lib/tasks/orchestrator/projection";
export { loadTaskStateSnapshot as loadTaskState };
export type { TaskWorkflowCommand, OrchestratorResult, OrchestrationDecision, TaskStateSnapshot };