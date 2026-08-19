// PHASEE-06 — Typed compensation commands and terminal outcome semantics.
//
// §17 side-effect ownership: compensation handlers do NOT call the transition
// kernel directly. They submit through the command boundary
// (submitWorkflowCommand) so the orchestrator owns the transition atomically.
//
// Each compensation command names the exact side effects to reverse and the
// idempotent key to use. A compensation is only invoked when a procedure
// step fails terminally (operational_error) and the system needs to undo
// external consequences that were already committed.
//
// Terminal outcome semantics: operational_error procedures have a defined
// recovery path — either the reconciler handles them automatically (e.g.
// lease expiry + step retry), or a human intervenes (alertReporter).

import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";

// ---------------------------------------------------------------------------
// CompensationCommand — discriminated union keyed by procedure type.
// Each variant names the exact side effects to reverse and the idempotent
// key to use for the compensation command.
// ---------------------------------------------------------------------------

export type CompensationCommand =
  | {
      procedureType: "prepare_todo_task";
      sideEffectsToReverse: ("repository_contract_reservation" | "worktree_preparation" | "assignee_wake")[];
      idempotencyKey: string;
      reason: string;
    }
  | {
      procedureType: "start_implementation_cycle";
      sideEffectsToReverse: ("execution_episode" | "implementation_turn_dispatch")[];
      idempotencyKey: string;
      reason: string;
    }
  | {
      procedureType: "submit_candidate_for_review";
      sideEffectsToReverse: ("execution_freeze" | "candidate_preparation" | "validation_job" | "review_lease")[];
      idempotencyKey: string;
      reason: string;
    }
  | {
      procedureType: "return_review_for_changes";
      sideEffectsToReverse: ("finalization_invalidation" | "worktree_revalidation_mark" | "assignee_wake")[];
      idempotencyKey: string;
      reason: string;
    }
  | {
      procedureType: "finalize_accepted_review";
      sideEffectsToReverse: ("repository_finalization" | "review_completion" | "worktree_cleanup" | "queue_refill" | "completion_notification")[];
      idempotencyKey: string;
      reason: string;
    };

// ---------------------------------------------------------------------------
// Terminal outcome semantics.
// ---------------------------------------------------------------------------

export type TerminalOutcome =
  | { kind: "operational_error"; recoveryPath: "reconciler"; description: string }
  | { kind: "operational_error"; recoveryPath: "human"; description: string }
  | { kind: "superseded"; description: string }
  | { kind: "completed"; description: string };

/**
 * Map a procedure type + terminal failure to its recovery path.
 * operational_error procedures have a defined recovery path:
 * - prepare_todo_task: human (repository/permission failure needs intervention)
 * - start_implementation_cycle: reconciler (compensates back to To Do)
 * - submit_candidate_for_review: reconciler (validation failure → To Do)
 * - return_review_for_changes: human (rare failure path)
 * - finalize_accepted_review: human (finalization failure needs intervention)
 */
export function getTerminalOutcome(
  procedureType: TaskProcedureType,
  failureReason: string,
): TerminalOutcome {
  const reconcilerRecovery: Record<TaskProcedureType, boolean> = {
    prepare_todo_task: false,
    start_implementation_cycle: true,
    submit_candidate_for_review: true,
    return_review_for_changes: false,
    finalize_accepted_review: false,
  };

  const useReconciler = reconcilerRecovery[procedureType];
  return {
    kind: "operational_error",
    recoveryPath: useReconciler ? "reconciler" : "human",
    description: `Procedure ${procedureType} failed: ${failureReason}. Recovery: ${useReconciler ? "reconciler will attempt compensation" : "human intervention required (alertReporter set)"}.`,
  };
}

/**
 * Build a compensation command for a failed procedure step.
 * The compensation handler must submit through submitWorkflowCommand —
 * never call the transition kernel directly.
 */
export function buildCompensationCommand(
  procedureType: TaskProcedureType,
  completedSteps: string[],
  procedureRunId: string,
  reason: string,
): CompensationCommand {
  const idempotencyKey = `compensation:${procedureType}:${procedureRunId}`;
  switch (procedureType) {
    case "prepare_todo_task":
      return {
        procedureType,
        sideEffectsToReverse: completedSteps as ("repository_contract_reservation" | "worktree_preparation" | "assignee_wake")[],
        idempotencyKey,
        reason,
      };
    case "start_implementation_cycle":
      return {
        procedureType,
        sideEffectsToReverse: completedSteps as ("execution_episode" | "implementation_turn_dispatch")[],
        idempotencyKey,
        reason,
      };
    case "submit_candidate_for_review":
      return {
        procedureType,
        sideEffectsToReverse: completedSteps as ("execution_freeze" | "candidate_preparation" | "validation_job" | "review_lease")[],
        idempotencyKey,
        reason,
      };
    case "return_review_for_changes":
      return {
        procedureType,
        sideEffectsToReverse: completedSteps as ("finalization_invalidation" | "worktree_revalidation_mark" | "assignee_wake")[],
        idempotencyKey,
        reason,
      };
    case "finalize_accepted_review":
      return {
        procedureType,
        sideEffectsToReverse: completedSteps as ("repository_finalization" | "review_completion" | "worktree_cleanup" | "queue_refill" | "completion_notification")[],
        idempotencyKey,
        reason,
      };
  }
}