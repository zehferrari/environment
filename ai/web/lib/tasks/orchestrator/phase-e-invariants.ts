// PHASEE-10 — Phase E invariant detectors and safe repair rules.
//
// Pure predicate functions that detect Phase E invariant violations.
// Each detector returns a finding with a safe repair action (drain, requeue,
// escalate) — no detector invents transitions. These are added to
// runWorkflowReconciliation and produce findings in the report.
//
// Detectors are pure predicates tested with fixtures (no DB required for unit
// tests). The reconciler wires them with live DB data.

export type PhaseEInvariantKind =
  | "engine_ownership_mismatch"
  | "stale_receipt_without_transition"
  | "procedure_run_without_cycle"
  | "unknown_engine_value";

export type PhaseEInvariantFinding = {
  kind: PhaseEInvariantKind;
  taskId: string;
  detail: string;
  repair: "drain" | "requeue" | "escalate";
};

export type PhaseEInvariantInput = {
  taskId: string;
  taskEngine: string;
  taskEnginePinnedAt: Date | null;
  activeCycle: {
    id: string;
    workflowEngine: string;
    status: string;
  } | null;
  lastReceipt: {
    idempotencyKey: string;
    intent: string;
    status: string;
    transitionId: string | null;
    createdAt: Date;
  } | null;
  activeProcedureRuns: Array<{
    id: string;
    type: string;
    workflowCycleId: string | null;
  }>;
  taskStatus: string;
};

/**
 * Detect engine ownership mismatch: task engine vs cycle engine.
 * An open cycle must have the same engine as the task.
 */
export function detectEngineOwnershipMismatch(
  input: PhaseEInvariantInput,
): PhaseEInvariantFinding | null {
  if (!input.activeCycle) return null;
  if (input.taskEngine !== input.activeCycle.workflowEngine) {
    return {
      kind: "engine_ownership_mismatch",
      taskId: input.taskId,
      detail: `task engine is ${input.taskEngine} but active cycle ${input.activeCycle.id} has engine ${input.activeCycle.workflowEngine}`,
      repair: "escalate",
    };
  }
  return null;
}

/**
 * Detect a stale receipt without a corresponding transition.
 * A receipt with status "accepted" or "completed" should have a transitionId.
 */
export function detectStaleReceiptWithoutTransition(
  input: PhaseEInvariantInput,
): PhaseEInvariantFinding | null {
  if (!input.lastReceipt) return null;
  const receipt = input.lastReceipt;
  if (
    (receipt.status === "accepted" || receipt.status === "completed") &&
    !receipt.transitionId
  ) {
    return {
      kind: "stale_receipt_without_transition",
      taskId: input.taskId,
      detail: `command receipt ${receipt.idempotencyKey} (intent: ${receipt.intent}) has status ${receipt.status} but no transitionId`,
      repair: "escalate",
    };
  }
  return null;
}

/**
 * Detect a procedure run without a cycle.
 * Active procedure runs (queued/running/operational_error) should have a
 * workflowCycleId unless they are planning procedures (prepare_todo_task)
 * which run without a cycle.
 */
export function detectProcedureRunWithoutCycle(
  input: PhaseEInvariantInput,
): PhaseEInvariantFinding | null {
  for (const proc of input.activeProcedureRuns) {
    if (!proc.workflowCycleId && proc.type !== "prepare_todo_task") {
      return {
        kind: "procedure_run_without_cycle",
        taskId: input.taskId,
        detail: `procedure run ${proc.id} (type: ${proc.type}) has no workflowCycleId`,
        repair: "escalate",
      };
    }
  }
  return null;
}

/**
 * Detect unknown engine value: task.workflowEngine is not a recognized engine.
 * This fires regardless of whether a cycle is open, so it catches cycle-less
 * tasks with a corrupt engine field. True dual-engine (two open cycles with
 * different engines on the same task) is prevented by the unique constraint
 * on open cycles (at most one open cycle per task), so it is not duplicated
 * here.
 */
export function detectUnknownEngineValue(
  input: PhaseEInvariantInput,
): PhaseEInvariantFinding | null {
  const validEngines = new Set(["legacy", "orchestrator_v2"]);
  if (!validEngines.has(input.taskEngine)) {
    return {
      kind: "unknown_engine_value",
      taskId: input.taskId,
      detail: `task has unknown engine value: ${input.taskEngine}`,
      repair: "escalate",
    };
  }
  return null;
}

/**
 * Run all Phase E invariant detectors against the input.
 * Returns all findings (empty array if healthy).
 */
export function detectPhaseEInvariants(
  input: PhaseEInvariantInput,
): PhaseEInvariantFinding[] {
  const findings: PhaseEInvariantFinding[] = [];
  const detectors = [
    detectEngineOwnershipMismatch,
    detectStaleReceiptWithoutTransition,
    detectProcedureRunWithoutCycle,
    detectUnknownEngineValue,
  ];
  for (const detector of detectors) {
    const finding = detector(input);
    if (finding) findings.push(finding);
  }
  return findings;
}