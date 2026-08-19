// PHASEE-10 — Structured deduplicated activities.
//
// Provides writeDeduplicatedActivity, a helper that uses a stable dedup key
// and relies on the @@unique([dedupeKey]) partial unique index on ActivityLog
// for DB-enforced deduplication under the concurrent procedure runner.
// Replay of the same failure produces exactly one activity row — enforced by
// the DB unique constraint, not read-then-write.

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

/**
 * Compute a stable dedup key from kind + taskId + payload.
 * Uses a simple hash to keep the key short and deterministic.
 */
export function computeActivityDedupeKey(
  kind: string,
  taskId: string | null,
  payload: Record<string, unknown>,
): string {
  const payloadJson = JSON.stringify(payload, Object.keys(payload).sort());
  // Simple FNV-1a hash for deterministic, short keys.
  let hash = 0x811c9dc5;
  const str = `${kind}:${taskId ?? "null"}:${payloadJson}`;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `${kind}:${taskId ?? "null"}:${hash.toString(16)}`;
}

/**
 * Write an ActivityLog row with a dedupeKey. If a row with that dedupeKey
 * already exists (unique constraint violation), silently return without
 * creating a duplicate — the DB unique constraint enforces this.
 *
 * This is safe under concurrent writers: two concurrent calls with the same
 * dedupeKey will result in exactly one row, not a read-then-write race.
 */
export async function writeDeduplicatedActivity(args: {
  taskId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  targetAgent?: string | null;
  targetFile?: string | null;
  client?: Prisma.TransactionClient | typeof db;
}): Promise<void> {
  const client = args.client ?? db;
  const data = {
    projectId: args.projectId ?? null,
    taskId: args.taskId ?? null,
    userId: args.userId ?? null,
    kind: args.kind,
    payload: JSON.stringify(args.payload),
    dedupeKey: args.dedupeKey,
    targetAgent: args.targetAgent ?? null,
    targetFile: args.targetFile ?? null,
  };
  try {
    await client.activityLog.create({ data });
  } catch (error: unknown) {
    // Prisma unique constraint violation (P2002) means the row already exists
    // — this is the expected dedup behaviour, not an error.
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "P2002"
    ) {
      return;
    }
    // Re-throw unexpected errors.
    throw error;
  }
}