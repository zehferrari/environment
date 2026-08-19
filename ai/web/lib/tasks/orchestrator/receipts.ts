// Phase E §6 — Durable command receipts and canonical request fingerprints.
//
// TaskWorkflowCommandReceipt is the single replay authority. The ActivityLog
// substring scan (payload contains idempotencyKey) is removed, not retained
// as a shadow arbiter, because a `contains` match on serialized JSON is not
// an exact-correlation check.
//
// Receipt execution algorithm (§6.3):
//   1. look up (taskId, idempotencyKey);
//   2. if found with the same fingerprint, return its stored result (replay);
//   3. if found with a different fingerprint, return idempotency_conflict;
//   4. ... transition + intent writes succeed ...
//   5. create the receipt with the exact result;
//   6. commit.
//
// The unique index [taskId, idempotencyKey] is the final race arbiter. On
// collision (P2002), re-read the winner and apply the same/different
// fingerprint rule. Rejected commands are NOT stored; operational failures
// that roll back leave no durable receipt.

import { createHash } from "crypto";
import type { Prisma } from "@prisma/client";
import type { TaskWorkflowCommand, OrchestratorResult } from "@/lib/tasks/orchestrator/types";

// --- Domain error code (no HTTP status — transport mapping is Phase E step 2) ---

export const IDEMPOTENCY_CONFLICT = "idempotency_conflict" as const;

export type ReceiptOutcome =
  | { kind: "replay"; result: OrchestratorResult }
  | { kind: "conflict"; code: typeof IDEMPOTENCY_CONFLICT; existingFingerprint: string }
  | { kind: "create"; receiptId: string }
  | { kind: "race_replay"; result: OrchestratorResult }
  | { kind: "race_conflict"; code: typeof IDEMPOTENCY_CONFLICT };

// --- Canonical JSON helpers ------------------------------------------------

/**
 * Recursively sort object keys and normalize undefined to null.
 * Produces a deterministic JSON string suitable for hashing.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortAndNormalize(value));
}

function sortAndNormalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map(sortAndNormalize);
  }
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = sortAndNormalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

// --- Fingerprint input type -----------------------------------------------

export type FingerprintInput = {
  taskId: string;
  intent: string;
  actorId: string;
  actorKind: string;
  expectedWorkflowVersion: number;
  cycleId: string | null;
  leaseId: string | null;
  procedureRunId: string | null;
  jobId: string | null;
  normalizedPayload: string | null;
  normalizedEvidence: string | null;
  normalizedExecutionContext: string | null;
  source: string;
  messageId: string | null;
};

/**
 * Build the canonical fingerprint input from a TaskWorkflowCommand.
 * Excludes volatile server-generated timestamps, secrets, and raw auth tokens.
 * Absent optional fields normalize to null.
 */
export function buildFingerprintInput(command: TaskWorkflowCommand): FingerprintInput {
  const evidence = command.evidence ?? {};

  // Extract ID-like fields from evidence, normalizing absent to null.
  const leaseId = typeof evidence.leaseId === "string" ? evidence.leaseId : null;
  const procedureRunId = typeof evidence.procedureRunId === "string" ? evidence.procedureRunId : null;
  const jobId = typeof evidence.jobId === "string" ? evidence.jobId : null;

  // Normalized payload: sorted-key canonical JSON, or null if absent.
  const normalizedPayload = command.payload
    ? canonicalize(command.payload)
    : null;

  // Normalized evidence: sorted-key canonical JSON of the full evidence
  // object, or null if no evidence. This includes both keys and values so
  // that commands with different evidence (e.g. different candidateSha,
  // baseSha, leaseId) produce different fingerprints.
  const normalizedEvidence = Object.keys(evidence).length > 0 ? canonicalize(evidence) : null;

  return {
    taskId: command.taskId,
    intent: command.intent,
    actorId: command.actor.id,
    actorKind: command.actor.kind,
    expectedWorkflowVersion: command.expectedWorkflowVersion,
    cycleId: command.workflowCycleId ?? null,
    leaseId,
    procedureRunId,
    jobId,
    normalizedPayload,
    normalizedEvidence,
    normalizedExecutionContext: command.executionContext
      ? canonicalize(command.executionContext)
      : null,
    source: command.source,
    messageId: command.messageId ?? null,
  };
}

/**
 * Compute the canonical request fingerprint (Phase E §6.2).
 *
 * SHA-256 over sorted-key canonical JSON containing: task ID, intent,
 * authenticated actor ID and actor kind, expected workflow version, targeted
 * cycle/lease/procedure/job IDs, normalized payload, normalized evidence
 * identifiers, source, and message ID.
 *
 * Identical logical commands produce identical fingerprints; any field
 * difference produces a different fingerprint. No secrets or raw auth tokens
 * appear in the fingerprint input.
 */
export function computeRequestFingerprint(command: TaskWorkflowCommand): string {
  const input = buildFingerprintInput(command);
  const canonical = canonicalize(input);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// --- Receipt serialization ------------------------------------------------

/**
 * Serialize an OrchestratorResult into the bounded canonical JSON stored in
 * the receipt's `result` column. The receipt holds the serialized
 * OrchestratorResult projection (status, transitionId, workflowVersion,
 * cycleId, procedureId) so an exact replay returns an identical response
 * rather than a reconstructed one.
 */
export function serializeResult(result: OrchestratorResult): string {
  return canonicalize(result);
}

/**
 * Deserialize the stored result JSON back into an OrchestratorResult.
 */
export function deserializeResult(stored: string): OrchestratorResult {
  return JSON.parse(stored) as OrchestratorResult;
}

// --- Receipt create / replay / conflict -----------------------------------

/**
 * Find or create a durable command receipt inside the workflow transaction.
 * This is the single entry point for receipt management.
 *
 * Algorithm (§6.3):
 *   1. Look up (taskId, idempotencyKey).
 *   2. If found with the same fingerprint → return stored result (exact replay, no writes).
 *   3. If found with a different fingerprint → return idempotency_conflict (no writes).
 *   4. If no existing receipt → create one atomically within the transaction.
 *   5. On P2002 (unique constraint collision), re-read the winner and apply
 *      the same/different fingerprint rule.
 *
 * Must be called AFTER transition + intent writes succeed, BEFORE commit.
 * Rejected commands are not stored; operational failures that roll back
 * do not leave a durable receipt.
 */
export async function findOrCreateReceipt(
  tx: Prisma.TransactionClient,
  command: TaskWorkflowCommand,
  fingerprint: string,
  result: OrchestratorResult,
  opts: {
    workflowCycleId?: string | null;
    transitionId?: string | null;
    procedureRunId?: string | null;
    decisionActorId?: string | null;
    executorActorId?: string | null;
  },
): Promise<ReceiptOutcome> {
  // Step 1: look up existing receipt by (taskId, idempotencyKey).
  const existing = await tx.taskWorkflowCommandReceipt.findUnique({
    where: {
      taskId_idempotencyKey: {
        taskId: command.taskId,
        idempotencyKey: command.idempotencyKey,
      },
    },
    select: {
      id: true,
      requestFingerprint: true,
      result: true,
      status: true,
    },
  });

  if (existing) {
    // Step 2: same fingerprint → exact replay.
    if (existing.requestFingerprint === fingerprint) {
      return {
        kind: "replay",
        result: deserializeResult(existing.result),
      };
    }
    // Step 3: different fingerprint → idempotency_conflict.
    return {
      kind: "conflict",
      code: IDEMPOTENCY_CONFLICT,
      existingFingerprint: existing.requestFingerprint,
    };
  }

  // Step 4: no existing receipt → create one.
  const resultingWorkflowVersion =
    "workflowVersion" in result ? result.workflowVersion : command.expectedWorkflowVersion;

  const receiptStatus = result.status === "accepted" ? "accepted" : "completed";

  try {
    const created = await tx.taskWorkflowCommandReceipt.create({
      data: {
        taskId: command.taskId,
        workflowCycleId: opts.workflowCycleId ?? null,
        idempotencyKey: command.idempotencyKey,
        requestFingerprint: fingerprint,
        intent: command.intent,
        source: command.source,
        actorUserId: command.actor.id,
        decisionActorId: opts.decisionActorId ?? null,
        executorActorId: opts.executorActorId ?? null,
        expectedWorkflowVersion: command.expectedWorkflowVersion,
        resultingWorkflowVersion,
        transitionId: opts.transitionId ?? null,
        procedureRunId: opts.procedureRunId ?? null,
        status: receiptStatus,
        result: serializeResult(result),
      },
    });
    return { kind: "create", receiptId: created.id };
  } catch (error) {
    // Step 5: P2002 → re-read the winner and apply same/different fingerprint rule.
    if (isPrismaUniqueConstraintError(error)) {
      const winner = await tx.taskWorkflowCommandReceipt.findUnique({
        where: {
          taskId_idempotencyKey: {
            taskId: command.taskId,
            idempotencyKey: command.idempotencyKey,
          },
        },
        select: {
          id: true,
          requestFingerprint: true,
          result: true,
        },
      });
      if (winner) {
        if (winner.requestFingerprint === fingerprint) {
          return {
            kind: "race_replay",
            result: deserializeResult(winner.result),
          };
        }
        return {
          kind: "race_conflict",
          code: IDEMPOTENCY_CONFLICT,
        };
      }
    }
    throw error;
  }
}

// --- Helpers --------------------------------------------------------------

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
