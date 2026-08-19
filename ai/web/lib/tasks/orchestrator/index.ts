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
import { computeRequestFingerprint } from "@/lib/tasks/orchestrator/receipts";
import { resolveEngineOwnership, stampCycleEngine, ENGINE_ORCHESTRATOR_V2 } from "@/lib/tasks/orchestrator/ownership";
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
 *
 * Delegates to loadTaskAggregate (state.ts) which loads the complete
 * task aggregate (spec §8). TaskAggregate extends TaskStateSnapshot, so
 * the returned object is structurally compatible with all existing
 * guards/decide/authorize consumers.
 */
export async function loadTaskStateSnapshot(taskId: string): Promise<TaskStateSnapshot | null> {
  const { loadTaskAggregate } = await import("@/lib/tasks/orchestrator/state");
  const aggregate = await loadTaskAggregate(taskId);
  return aggregate;
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

  // --- Engine ownership resolution (Phase E §3.2) ----------------------
  // Resolve durable engine ownership BEFORE any writes. This gate runs
  // before guards, decision, and execution so a rejection never mutates.
  // For Phase E step 1, no tasks are pinned to V2 (the admission flag is
  // off), so legacy-owned tasks pass through. A V2-owned task that
  // disagrees with its active cycle is rejected here as an invariant
  // violation — never heuristically resolved.
  //
  // The gate is permissive for legacy: the orchestrator is the current
  // mutation path for all tasks, and legacy ownership simply means "not
  // yet migrated." Hard rejection of legacy tasks belongs to Phase E
  // step 8 (authoritative adapter), not step 1.
  const ownership = await resolveEngineOwnership(db, command.taskId);
  if (!ownership.ok) {
    return { status: "forbidden", reason: ownership.reason };
  }
  // V2-owned tasks: stamp cycle engine when opening a new cycle.
  // Legacy-owned tasks: pass through without gating.
  if (ownership.engine === ENGINE_ORCHESTRATOR_V2 && command.workflowCycleId === null) {
    // Cycle stamping happens inside execute.ts when the cycle is opened,
    // but we resolve ownership here to reject invariant violations early.
  }

  // --- Idempotency replay check (before guards, per kernel semantics) ----
  // TaskWorkflowCommandReceipt is the single replay authority (Phase E §6).
  // The ActivityLog substring scan (payload contains idempotencyKey) is
  // removed because a `contains` match on serialized JSON is not an
  // exact-correlation check and cannot reliably reconstruct the original
  // response. The receipt stores the serialized OrchestratorResult projection
  // so an exact replay returns an identical response.
  //
  // Pre-receipt fallback: the WorkflowTransition lookup is retained for
  // transitions committed before the receipt migration. Every existing
  // transition has an idempotencyKey and no receipt, so without this
  // fallback replays across the legacy drain window would re-execute.
  const existingReceipt = await db.taskWorkflowCommandReceipt.findUnique({
    where: {
      taskId_idempotencyKey: {
        taskId: command.taskId,
        idempotencyKey: command.idempotencyKey,
      },
    },
    select: { id: true, requestFingerprint: true, result: true },
  });
  if (existingReceipt) {
    const fingerprint = computeRequestFingerprint(command);
    if (existingReceipt.requestFingerprint === fingerprint) {
      // Exact replay — return the stored result with replay status.
      const stored = JSON.parse(existingReceipt.result) as OrchestratorResult;
      if (stored.status === "accepted") {
        return { status: "replayed", transitionId: stored.transitionId, workflowVersion: stored.workflowVersion, procedureId: stored.procedureId ?? null };
      }
      return stored;
    }
    // Same key, different payload — idempotency conflict (domain error, not HTTP status).
    return { status: "invalid", reason: "idempotency_conflict: idempotency key reused with different payload." };
  }
  // Legacy fallback 1: transitions committed before the receipt migration.
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
  // Legacy fallback 2: no-op decisions (accept_review, checkpoint, etc.)
  // create an ActivityLog row instead of a WorkflowTransition. Until receipt
  // creation is wired into the execution path (Phase E step 2), this fallback
  // is required so no-op replays don't fall through to authorization.
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
  return executeWorkflowCommand(command, orchestrationDecision, state);
}

// Re-export the public API so routes can import from a single module.
export { authorizeCommand } from "@/lib/tasks/orchestrator/authorize";
export { runGuards } from "@/lib/tasks/orchestrator/guards";
export { decideCommand } from "@/lib/tasks/orchestrator/decide";
export { executeWorkflowCommand } from "@/lib/tasks/orchestrator/execute";
export { buildTaskWorkflowProjection } from "@/lib/tasks/orchestrator/projection";
export {
  loadTaskAggregate,
  refreshTaskAggregateForTx,
  fenceState,
  mapFenceResultToOrchestratorResult,
  FENCE_ERROR_CODES,
  type TaskAggregate,
  type FenceResult,
  type FenceErrorCode,
} from "@/lib/tasks/orchestrator/state";
// Backward-compatible re-export: loadTaskStateSnapshot delegates to
// loadTaskAggregate in state.ts. The existing guards/decide/authorize consume
// TaskStateSnapshot, which is structurally compatible with TaskAggregate.
export { loadTaskStateSnapshot as loadTaskState };
export type { TaskWorkflowCommand, OrchestratorResult, OrchestrationDecision, TaskStateSnapshot };
