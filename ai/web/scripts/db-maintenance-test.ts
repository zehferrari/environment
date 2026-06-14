import assert from "node:assert/strict";
import { pragmaStatements, SQLITE_RUNTIME_PRAGMAS } from "../lib/db-pragmas";
import { shouldVacuum, VACUUM_FREELIST_RATIO_THRESHOLD } from "../lib/db-maintenance";
import { deriveDbHealthWarnings } from "../lib/db-health";
import { isLockError, recordDbError, getDbBusyStats } from "../lib/db-busy-counter";
import { summarizePmLatency, percentile, type PmChannelLatencySource } from "../lib/agents/pm-channel/latency";

// --- Pragma enforcement set ---------------------------------------------------
const statements = pragmaStatements();
assert(statements.some((s) => /journal_mode=WAL/i.test(s)), "must enforce WAL journal_mode");
assert(statements.some((s) => /busy_timeout=5000/i.test(s)), "must enforce a non-zero busy_timeout");
assert.equal(statements.length, SQLITE_RUNTIME_PRAGMAS.length, "every pragma yields one statement");

// --- VACUUM threshold ---------------------------------------------------------
assert.equal(shouldVacuum(null), false, "null freelist never vacuums");
assert.equal(shouldVacuum(0.1), false, "below threshold does not vacuum");
assert.equal(shouldVacuum(VACUUM_FREELIST_RATIO_THRESHOLD), false, "at threshold does not vacuum (strict >)");
assert.equal(shouldVacuum(0.5), true, "well above threshold vacuums");
assert.equal(shouldVacuum(0.05, 0.01), true, "custom threshold respected");

// --- Health warnings ----------------------------------------------------------
assert.deepEqual(
  deriveDbHealthWarnings({ journalMode: "wal", busyTimeoutMs: 5000, freelistRatio: 0.01 }),
  [],
  "healthy db produces no warnings",
);
const warned = deriveDbHealthWarnings({ journalMode: "delete", busyTimeoutMs: 0, freelistRatio: 0.9 });
const codes = warned.map((w) => w.code).sort();
assert.deepEqual(codes, ["busy-timeout-zero", "freelist-high", "journal-not-wal"], "all three warnings fire");
assert.deepEqual(
  deriveDbHealthWarnings({ journalMode: null, busyTimeoutMs: null, freelistRatio: null }),
  [],
  "unknown signals do not warn",
);
assert.equal(
  deriveDbHealthWarnings({ journalMode: "WAL", busyTimeoutMs: 5000, freelistRatio: 0 }).length,
  0,
  "uppercase WAL is accepted",
);

// --- Lock/busy classification + counter --------------------------------------
assert.equal(isLockError("Error: database is locked"), true);
assert.equal(isLockError("SQLITE_BUSY: the database file is locked"), true);
assert.equal(isLockError("syntax error near ON"), false);
assert.equal(isLockError(null), false);
const before = getDbBusyStats().lockErrors;
assert.equal(recordDbError("database is locked"), true, "lock error is recorded");
assert.equal(recordDbError("not a lock"), false, "non-lock error is ignored");
assert.equal(getDbBusyStats().lockErrors, before + 1, "only lock errors increment");

// --- Percentiles + latency summary -------------------------------------------
assert.equal(percentile([], 0.5), null, "empty percentile is null");
assert.equal(percentile([10], 0.95), 10, "single value percentile");
assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5, "p50 nearest-rank");
assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10, "p95 nearest-rank");

function run(createdMs: number, completedMs: number | null): PmChannelLatencySource {
  return {
    createdAt: new Date(createdMs),
    acceptedAt: null,
    streamingAt: null,
    completedAt: completedMs == null ? null : new Date(completedMs),
    failedAt: null,
  };
}
const summary = summarizePmLatency([
  run(0, 100),
  run(0, 200),
  run(0, 300),
  run(0, null), // in-flight: excluded
]);
assert.equal(summary.count, 3, "in-flight runs excluded from count");
assert.equal(summary.p50Ms, 200, "p50 of 100/200/300");
assert.equal(summary.maxMs, 300, "max span surfaced");

const empty = summarizePmLatency([]);
assert.deepEqual(empty, { count: 0, p50Ms: null, p95Ms: null, maxMs: null }, "empty summary is null-safe");

// --- Live pragma enforcement against a real temp SQLite DB --------------------
// Guards the ENV-27 regression: the pure statement list above can look correct
// while runtime enforcement silently fails (e.g. journal_mode=WAL returns a row
// and aborts the loop under $executeRawUnsafe). This asserts the pragmas are
// actually observed on a fresh connection.
async function assertLivePragmas(): Promise<void> {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dbPath = path.join(os.tmpdir(), `env-pragma-test-${process.pid}-${Date.now()}.db`);
  process.env.DATABASE_URL = `file:${dbPath}`;
  const { db, ensureSqlitePragmas } = await import("../lib/db");
  try {
    await ensureSqlitePragmas();
    const journal = (await db.$queryRawUnsafe<{ journal_mode: string }[]>("PRAGMA journal_mode"))[0]?.journal_mode;
    const busy = (await db.$queryRawUnsafe<{ timeout: number | bigint }[]>("PRAGMA busy_timeout"))[0]?.timeout;
    assert.equal(String(journal).toLowerCase(), "wal", "live journal_mode is WAL after init");
    assert.equal(Number(busy), 5000, "live busy_timeout is 5000 after init");
  } finally {
    await db.$disconnect();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(`${dbPath}${suffix}`);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

assertLivePragmas()
  .then(() => {
    console.log("db-maintenance-test: all assertions passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
