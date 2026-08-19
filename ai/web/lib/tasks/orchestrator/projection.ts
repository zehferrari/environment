// ORCH-02 — Task shell/procedure status projection for UI and agents.
//
// Serializes the current workflow state — status, cycle, active procedure,
// resolved reviewer, allowed next intents, operational-error state — for the
// task detail UI and the agent context builder. The projection is read-only;
// it never mutates state.
//
// This is the single shape agents and humans see. Agent prompts (ORCH-09) and
// the task Execution/Activity UI both consume it.

import { db } from "@/lib/db";
import {
  TASK_WORKFLOW_INTENTS,
  type TaskWorkflowIntent,
} from "@/lib/tasks/orchestrator/types";
import {
  resolveReviewOwnerId,
} from "@/lib/tasks/workflow-actors";
import { getActiveTaskWorkflowCycle } from "@/lib/tasks/workflow-cycle";
import type { TaskStateSnapshot } from "@/lib/tasks/orchestrator/types";

export type TaskWorkflowProjection = {
  taskId: string;
  status: string;
  workflowVersion: number;
  activeCycle: {
    id: string;
    sequence: number;
    status: string;
    outcome: string | null;
    candidateSha: string | null;
    baseSha: string | null;
  } | null;
  resolvedReviewerId: string | null;
  activeReviewLease: {
    id: string;
    status: string;
    candidateSha: string;
    reviewerId: string | null;
  } | null;
  activeProcedure: {
    type: string;
    status: string;
    currentStep: string | null;
  } | null;
  // The next intents the current viewer/actor is allowed to submit. Computed
  // from the task status + cycle state; the actual authorization check runs
  // at command time, but this list guides the UI/agent prompt.
  allowedIntents: TaskWorkflowIntent[];
  operationalError: string | null;
};

/**
 * Build the workflow projection for a task. Reads only.
 */
export async function buildTaskWorkflowProjection(taskId: string): Promise<TaskWorkflowProjection | null> {
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
          lastError: true,
        },
      },
    },
  });
  if (!task) return null;

  const activeCycle = await getActiveTaskWorkflowCycle(taskId);
  const reviewRun = activeCycle
    ? await db.reviewRun.findUnique({
        where: { workflowCycleId: activeCycle.id },
        select: { id: true, status: true, candidateSha: true, reviewerId: true, baseSha: true, repoTouched: true, validationOutcome: true },
      })
    : null;

  // Find the active procedure run for this task (most recent non-completed).
  const activeProcedureRun = await db.taskProcedureRun.findFirst({
    where: {
      taskId,
      status: { in: ["queued", "running", "operational_error"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, status: true, currentStep: true },
  });

  const snapshot: TaskStateSnapshot = {
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
    resolvedReviewOwnerId: resolveReviewOwnerId({
      actingManagerId: task.actingManagerId,
      reporterId: task.reporterId,
      epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
    }),
    activeReviewRun: reviewRun
      ? { id: reviewRun.id, status: reviewRun.status, candidateSha: reviewRun.candidateSha, reviewerId: reviewRun.reviewerId, baseSha: reviewRun.baseSha, repoTouched: reviewRun.repoTouched, validationOutcome: reviewRun.validationOutcome }
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

  const operationalError =
    task.repositoryRun?.phase === "operational_error" ? task.repositoryRun.lastError : null;

  return {
    taskId: task.id,
    status: task.status,
    workflowVersion: task.workflowVersion,
    activeCycle: activeCycle
      ? {
          id: activeCycle.id,
          sequence: activeCycle.sequence,
          status: activeCycle.status,
          outcome: activeCycle.outcome,
          candidateSha: activeCycle.candidateSha,
          baseSha: activeCycle.baseSha,
        }
      : null,
    resolvedReviewerId: snapshot.resolvedReviewOwnerId,
    activeReviewLease: reviewRun
      ? {
          id: reviewRun.id,
          status: reviewRun.status,
          candidateSha: reviewRun.candidateSha,
          reviewerId: reviewRun.reviewerId,
        }
      : null,
    activeProcedure: activeProcedureRun
      ? {
          type: activeProcedureRun.type,
          status: activeProcedureRun.status,
          currentStep: activeProcedureRun.currentStep,
        }
      : null,
    allowedIntents: computeAllowedIntents(snapshot),
    operationalError,
  };
}

/**
 * Compute the set of intents that are structurally allowed for the task's
 * current state. This is a UI/prompt hint; the actual authorization check
// runs at command time. An intent appears here if its guards would pass
// (status + cycle + lease preconditions), regardless of actor identity.
 */
export function computeAllowedIntents(state: TaskStateSnapshot): TaskWorkflowIntent[] {
  const allowed: TaskWorkflowIntent[] = [];
  const status = state.status;
  const hasActiveCycle = Boolean(state.activeWorkflowCycleId);
  const hasAwaitingLease = state.activeReviewRun?.status === "awaiting_review";

  if (status === "Backlog" || status === "To Do") {
    if (!state.approvedOn) {
      allowed.push("submit_plan", "approve_plan", "request_plan_changes");
    } else {
      allowed.push("start_implementation");
    }
  }
  if (status === "To Do" && !hasActiveCycle && state.approvedOn) {
    allowed.push("start_implementation");
  }
  if (status === "In Progress" && hasActiveCycle) {
    allowed.push("checkpoint", "submit_for_review", "raise_blocker", "clear_blocker");
  }
  if (status === "Review" && hasActiveCycle) {
    if (hasAwaitingLease) {
      allowed.push("accept_review", "request_review_changes");
    }
    allowed.push("repository_finalization_succeeded", "repository_finalization_failed");
  }
  if (status === "Done") {
    allowed.push("archive_task");
  }
  // Cancel is allowed from most non-Done statuses.
  if (status !== "Done") {
    allowed.push("cancel_task");
  }
  // Dedupe while preserving order.
  return Array.from(new Set(allowed));
}

export { TASK_WORKFLOW_INTENTS };