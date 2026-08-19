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
//
// PHASEE-06: Definitions are now versioned. PROCEDURE_DEFINITIONS is keyed by
// (type, version). getProcedureDefinition accepts an optional version and
// returns the exact matching definition — no implicit fallback to a
// different version. A missing version is a bug, not a compatibility window.

import type { TaskProcedureType } from "@/lib/tasks/orchestrator/types";

// ---------------------------------------------------------------------------
// Versioned input schemas — one typed shape per procedure type.
// Each procedure type declares its input schema at version 1. When the input
// shape changes, increment the version and add a new entry.
// ---------------------------------------------------------------------------

export type PrepareTodoTaskInput = Record<string, never>;
export type StartImplementationCycleInput = Record<string, never>;
export type SubmitCandidateForReviewInput = {
  candidateSha?: string | null;
  comment?: string | null;
};
export type ReturnReviewForChangesInput = {
  comment?: string | null;
};
export type FinalizeAcceptedReviewInput = Record<string, never>;

/** Map procedure type → typed input shape. */
export interface ProcedureInputMap {
  prepare_todo_task: PrepareTodoTaskInput;
  start_implementation_cycle: StartImplementationCycleInput;
  submit_candidate_for_review: SubmitCandidateForReviewInput;
  return_review_for_changes: ReturnReviewForChangesInput;
  finalize_accepted_review: FinalizeAcceptedReviewInput;
}

export type ProcedureInputFor<T extends TaskProcedureType> = ProcedureInputMap[T];

// ---------------------------------------------------------------------------
// Versioned procedure definition.
// ---------------------------------------------------------------------------

export type ProcedureDefinition = {
  type: TaskProcedureType;
  /** Definition version — incremented when steps, ordering, or semantics change. */
  version: number;
  /** Input schema version — incremented when the input shape changes. */
  inputSchemaVersion: number;
  // Ordered step names. A step cannot run until all required predecessors
  // completed (invariant 11: ordered procedures).
  steps: readonly string[];
  // Maximum attempts per step before terminal operational_error (invariant 12:
  // bounded recovery).
  maxAttemptsPerStep: number;
};

// ---------------------------------------------------------------------------
// Versioned definitions registry — keyed by `${type}:${version}`.
// A definition that is not found is a bug, not a transient failure.
// No implicit fallback: a run stamped definitionVersion=N must use the vN
// definition, or fail to operational_error.
// ---------------------------------------------------------------------------

export const PROCEDURE_DEFINITIONS: ReadonlyMap<string, ProcedureDefinition> = new Map([
  ["prepare_todo_task:1", {
    type: "prepare_todo_task",
    version: 1,
    inputSchemaVersion: 1,
    steps: [
      "resolve_repository_contract",
      "prepare_worktree",
      "verify_actionability",
      "wake_assignee",
    ],
    maxAttemptsPerStep: 8,
  }],
  ["start_implementation_cycle:1", {
    type: "start_implementation_cycle",
    version: 1,
    inputSchemaVersion: 1,
    steps: [
      "revalidate_worktree",
      "open_execution_episode",
      "dispatch_implementation_turn",
    ],
    maxAttemptsPerStep: 8,
  }],
  ["submit_candidate_for_review:1", {
    type: "submit_candidate_for_review",
    version: 1,
    inputSchemaVersion: 1,
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
  }],
  ["return_review_for_changes:1", {
    type: "return_review_for_changes",
    version: 1,
    inputSchemaVersion: 1,
    steps: [
      "invalidate_finalization_effects",
      "mark_worktree_for_revalidation",
      "wake_assignee_with_feedback",
    ],
    maxAttemptsPerStep: 8,
  }],
  ["finalize_accepted_review:1", {
    type: "finalize_accepted_review",
    version: 1,
    inputSchemaVersion: 1,
    steps: [
      "finalize_repository",
      "verify_finalization",
      "complete_review",
      "cleanup_worktree",
      "refill_queues",
      "notify_completion",
    ],
    maxAttemptsPerStep: 8,
  }],
]);

// ---------------------------------------------------------------------------
// Lookup functions.
// ---------------------------------------------------------------------------

/**
 * Get the procedure definition for a type at an exact version.
 * If version is omitted, returns the latest version available.
 * No implicit cross-version fallback — a missing exact match returns undefined.
 */
export function getProcedureDefinition(
  type: TaskProcedureType,
  version?: number,
): ProcedureDefinition | undefined {
  if (version !== undefined) {
    // Exact match only — no fallback to a different version.
    return PROCEDURE_DEFINITIONS.get(`${type}:${version}`);
  }
  // No version specified: return the highest registered version.
  let latest: ProcedureDefinition | undefined;
  for (const def of PROCEDURE_DEFINITIONS.values()) {
    if (def.type === type && (!latest || def.version > latest.version)) {
      latest = def;
    }
  }
  return latest;
}

/**
 * Get the latest procedure definition for a type (convenience for callers
 * that always want the current version, e.g. createProcedureRun).
 */
export function getLatestProcedureDefinition(type: TaskProcedureType): ProcedureDefinition {
  const def = getProcedureDefinition(type);
  if (!def) {
    throw new Error(`No procedure definition registered for type ${type}`);
  }
  return def;
}

export function getProcedureSteps(type: TaskProcedureType, version?: number): readonly string[] {
  const def = getProcedureDefinition(type, version);
  if (!def) {
    throw new Error(`No procedure definition for ${type} at version ${version ?? "latest"}`);
  }
  return def.steps;
}
