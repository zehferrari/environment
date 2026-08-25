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
import { executeWorkflowCommandInTransaction } from "@/lib/tasks/orchestrator/execute";
import { computeRequestFingerprint } from "@/lib/tasks/orchestrator/receipts";
import { validateCommandPayload } from "@/lib/tasks/orchestrator/command-schema";
import { resolveEngineOwnership, ENGINE_LEGACY } from "@/lib/tasks/orchestrator/ownership";
import { refreshTaskAggregateForTx } from "@/lib/tasks/orchestrator/state";
import type { Prisma } from "@prisma/client";
import type {
  DomainErrorCode,
  OrchestrationDecision,
  OrchestratorResult,
  TaskStateSnapshot,
  TaskWorkflowCommand,
} from "@/lib/tasks/orchestrator/types";

function domainCodeFromReason(reason: string, fallback: DomainErrorCode): DomainErrorCode {
  const match = reason.match(/^\[([a-z_]+)\]/);
  return (match?.[1] as DomainErrorCode | undefined) ?? fallback;
}

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
  return submitWorkflowCommandWithClient(db, command, false);
}

/**
 * Submit a canonical workflow command inside a caller-owned transaction.
 * This is intentionally narrow: batch transports receive no alternate
 * mutation API, and a rejected result can be promoted to an exception by the
 * caller so every operation in the batch rolls back together.
 */
export async function submitWorkflowCommandInTransaction(
  tx: Prisma.TransactionClient,
  command: TaskWorkflowCommand,
): Promise<OrchestratorResult> {
  return submitWorkflowCommandWithClient(tx, command, true);
}

async function submitWorkflowCommandWithClient(
  client: Prisma.TransactionClient | typeof db,
  command: TaskWorkflowCommand,
  inTransaction: boolean,
): Promise<OrchestratorResult> {
  const validated = validateCommandPayload(command.intent, command.payload);
  if (!validated.ok) {
    return {
      status: "invalid",
      reason: validated.message,
      domainCode: validated.code,
      ...(validated.details ? { details: validated.details } : {}),
    };
  }
  command = { ...command, payload: validated.payload } as TaskWorkflowCommand;

  const state = inTransaction
    ? await refreshTaskAggregateForTx(client as Prisma.TransactionClient, command.taskId)
    : await loadTaskStateSnapshot(command.taskId);
  if (!state) {
    return { status: "invalid", reason: "Task not found.", domainCode: "invalid_payload" };
  }

  // --- Engine ownership resolution (Phase E §3.2) ----------------------
  // Resolve durable engine ownership BEFORE any writes. This gate runs
  // before guards, decision, and execution so a rejection never mutates.
  // Legacy ownership is retired. Exact receipt replay remains available
  // below for already-accepted V2 commands, but no new mutation may enter
  // the kernel until the task has durable V2 ownership.
  const ownership = await resolveEngineOwnership(client, command.taskId);
  if (!ownership.ok) {
    return {
      status: ownership.code === "task_not_found" ? "invalid" : "stale",
      reason: ownership.reason,
      domainCode: ownership.code === "task_not_found" ? "invalid_payload" : "cycle_mismatch",
    };
  }

  // --- Idempotency replay check (before guards, per kernel semantics) ----
  // TaskWorkflowCommandReceipt is the single replay authority (Phase E §6).
  // The ActivityLog substring scan (payload contains idempotencyKey) is
  // removed because a `contains` match on serialized JSON is not an
  // exact-correlation check and cannot reliably reconstruct the original
  // response. The receipt stores the serialized OrchestratorResult projection
  // so an exact replay returns an identical response.
  //
  const existingReceipt = await client.taskWorkflowCommandReceipt.findUnique({
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
        // Preserve the exact stored disposition/episode projection. Replay
        // changes only the transport status; it never recomputes or drops the
        // execution bookkeeping committed with the command.
        return {
          ...stored,
          status: "replayed",
          transitionId: stored.transitionId,
          workflowVersion: stored.workflowVersion,
          procedureId: stored.procedureId ?? null,
        } as OrchestratorResult;
      }
      return stored;
    }
    // Same key, different payload — idempotency conflict (domain error, not HTTP status).
    return {
      status: "invalid",
      reason: "idempotency_conflict: idempotency key reused with different payload.",
      domainCode: "idempotency_conflict",
    };
  }
  if (ownership.engine === ENGINE_LEGACY) {
    return {
      status: "stale",
      reason: "Legacy workflow mutation ownership is retired.",
      domainCode: "cycle_mismatch",
    };
  }

  // --- Authorize ---------------------------------------------------------
  const auth = authorizeCommand(state, command);
  if (!auth.allowed) {
    const code: DomainErrorCode = auth.reason === "not_assignee"
      ? "not_assignee"
      : auth.reason === "not_reviewer"
        ? "not_reviewer"
        : auth.reason === "not_coding_capable"
          ? "not_coding_capable"
          : "not_authorized";
    return { status: "forbidden", reason: auth.reason, domainCode: code };
  }

  // --- Guards (pure preconditions) --------------------------------------
  const guardResult = runGuards(state, command);
  if (!guardResult.ok) {
    return guardResult.status === "stale"
      ? { status: "stale", reason: guardResult.reason, domainCode: domainCodeFromReason(guardResult.reason, "stale_version") }
      : { status: "invalid", reason: guardResult.reason, domainCode: domainCodeFromReason(guardResult.reason, "invalid_payload") };
  }

  // --- Decide (pure) -----------------------------------------------------
  const decision = decideCommand(state, command, auth);
  if ("status" in decision && decision.status === "invalid") {
    return { status: "invalid", reason: decision.reason, domainCode: domainCodeFromReason(decision.reason, "invalid_payload") };
  }
  const orchestrationDecision = decision as OrchestrationDecision;

  // --- Execute (atomic) --------------------------------------------------
  return inTransaction
    ? executeWorkflowCommandInTransaction(client as Prisma.TransactionClient, command, orchestrationDecision, state)
    : executeWorkflowCommand(command, orchestrationDecision, state);
}

// Re-export the public API so routes can import from a single module.
export { authorizeCommand } from "@/lib/tasks/orchestrator/authorize";
export { runGuards } from "@/lib/tasks/orchestrator/guards";
export { decideCommand } from "@/lib/tasks/orchestrator/decide";
export { executeWorkflowCommand } from "@/lib/tasks/orchestrator/execute";
export { executeWorkflowCommandInTransaction } from "@/lib/tasks/orchestrator/execute";
export {
  getIntentReceiptResolution as getWorkflowTransactionResolution,
  type IntentReceiptResolutionKind as WorkflowTransactionResolutionKind,
} from "@/lib/tasks/orchestrator/intents/shared";
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
