// ORCH-02 — Procedure definitions registry (stub).
//
// Procedure definitions are static, versioned code. Each procedure type maps
// to an ordered list of step names. The procedure engine (ORCH-03) owns the
// runner; this module owns the WHAT — the ordered steps for each procedure
// type.
//
// Filled in by ORCH-04..ORCH-07 with concrete step handlers. For ORCH-02,
// this registry exists so the decision layer can name procedure types and the
// projection can surface them.

import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";

export type ProcedureDefinition = {
  type: TaskProcedureType;
  // Ordered step names. A step cannot run until all required predecessors
  // completed (invariant 11: ordered procedures).
  steps: readonly string[];
  // Maximum attempts per step before terminal operational_error (invariant 12:
  // bounded recovery).
  maxAttemptsPerStep: number;
};

export const PROCEDURE_DEFINITIONS: Record<TaskProcedureType, ProcedureDefinition> = {
  prepare_todo_task: {
    type: "prepare_todo_task",
    steps: [
      "resolve_repository_contract",
      "prepare_worktree",
      "verify_actionability",
      "wake_assignee",
    ],
    maxAttemptsPerStep: 8,
  },
  start_implementation_cycle: {
    type: "start_implementation_cycle",
    steps: [
      "revalidate_worktree",
      "open_execution_episode",
      "dispatch_implementation_turn",
    ],
    maxAttemptsPerStep: 8,
  },
  submit_candidate_for_review: {
    type: "submit_candidate_for_review",
    steps: [
      "freeze_execution",
      "prepare_candidate",
      "run_validation",
      "apply_validation_result",
      "create_review_lease",
      "enter_review",
      "wake_reviewer",
    ],
    maxAttemptsPerStep: 8,
  },
  return_review_for_changes: {
    type: "return_review_for_changes",
    steps: [
      "invalidate_finalization_effects",
      "mark_worktree_for_revalidation",
      "wake_assignee_with_feedback",
    ],
    maxAttemptsPerStep: 8,
  },
  finalize_accepted_review: {
    type: "finalize_accepted_review",
    steps: [
      "finalize_repository",
      "verify_finalization",
      "complete_review",
      "cleanup_worktree",
      "refill_queues",
      "notify_completion",
    ],
    maxAttemptsPerStep: 8,
  },
};

export function getProcedureDefinition(type: TaskProcedureType): ProcedureDefinition {
  return PROCEDURE_DEFINITIONS[type];
}

export function getProcedureSteps(type: TaskProcedureType): readonly string[] {
  return PROCEDURE_DEFINITIONS[type].steps;
}