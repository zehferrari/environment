// Bounded SQLite maintenance for PM (ENV-27/ZL-001).
//
// Checkpoint the WAL, run PRAGMA optimize, and VACUUM *only* when the freelist
// has grown past a threshold — VACUUM rewrites the whole file and blocks
// writers, so we don't want a cron doing it on every pass. Intended to be
// driven by an admin/loopback-guarded endpoint that a host cron calls.

import { db } from "@/lib/db";
import { getSqliteDbHealth } from "@/lib/db-health";

// VACUUM is expensive and blocks writers; only reclaim when freelist pages are a
// meaningful share of the file.
export const VACUUM_FREELIST_RATIO_THRESHOLD = 0.25;

export function shouldVacuum(
  freelistRatio: number | null,
  threshold: number = VACUUM_FREELIST_RATIO_THRESHOLD,
): boolean {
  if (freelistRatio == null) return false;
  return freelistRatio > threshold;
}

export type DbMaintenanceResult = {
  startedAt: string;
  durationMs: number;
  checkpoint: { busy: number; logPages: number; checkpointedPages: number } | null;
  optimized: boolean;
  vacuumed: boolean;
  freelistRatioBefore: number | null;
  pageCountBefore: number | null;
  pageCountAfter: number | null;
  pagesReclaimed: number | null;
  error: string | null;
};

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function runDbMaintenance(
  threshold: number = VACUUM_FREELIST_RATIO_THRESHOLD,
): Promise<DbMaintenanceResult> {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const before = await getSqliteDbHealth();

  const result: DbMaintenanceResult = {
    startedAt,
    durationMs: 0,
    checkpoint: null,
    optimized: false,
    vacuumed: false,
    freelistRatioBefore: before.freelistRatio,
    pageCountBefore: before.pageCount,
    pageCountAfter: null,
    pagesReclaimed: null,
    error: null,
  };

  try {
    // PRAGMA wal_checkpoint(TRUNCATE) returns one row: busy, log, checkpointed.
    const checkpointRows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    );
    const row = checkpointRows[0];
    if (row) {
      const values = Object.values(row);
      result.checkpoint = {
        busy: num(values[0]),
        logPages: num(values[1]),
        checkpointedPages: num(values[2]),
      };
    }

    await db.$executeRawUnsafe("PRAGMA optimize");
    result.optimized = true;

    if (shouldVacuum(before.freelistRatio, threshold)) {
      await db.$executeRawUnsafe("VACUUM");
      result.vacuumed = true;
      const after = await getSqliteDbHealth();
      result.pageCountAfter = after.pageCount;
      if (before.pageCount != null && after.pageCount != null) {
        result.pagesReclaimed = before.pageCount - after.pageCount;
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.durationMs = Date.now() - start;
  return result;
}
