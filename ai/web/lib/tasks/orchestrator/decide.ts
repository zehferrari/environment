// ORCH-02 — Pure decision function for workflow commands.
//
// Maps (TaskStateSnapshot, TaskWorkflowCommand, AuthorizationResult) to an
// OrchestrationDecision. This function MUST NOT access the network,
// filesystem, OpenClaw gateway, Git, or spool directories (invariant 10: no
// inferred decisions; the decision is a pure function of recorded state).
//
// The decision names:
//   - the transition kernel intent (the legacy vocabulary the kernel owns);
//   - the cycle operation (open/update/close/none);
//   - the procedure type to start (if any);
//   - the outbox effects to enqueue;
//   - the decision actor and mechanical executor separately (invariant 9).
//
// Effects here are durable outbox effects only. Repository spool enqueue and
// PM-channel dispatch are procedure-step handlers (ORCH-03+), not decision
// effects. The decision says WHAT should happen; the procedure engine says
// HOW it happens in ordered, replay-safe steps.

import type {
  OrchestrationDecision,
  TaskStateSnapshot,
  TaskWorkflowIntent,
  WorkflowEffect,
} from "@/lib/tasks/orchestrator/types";
import type { AuthorizationResult } from "@/lib/tasks/orchestrator/authorize";

export type DecisionError = { status: "invalid"; reason: string };

/**
 * Compute the orchestration decision for a command. Pure: no I/O.
 *
 * Returns either a DecisionError (the command is structurally invalid even
 * after passing guards — e.g. missing evidence) or an OrchestrationDecision
 * describing the transition + cycle operation + effects to durably record.
 */
export function decideCommand(
  state: TaskStateSnapshot,
  command: {
    intent: TaskWorkflowIntent;
    actor: { id: string; username?: string | null };
    evidence?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  },
  auth: AuthorizationResult,
): OrchestrationDecision | DecisionError {
  // The decision actor is the authorization result's decisionActorId (which
  // for mechanical intents is the reviewer who authorized the underlying
  // decision, not the monitor). The executor is the mechanical actor.
  const decisionActorId = auth.decisionActorId ?? command.actor.id;
  const executorActorId = auth.executorActorId ?? null;

  switch (command.intent) {
    case "approve_plan": {
      // Backlog -> To Do. Opens the prepare_todo_task procedure (ORCH-04).
      // Cycle operation is "none" — the cycle opens at start_implementation,
      // not at plan approval.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-plan-approved", payload: {} },
      ];
      // Wake the assignee with a todo_start_required notification. The
      // procedure (ORCH-04) owns the deduplicated wake AFTER worktree
      // preparation succeeds; the decision only declares the effect.
      if (state.assigneeId) {
        effects.push({
          type: "task_notification",
          key: `plan-approved:${state.assigneeId}`,
          payload: {
            taskId: state.id,
            targetUserId: state.assigneeId,
            actor: command.actor,
            reason: "todo_start_required",
            body: "The Action Plan was approved. PM will prepare the worktree and wake you.",
          },
        });
      }
      return {
        fromStatus: state.status,
        toStatus: "To Do",
        kernelIntent: "approve_plan",
        cycleOperation: "none",
        procedureType: "prepare_todo_task",
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId },
        decisionActorId,
        executorActorId,
        taskData: { approvedOn: new Date(), approvedById: decisionActorId },
      };
    }

    case "request_plan_changes": {
      // Stays in Backlog/To Do. No transition; the decision is recorded as
      // an outbox effect (a feedback notification to the assignee) and an
      // activity log row. The kernel is not invoked — there is no status
      // change. The orchestrator records this as a no-op transition for
      // auditability via the operator_override intent if needed.
      // For now, request_plan_changes is a notification-only decision.
      const effects: WorkflowEffect[] = [];
      if (state.assigneeId) {
        effects.push({
          type: "task_notification",
          key: `plan-changes-requested:${state.assigneeId}`,
          payload: {
            taskId: state.id,
            targetUserId: state.assigneeId,
            actor: command.actor,
            reason: "review_feedback",
            body: "The reviewer requested changes to the Action Plan. Revise and resubmit.",
          },
        });
      }
      return {
        fromStatus: state.status,
        toStatus: state.status,
        kernelIntent: "operator_override", // no status change; recorded for audit
        cycleOperation: "none",
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, planChanges: true },
        decisionActorId,
        executorActorId,
      };
    }

    case "start_implementation": {
      // To Do -> In Progress. Opens a new cycle. Starts the
      // start_implementation_cycle procedure (ORCH-05).
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-start", payload: {} },
      ];
      return {
        fromStatus: "To Do",
        toStatus: "In Progress",
        kernelIntent: "start",
        cycleOperation: "open",
        procedureType: "start_implementation_cycle",
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId },
        decisionActorId,
        executorActorId,
      };
    }

    case "checkpoint": {
      // No status change. The decision is an execution-state checkpoint
      // recorded by the episode lifecycle. No transition kernel call.
      return {
        fromStatus: "In Progress",
        toStatus: "In Progress",
        kernelIntent: "operator_override",
        cycleOperation: "none",
        effects: [],
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, checkpoint: true },
        decisionActorId,
        executorActorId,
      };
    }

    case "submit_for_review": {
      // Stays In Progress. The submit_candidate_for_review procedure (ORCH-06)
      // owns the ordered steps: freeze execution, prepare candidate, run
      // validation, apply result, create review lease, THEN move to Review.
      // The decision here only declares the INTENT and starts the procedure;
      // the status change happens in step 6 (enter_review) via a mechanical
      // repository_validation_succeeded callback, not here.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-review-submission", payload: {} },
      ];
      return {
        fromStatus: "In Progress",
        toStatus: "In Progress",
        kernelIntent: "operator_override",
        cycleOperation: "update",
        procedureType: "submit_candidate_for_review",
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, candidateSha: command.payload?.candidateSha ?? null },
        decisionActorId,
        executorActorId,
      };
    }

    case "repository_validation_succeeded": {
      // In Progress -> Review. Mechanical callback. Cycle operation "update"
      // (candidate SHA confirmed). The procedure (ORCH-06) creates the
      // immutable review lease and wakes the reviewer.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-review-ready", payload: {} },
      ];
      return {
        fromStatus: "In Progress",
        toStatus: "Review",
        kernelIntent: "repository_validated",
        cycleOperation: "update",
        procedureType: "submit_candidate_for_review",
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, candidateSha: command.payload?.candidateSha ?? null, mechanical: true },
        decisionActorId,
        executorActorId,
      };
    }

    case "repository_validation_failed": {
      // In Progress -> To Do (front). Cycle operation "close" with
      // validation_failed outcome. The procedure (ORCH-06) sends one
      // consolidated feedback notification to the assignee.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-validation-failed", payload: {} },
      ];
      if (state.assigneeId) {
        effects.push({
          type: "task_notification",
          key: `validation-feedback:${state.assigneeId}`,
          payload: {
            taskId: state.id,
            targetUserId: state.assigneeId,
            actor: command.actor,
            reason: "review_feedback",
            body: "Repository validation failed. The task returned to the front of To Do.",
          },
        });
      }
      return {
        fromStatus: "In Progress",
        toStatus: "To Do",
        kernelIntent: "repository_validation_failed",
        cycleOperation: "close",
        cycleOutcome: "validation_failed",
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, candidateSha: command.payload?.candidateSha ?? null, mechanical: true },
        decisionActorId,
        executorActorId,
        rank: "front",
      };
    }

    case "request_review_changes": {
      // Review -> To Do (front). Cycle operation "close" with
      // changes_requested outcome. The procedure (ORCH-07) sends one
      // consolidated reviewer comment to the assignee.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-review-feedback", payload: {} },
      ];
      if (state.assigneeId) {
        effects.push({
          type: "task_notification",
          key: `review-feedback:${state.assigneeId}`,
          payload: {
            taskId: state.id,
            targetUserId: state.assigneeId,
            actor: command.actor,
            reason: "review_feedback",
            body: "The reviewer requested changes. The task returned to the front of To Do.",
          },
        });
      }
      return {
        fromStatus: "Review",
        toStatus: "To Do",
        kernelIntent: "request_changes",
        cycleOperation: "close",
        cycleOutcome: "changes_requested",
        procedureType: "return_review_for_changes",
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, reviewRunId: state.activeReviewRun?.id ?? null },
        decisionActorId,
        executorActorId,
        rank: "front",
      };
    }

    case "accept_review": {
      // Stays in Review. Cycle operation "none" — the cycle closes when
      // finalization succeeds. The procedure (ORCH-07) marks the lease
      // accepted and runs finalization. The mechanical
      // repository_finalization_succeeded callback later moves Review -> Done
      // and closes the cycle as completed.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-review-accepted", payload: {} },
      ];
      return {
        fromStatus: "Review",
        toStatus: "Review",
        kernelIntent: "operator_override", // no status change yet
        cycleOperation: "none",
        procedureType: "finalize_accepted_review",
        effects,
        evidence: {
          ...command.evidence ?? {},
          decisionActorId,
          executorActorId,
          reviewRunId: state.activeReviewRun?.id ?? null,
          candidateSha: state.activeReviewRun?.candidateSha ?? null,
        },
        decisionActorId,
        executorActorId,
      };
    }

    case "repository_finalization_succeeded": {
      // Review -> Done. Mechanical callback. Cycle operation "close" with
      // completed outcome. The decision actor is the accepted reviewer
      // (recovered from the lease by authorize.ts); the executor is the
      // monitor. This is the critical invariant 9 enforcement: the Done
      // transition is attributed to the reviewer, with the finalizer recorded
      // separately in evidence.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-done", payload: {} },
      ];
      return {
        fromStatus: "Review",
        toStatus: "Done",
        kernelIntent: "accept_review",
        cycleOperation: "close",
        cycleOutcome: "completed",
        effects,
        evidence: {
          ...command.evidence ?? {},
          decisionActorId,
          executorActorId,
          reviewRunId: state.activeReviewRun?.id ?? null,
          candidateSha: state.activeReviewRun?.candidateSha ?? null,
          repositoryFinalized: true,
          finalizedByUserId: executorActorId,
        },
        decisionActorId,
        executorActorId,
      };
    }

    case "repository_finalization_failed": {
      // Stays in Review. The accepted lease is retained (invariant: retrying
      // finalization reuses the accepted lease; it does not ask the reviewer
      // to accept again). The procedure (ORCH-07) records an operational
      // error and retries.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-finalization-failed", payload: {} },
      ];
      return {
        fromStatus: "Review",
        toStatus: "Review",
        kernelIntent: "operator_override",
        cycleOperation: "none",
        effects,
        evidence: {
          ...command.evidence ?? {},
          decisionActorId,
          executorActorId,
          reviewRunId: state.activeReviewRun?.id ?? null,
          candidateSha: state.activeReviewRun?.candidateSha ?? null,
          finalizationFailed: true,
        },
        decisionActorId,
        executorActorId,
      };
    }

    case "cancel_task": {
      // To Do/In Progress/Review -> Backlog. Closes any active cycle as
      // cancelled.
      const effects: WorkflowEffect[] = [
        { type: "board_touch", key: "board-cancelled", payload: {} },
      ];
      return {
        fromStatus: state.status,
        toStatus: "Backlog",
        kernelIntent: "cancel",
        cycleOperation: state.activeWorkflowCycleId ? "close" : "none",
        cycleOutcome: state.activeWorkflowCycleId ? "cancelled" : undefined,
        effects,
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId },
        decisionActorId,
        executorActorId,
      };
    }

    case "raise_blocker":
    case "clear_blocker": {
      // No status change. Blocker state is recorded as evidence + activity.
      return {
        fromStatus: state.status,
        toStatus: state.status,
        kernelIntent: "operator_override",
        cycleOperation: "none",
        effects: [],
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, blocker: command.intent },
        decisionActorId,
        executorActorId,
      };
    }

    case "archive_task": {
      // Done -> archived. No status change (archive is a separate flag).
      return {
        fromStatus: "Done",
        toStatus: "Done",
        kernelIntent: "operator_override",
        cycleOperation: "none",
        effects: [],
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, archive: true },
        decisionActorId,
        executorActorId,
      };
    }

    case "submit_plan": {
      // No status change. The plan is recorded; the reviewer is notified.
      return {
        fromStatus: state.status,
        toStatus: state.status,
        kernelIntent: "operator_override",
        cycleOperation: "none",
        effects: [],
        evidence: { ...command.evidence ?? {}, decisionActorId, executorActorId, planSubmitted: true },
        decisionActorId,
        executorActorId,
      };
    }

    default:
      return { status: "invalid", reason: `decideCommand: unsupported intent ${command.intent}` };
  }
}