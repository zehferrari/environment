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

import { canRetryAcceptedRepositoryReview } from "@/lib/tasks/repository-finalization";
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
  | "approval_required_use_approve_plan"
  | "not_authorized_for_done"
  | "not_coding_capable"
  | "monitor_cannot_decide"
  | "human_required"
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

function isPmPolicyCommand(
  state: Pick<TaskStateSnapshot, "id" | "projectId" | "workflowVersion" | "assigneeId"> & {
    assignee?: { codingCapability?: boolean } | null;
  },
  command: {
    source?: string;
    expectedWorkflowVersion?: number;
    payload?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
  },
  policies: readonly string[],
): boolean {
  if (command.source !== "pm-service") return false;
  const evidence = command.evidence;
  if (!evidence || !policies.includes(String(evidence.policy ?? ""))) return false;
  if (evidence.selectedTaskId !== state.id) return false;
  if (
    evidence.expectedWorkflowVersion !== command.expectedWorkflowVersion
    || command.expectedWorkflowVersion !== state.workflowVersion
  ) return false;
  const trigger = evidence.trigger;
  const validTrigger = Boolean(
    trigger
    && typeof trigger === "object"
    && !Array.isArray(trigger)
    && typeof (trigger as Record<string, unknown>).kind === "string"
    && typeof (trigger as Record<string, unknown>).id === "string"
    && String((trigger as Record<string, unknown>).id).trim(),
  );
  if (!validTrigger) return false;
  if (evidence.policy === "auto_start") {
    return Boolean(
      state.assigneeId
      && evidence.selectedAssigneeId === state.assigneeId
      && evidence.assigneeLane === `${state.projectId}:${state.assigneeId}`
      && state.assignee?.codingCapability === true,
    );
  }
  if (evidence.policy === "reviewer_assignment" || evidence.policy === "epic_queue_refill") {
    const selectedId = typeof evidence.selectedAssigneeId === "string" ? evidence.selectedAssigneeId : null;
    const selectedUsername = typeof evidence.selectedAssigneeUsername === "string"
      ? evidence.selectedAssigneeUsername.replace(/^@/, "")
      : null;
    const requestedUsername = typeof command.payload?.assigneeUsername === "string"
      ? command.payload.assigneeUsername.replace(/^@/, "")
      : null;
    return Boolean(
      selectedId
      && selectedUsername
      && selectedUsername === requestedUsername
      && evidence.assigneeLane === `${state.projectId}:${selectedId}`,
    );
  }
  return true;
}

function isBrowserHumanStartCommand(
  state: Pick<TaskStateSnapshot, "id" | "projectId" | "workflowVersion" | "assigneeId"> & {
    assignee?: { codingCapability?: boolean } | null;
  },
  command: {
    source?: string;
    expectedWorkflowVersion?: number;
    evidence?: Record<string, unknown>;
  },
): boolean {
  const evidence = command.evidence;
  return Boolean(
    command.source === "browser"
    && evidence?.policy === "human_start_request"
    && evidence.selectedTaskId === state.id
    && evidence.selectedAssigneeId === state.assigneeId
    && evidence.assigneeLane === `${state.projectId}:${state.assigneeId}`
    && evidence.expectedWorkflowVersion === command.expectedWorkflowVersion
    && command.expectedWorkflowVersion === state.workflowVersion
    && state.assignee?.codingCapability === true
  );
}

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
  command: {
    intent: TaskWorkflowIntent;
    actor: WorkflowActor;
    source?: string;
    expectedWorkflowVersion?: number;
    payload?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
  },
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

  // Internal Epic adapters are authenticated before command construction.
  // Humans have already passed project access; agents must be the Epic acting
  // manager or carry a server-resolved operator/admin/monitor role (completion
  // reviewer, deploy reviewer, or repository executor). The Epic-id guard is
  // repeated in guards.ts so a valid actor cannot target a sibling Epic task.
  if (intent === "epic_child_update") {
    const isAuthorizedAgent = actor.id === state.epic?.actingManagerId ||
      actor.role === "operator" || actor.role === "admin" || actor.role === "monitor";
    if (actor.kind !== "human" && !isAuthorizedAgent) {
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
      executorActorId: actor.kind === "agent" ? actor.id : null,
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
    case "override_status": {
      // Project access is established by the authenticated transport before
      // aggregate loading. Reject every agent/mechanical actor here so this
      // remains an explicit human decision.
      if (actor.kind !== "human") {
        return {
          allowed: false,
          reason: "human_required",
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

    case "submit_plan":
    case "checkpoint":
    case "submit_for_review":
    case "start_implementation": {
      if (
        intent === "start_implementation"
        && actor.kind === "human"
        && isBrowserHumanStartCommand(state, command)
      ) {
        // Browser membership was authorized before aggregate loading. The
        // human requests the transition, while the assigned coding agent
        // remains the implementation executor dispatched by the procedure.
        return {
          allowed: true,
          reason: "ok",
          decisionActorId: actor.id,
          executorActorId: null,
        };
      }
      if (
        intent === "start_implementation"
        && isPmPolicyCommand(state, command, ["auto_start"])
      ) {
        return {
          allowed: true,
          reason: "ok",
          decisionActorId: actor.id,
          executorActorId: actor.id,
        };
      }
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

    case "request_plan_revision": {
      const allowed = actor.id === state.assigneeId || actor.id === resolveReviewOwnerId(state) || (actor.kind === "human" && actor.id === state.reporterId);
      return { allowed, reason: allowed ? "ok" : "not_authorized_for_plan", decisionActorId: allowed ? actor.id : null, executorActorId: null };
    }
    case "delegate_plan_approval": {
      const allowed = actor.kind === "human" && actor.id === state.reporterId
        && Boolean(resolveReviewOwnerId(state)) && resolveReviewOwnerId(state) !== actor.id;
      return { allowed, reason: allowed ? "ok" : "not_authorized_for_plan", decisionActorId: allowed ? actor.id : null, executorActorId: null };
    }
    case "accept_plan_review":
    case "request_plan_changes": {
      const allowed = actor.id === resolveReviewOwnerId(state) || actor.id === state.reporterId;
      if (allowed && intent === "accept_plan_review" && canApproveActionPlanForActor(state, actor.id)) {
        return { allowed: false, reason: "approval_required_use_approve_plan", decisionActorId: null, executorActorId: null };
      }
      return { allowed, reason: allowed ? "ok" : "not_authorized_for_plan", decisionActorId: allowed ? actor.id : null, executorActorId: null };
    }
    case "approve_plan": {
      // Delegate to canonical workflow-actors.canApproveActionPlanForActor.
      if (
        !canApproveActionPlanForActor(
          {
            actionPlan: state.actionPlan,
            assigneeId: state.assigneeId,
            actingManagerId: state.actingManagerId,
            reporterId: state.reporterId,
            project: state.project,
            epic: state.epic
              ? {
                  status: state.epic.status,
                  actingManagerId: state.epic.actingManagerId,
                  approvedOn: state.epic.approvedOn,
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
      if (!lease || !["awaiting_review", "accepted", "accepted_pending_owner"].includes(lease.status)) {
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
      if (!lease || (lease.status !== "awaiting_review" && !canRetryAcceptedRepositoryReview(state))) {
        return {
          allowed: false,
          reason: "no_active_lease",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      if (
        (lease.status === "accepted" && lease.reviewerId !== actor.id) ||
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

    case "defer_acceptance_check": {
      const allowed = actor.id !== state.assigneeId && actor.id === resolvePlanOwnerIdFromSnapshot(state);
      return { allowed, reason: allowed ? "ok" : "not_reviewer", decisionActorId: allowed ? actor.id : null, executorActorId: null };
    }
    case "review_permission": {
      const allowed = actor.id !== state.assigneeId && actor.id === state.resolvedPermissionReviewerId;
      return { allowed, reason: allowed ? "ok" : "not_reviewer", decisionActorId: allowed ? actor.id : null, executorActorId: null };
    }
    case "raise_blocker": {
      // Raising a blocker is assignee-owned (the assignee reports blockers).
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

    case "clear_blocker": {
      if (state.activeBlocker?.override?.kind === "wait_for_human") {
        // A human status override deliberately fences the assignee. Only an
        // authorized human workflow owner may release that dedicated blocker.
        if (actor.kind !== "human") {
          return {
            allowed: false,
            reason: "human_required",
            decisionActorId: null,
            executorActorId: null,
          };
        }
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
      } else if (!canSubmitImplementationIntent(state, actor)) {
        // Preserve legacy parity for agent-raised operational/scope blockers:
        // the assignee that raised the blocker remains able to clear it.
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

    case "triage_task":
    case "assign_task":
    case "request_subtask": {
      if (
        intent === "triage_task"
        && isPmPolicyCommand(state, command, ["epic_queue_promotion"])
      ) {
        return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: actor.id };
      }
      if (
        intent === "assign_task"
        && isPmPolicyCommand(state, command, ["reviewer_assignment", "epic_queue_refill"])
      ) {
        return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: actor.id };
      }
      const reviewerId = resolveReviewOwnerId({
        actingManagerId: state.actingManagerId,
        reporterId: state.reporterId,
        epic: state.epic
          ? { status: state.epic.status, actingManagerId: state.epic.actingManagerId }
          : null,
      });
      if (actor.id !== reviewerId) {
        return {
          allowed: false,
          reason: "not_reviewer",
          decisionActorId: null,
          executorActorId: null,
        };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };
    }

    case "publish_checkpoint": {
      if (state.assigneeId !== actor.id) {
        return { allowed: false, reason: "not_assignee", decisionActorId: null, executorActorId: null };
      }
      if (actor.codingCapability !== true) {
        return { allowed: false, reason: "not_coding_capable", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };
    }

    case "add_subtask":
    case "complete_subtask":
    case "remove_subtask": {
      const subtaskKind = command.payload?.subtaskKind;
      if (subtaskKind === "review" || (command.intent === "remove_subtask" && command.payload?.supersededReason)) {
        const reviewerId = resolveReviewOwnerId({
          actingManagerId: state.actingManagerId,
          reporterId: state.reporterId,
          epic: state.epic
            ? { status: state.epic.status, actingManagerId: state.epic.actingManagerId }
            : null,
        });
        if (actor.id !== reviewerId) {
          return { allowed: false, reason: "not_reviewer", decisionActorId: null, executorActorId: null };
        }
      } else if (state.assigneeId !== actor.id) {
        return { allowed: false, reason: "not_assignee", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };
    }

    case "request_task":
    case "raise_scope_blocker": {
      if (state.assigneeId !== actor.id) {
        return { allowed: false, reason: "not_assignee", decisionActorId: null, executorActorId: null };
      }
      return { allowed: true, reason: "ok", decisionActorId: actor.id, executorActorId: null };
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
