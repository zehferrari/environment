// ORCH-02 — Authorization for workflow commands.
//
// Single source of truth for "who may decide what". Every transport (agent
// workflow API, human UI, drag/drop, bulk edit, work-item proposal,
// monitor/repository callbacks, workflow doctor) calls the same functions.
//
// This module extends lib/tasks/workflow-actors.ts (the existing
// reporter/reviewer/acting-manager resolver) with the orchestrator's typed
// intent vocabulary. The existing functions remain the canonical resolver;
// this module maps intents onto them and adds the mechanical-callback
// distinction (invariant 9: separate decision from execution).
//
// Invariants enforced:
//   8. Immutable review decision — only the resolved reviewer (or reporter
//      under policy) may accept/request changes, and only against the active
//      immutable review lease.
//   9. Separate decision from execution — mechanical intents require a
//      monitor/worker actor, not a reviewer.
//  10. No inferred decisions — authorization is a function of (task, actor,
//      lease); it never infers consent from comments or API success.

import {
  canApproveActionPlanForActor,
  canSetTaskDoneForActor,
  isActionableEpicStatus,
  resolveReviewOwnerId,
} from "@/lib/tasks/workflow-actors";
import type {
  TaskStateSnapshot,
  TaskWorkflowIntent,
  WorkflowActor,
} from "@/lib/tasks/orchestrator/types";
import { isMechanicalIntent } from "@/lib/tasks/orchestrator/types";

export type AuthorizationReason =
  | "not_assignee"
  | "not_reviewer"
  | "not_reporter"
  | "not_monitor"
  | "not_authorized_for_plan"
  | "not_authorized_for_done"
  | "monitor_cannot_decide"
  | "lease_not_owned"
  | "no_active_lease"
  | "ok";

export type AuthorizationResult = {
  allowed: boolean;
  reason: AuthorizationReason;
  // The resolved decision actor for this command. For mechanical intents,
  // this is the reviewer who authorized the underlying decision (recovered
  // from the review lease); for human/agent decisions, it is the actor
  // themselves.
  decisionActorId: string | null;
  // The mechanical executor (monitor/worker). Null for human/agent decisions.
  executorActorId: string | null;
};

// Re-export the existing resolver so callers can reach it through the
// orchestrator boundary without importing workflow-actors directly.
export {
  canApproveActionPlanForActor,
  canSetTaskDoneForActor,
  isActionableEpicStatus,
  resolveReviewOwnerId,
};

// Required functions from §11 (centralize authorization and role resolution).
// These wrap the existing resolver with the orchestrator's typed shapes.
export function resolvePlanOwnerId(task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic">): string | null {
  return resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
  });
}

export function resolveReviewOwnerIdFromSnapshot(task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic">): string | null {
  return resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
  });
}

export function resolveDoneOwnerId(task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic" | "project">): string | null {
  if (task.project.onlyReportersCanSetTasksDone) return task.reporterId;
  return resolveReviewOwnerIdFromSnapshot(task);
}

export function canApprovePlan(task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic" | "project">, actorId: string): boolean {
  return canApproveActionPlanForActor(
    {
      actingManagerId: task.actingManagerId,
      reporterId: task.reporterId,
      project: task.project,
      epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
    },
    actorId,
  );
}

export function canSubmitImplementationIntent(task: Pick<TaskStateSnapshot, "assigneeId">, actorId: string): boolean {
  return task.assigneeId === actorId;
}

export function canRequestReviewChanges(
  task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic" | "project">,
  actorId: string,
  reviewLease: { status: string; reviewerId: string | null } | null,
): boolean {
  // Invariant 8: only the resolved reviewer (or reporter under policy) may
  // request changes, and only against the active immutable lease.
  if (!reviewLease || reviewLease.status !== "awaiting_review") return false;
  const resolved = resolveReviewOwnerIdFromSnapshot(task);
  return actorId === resolved;
}

export function canAcceptReview(
  task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic" | "project">,
  actorId: string,
  reviewLease: { status: string; reviewerId: string | null } | null,
): boolean {
  if (!reviewLease || reviewLease.status !== "awaiting_review") return false;
  // Done is a review decision — use the same Done-owner set.
  return canSetTaskDoneForActor(
    {
      actingManagerId: task.actingManagerId,
      reporterId: task.reporterId,
      project: task.project,
      epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId } : null,
    },
    actorId,
  );
}

export function canExecuteMechanicalCallback(actor: WorkflowActor, intent: TaskWorkflowIntent): boolean {
  if (!isMechanicalIntent(intent)) return false;
  // Only monitor-role actors may execute mechanical callbacks. The actor's
  // role is set by the transport from the Agent registry / callback auth.
  return actor.role === "monitor" || actor.role === "admin";
}

// --- Main authorization entry point ---------------------------------------
export function authorizeCommand(
  state: TaskStateSnapshot,
  command: { intent: TaskWorkflowIntent; actor: WorkflowActor },
): AuthorizationResult {
  const { intent, actor } = command;

  // Mechanical intents: only monitor/admin may execute, and the decision
  // actor is recovered from the underlying review lease (not the monitor).
  if (isMechanicalIntent(intent)) {
    if (!canExecuteMechanicalCallback(actor, intent)) {
      return { allowed: false, reason: "not_monitor", decisionActorId: null, executorActorId: actor.id };
    }
    // For finalization callbacks, the decision actor is the accepted reviewer.
    // For validation callbacks, there is no review decision yet — the
    // assignee/PM owns the implementation turn.
    if (intent === "repository_finalization_succeeded" || intent === "repository_finalization_failed") {
      const lease = state.activeReviewRun;
      if (!lease || lease.status !== "accepted" || !lease.reviewerId) {
        return { allowed: false, reason: "no_active_lease", decisionActorId: null, executorActorId: actor.id };
      }
      return { allowed: true, reason: "ok", decisionActorId: lease.reviewerId, executorActorId: actor.id };
    }
    // validation_succeeded / validation_failed: no reviewer decision needed.
    return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: actor.id };
  }

  // Human/agent decisions: monitor may NOT decide.
  if (actor.role === "monitor") {
    return { allowed: false, reason: "monitor_cannot_decide", decisionActorId: null, executorActorId: null };
  }

  switch (intent) {
    case "submit_plan":
    case "checkpoint":
    case "submit_for_review":
    case "start_implementation":
      if (!canSubmitImplementationIntent(state, actor.id)) {
        return { allowed: false, reason: "not_assignee", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };

    case "approve_plan":
    case "request_plan_changes":
      if (!canApprovePlan(state, actor.id)) {
        return { allowed: false, reason: "not_authorized_for_plan", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };

    case "request_review_changes":
      if (!canRequestReviewChanges(state, actor.id, state.activeReviewRun ?? null)) {
        return { allowed: false, reason: "not_reviewer", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };

    case "accept_review":
      if (!canAcceptReview(state, actor.id, state.activeReviewRun ?? null)) {
        return { allowed: false, reason: "not_authorized_for_done", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };

    case "raise_blocker":
    case "clear_blocker":
      // Blocker intents are assignee-owned (the assignee reports blockers).
      if (!canSubmitImplementationIntent(state, actor.id)) {
        return { allowed: false, reason: "not_assignee", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };

    case "cancel_task":
    case "archive_task":
      // Cancel/archive are reporter-or-acting-manager decisions.
      if (actor.id !== state.reporterId && actor.id !== state.actingManagerId && actor.role !== "admin") {
        return { allowed: false, reason: "not_authorized_for_plan", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };

    default:
      return { allowed: false, reason: "not_authorized_for_plan", decisionActorId: null, executorActorId: null };
  }
}