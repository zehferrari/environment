// PHASEE-03 — Authorization for workflow commands.
//
// Single source of truth for "who may decide what". Every transport (agent
// workflow API, human UI, drag/drop, bulk edit, work-item proposal,
// monitor/repository callbacks, workflow doctor) calls the same functions.
//
// This module is a thin typed adapter over lib/tasks/workflow-actors.ts (the
// canonical reporter/reviewer/acting-manager resolver). PHASEE-03 removed the
// parallel snapshot-shaped resolver copies that previously lived here; all
// authority resolution now flows through workflow-actors.ts as the single
// canonical implementation.
//
// authorizeCommand is a PURE SYNCHRONOUS function of (TaskStateSnapshot,
// {intent, actor}). It performs no DB reads. Actor role and coding capability
// are resolved upstream (at aggregate load or authenticated-context
// construction) and carried on WorkflowActor, preserving the purity that
// runGuards/decide depend on.
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
  | "not_coding_capable"
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

// Re-export the canonical resolvers so callers can reach them through the
// orchestrator boundary without importing workflow-actors directly.
export {
  canApproveActionPlanForActor,
  canSetTaskDoneForActor,
  isActionableEpicStatus,
  resolveReviewOwnerId,
};

// ---------------------------------------------------------------------------
// Adapter helpers — thin typed wrappers over workflow-actors.ts canonical
// resolvers. These accept TaskStateSnapshot shapes and delegate to the
// single canonical implementation in workflow-actors.ts.
//
// PHASEE-03 constraint #3 from barekbaal: "Land on one canonical implementation
// with the orchestrator layer as a thin typed adapter." These adapters replace
// the former parallel snapshot-shaped copies (resolvePlanOwnerId,
// resolveReviewOwnerIdFromSnapshot, resolveDoneOwnerId, canApprovePlan).
// ---------------------------------------------------------------------------

/**
 * Adapter: resolve the plan-approval owner from a TaskStateSnapshot.
 * Delegates to workflow-actors.resolveReviewOwnerId as the canonical resolver.
 */
export function resolvePlanOwnerIdFromSnapshot(
  task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic">,
): string | null {
  return resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic
      ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId }
      : null,
  });
}

/**
 * Adapter: resolve the Done-owner from a TaskStateSnapshot.
 * Delegates to workflow-actors.resolveDoneOwnerId as the canonical resolver.
 */
export function resolveDoneOwnerIdFromSnapshot(
  task: Pick<TaskStateSnapshot, "actingManagerId" | "reporterId" | "epic" | "project">,
): string | null {
  if (task.project.onlyReportersCanSetTasksDone) return task.reporterId;
  return resolveReviewOwnerId({
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    epic: task.epic
      ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId }
      : null,
  });
}

/**
 * Check whether the actor can submit an implementation intent (start,
 * checkpoint, submit_for_review). Requires the actor to be the assignee AND
 * have coding capability (PHASEE-03 §10.3: "actor is the assignee and has the
 * server-resolved implementation capability").
 *
 * The codingCapability flag is resolved upstream from the DB agent record
 * (agent.role === "coding") and carried on WorkflowActor, preserving
 * authorizeCommand purity. When codingCapability is undefined (transport
 * not yet wired), the function fails CLOSED: undefined is treated as
 * non-coding for start_implementation and submit_for_review. This prevents
 * a non-coding actor from bypassing the guard via an unwired transport.
 * checkpoint and submit_plan do not require coding capability.
 */
export function canSubmitImplementationIntent(
  task: Pick<TaskStateSnapshot, "assigneeId">,
  actor: WorkflowActor,
  intent?: TaskWorkflowIntent,
): boolean {
  if (task.assigneeId !== actor.id) return false;
  // Coding capability is server-resolved and carried on the actor.
  // Fail closed: undefined codingCapability is treated as non-coding
  // for intents that require it (start_implementation, submit_for_review).
  if (intent === "start_implementation" || intent === "submit_for_review") {
    if (actor.codingCapability !== true) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Mechanical callback authorization
// ---------------------------------------------------------------------------

export function canExecuteMechanicalCallback(
  actor: WorkflowActor,
  intent: TaskWorkflowIntent,
): boolean {
  if (!isMechanicalIntent(intent)) return false;
  // Only monitor-role actors (or admin) may execute mechanical callbacks.
  // The actor's role is server-resolved and carried on WorkflowActor.
  return actor.role === "monitor" || actor.role === "admin";
}

// ---------------------------------------------------------------------------
// Main authorization entry point — pure function of (state, command)
// ---------------------------------------------------------------------------

export function authorizeCommand(
  state: TaskStateSnapshot,
  command: { intent: TaskWorkflowIntent; actor: WorkflowActor },
): AuthorizationResult {
  const { intent, actor } = command;

  // Mechanical intents: only monitor/admin may execute, and the decision
  // actor is recovered from the underlying review lease (not the monitor).
  if (isMechanicalIntent(intent)) {
    if (!canExecuteMechanicalCallback(actor, intent)) {
      return {
        allowed: false,
        reason: "not_monitor",
        decisionActorId: null,
        executorActorId: actor.id,
      };
    }
    // For finalization callbacks, the decision actor is the accepted reviewer.
    if (
      intent === "repository_finalization_succeeded" ||
      intent === "repository_finalization_failed"
    ) {
      const lease = state.activeReviewRun;
      if (!lease || lease.status !== "accepted" || !lease.reviewerId) {
        return {
          allowed: false,
          reason: "no_active_lease",
          decisionActorId: null,
          executorActorId: actor.id,
        };
      }
      return {
        allowed: true,
        reason: "ok",
        decisionActorId: lease.reviewerId,
        executorActorId: actor.id,
      };
    }
    // validation_succeeded / validation_failed: no reviewer decision needed.
    return {
      allowed: true,
      reason: "ok",
      decisionActorId: actor.id,
      executorActorId: actor.id,
    };
  }

  // Human/agent decisions: monitor may NOT decide.
  if (actor.role === "monitor") {
    return {
      allowed: false,
      reason: "monitor_cannot_decide",
      decisionActorId: null,
      executorActorId: null,
    };
  }

  switch (intent) {
    case "submit_plan":
    case "checkpoint":
    case "submit_for_review":
    case "start_implementation": {
      // §10.3: start_implementation requires coding capability.
      // §10.5: submit_for_review requires coding-capable assignee.
      // checkpoint and submit_plan are assignee-owned but do not require
      // coding capability (fail-closed only applies to start/submit_for_review).
      if (!canSubmitImplementationIntent(state, actor, intent)) {
        if (state.assigneeId === actor.id && (intent === "start_implementation" || intent === "submit_for_review") && actor.codingCapability !== true) {
          return {
            allowed: false,
            reason: "not_coding_capable",
            decisionActorId: null,
            executorActorId: null,
          };
        }
        return {
          allowed: false,
          reason: "not_assignee",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      return {
        allowed: true,
        reason: "ok",
        decisionActorId: actor.id,
        executorActorId: null,
      };
    }

    case "approve_plan":
    case "request_plan_changes": {
      // Delegate to canonical workflow-actors.canApproveActionPlanForActor.
      if (
        !canApproveActionPlanForActor(
          {
            actingManagerId: state.actingManagerId,
            reporterId: state.reporterId,
            project: state.project,
            epic: state.epic
              ? {
                  status: state.epic.status,
                  actingManagerId: state.epic.actingManagerId,
                }
              : null,
          },
          actor.id,
        )
      ) {
        return {
          allowed: false,
          reason: "not_authorized_for_plan",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      return {
        allowed: true,
        reason: "ok",
        decisionActorId: actor.id,
        executorActorId: null,
      };
    }

    case "request_review_changes": {
      // Invariant 8: only the resolved reviewer (or reporter under policy)
      // may request changes, and only against the active immutable lease.
      const lease = state.activeReviewRun ?? null;
      if (!lease || lease.status !== "awaiting_review") {
        return {
          allowed: false,
          reason: "no_active_lease",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      const resolved = resolveReviewOwnerId({
        actingManagerId: state.actingManagerId,
        reporterId: state.reporterId,
        epic: state.epic
          ? {
              status: state.epic.status,
              actingManagerId: state.epic.actingManagerId,
            }
          : null,
      });
      if (actor.id !== resolved) {
        return {
          allowed: false,
          reason: "not_reviewer",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      return {
        allowed: true,
        reason: "ok",
        decisionActorId: actor.id,
        executorActorId: null,
      };
    }

    case "accept_review": {
      // Done is a review decision — use the canonical Done-owner resolver.
      const lease = state.activeReviewRun ?? null;
      if (!lease || lease.status !== "awaiting_review") {
        return {
          allowed: false,
          reason: "no_active_lease",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      if (
        !canSetTaskDoneForActor(
          {
            actingManagerId: state.actingManagerId,
            reporterId: state.reporterId,
            project: state.project,
            epic: state.epic
              ? {
                  status: state.epic.status,
                  actingManagerId: state.epic.actingManagerId,
                }
              : null,
          },
          actor.id,
        )
      ) {
        return {
          allowed: false,
          reason: "not_authorized_for_done",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      return {
        allowed: true,
        reason: "ok",
        decisionActorId: actor.id,
        executorActorId: null,
      };
    }

    case "raise_blocker":
    case "clear_blocker": {
      // Blocker intents are assignee-owned (the assignee reports blockers).
      if (!canSubmitImplementationIntent(state, actor)) {
        return {
          allowed: false,
          reason: "not_assignee",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      return {
        allowed: true,
        reason: "ok",
        decisionActorId: actor.id,
        executorActorId: null,
      };
    }

    case "cancel_task":
    case "archive_task": {
      // Cancel/archive are reporter-or-acting-manager decisions.
      if (
        actor.id !== state.reporterId &&
        actor.id !== state.actingManagerId &&
        actor.role !== "admin"
      ) {
        return {
          allowed: false,
          reason: "not_authorized_for_plan",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      return {
        allowed: true,
        reason: "ok",
        decisionActorId: actor.id,
        executorActorId: null,
      };
    }

    default:
      return {
        allowed: false,
        reason: "not_authorized_for_plan",
        decisionActorId: null,
        executorActorId: null,
      };
  }
}
