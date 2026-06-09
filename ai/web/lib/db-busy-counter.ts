// In-process SQLITE_BUSY / "database is locked" counter (ENV-27/ZL-001).
//
// SQLite serializes writers; under contention Prisma surfaces "database is
// locked" / SQLITE_BUSY errors. We have no metric for how often that happens,
// so this module classifies db error messages and keeps a lightweight running
// count surfaced on System → Activity. Process-local and best-effort — it
// resets on restart, which is fine for an operator "is this getting worse"
// signal.

export type DbBusyStats = {
  lockErrors: number;
  lastLockAt: string | null;
  lastMessage: string | null;
};

const LOCK_PATTERN = /database is locked|database table is locked|SQLITE_BUSY/i;

const stats: DbBusyStats = {
  lockErrors: 0,
  lastLockAt: null,
  lastMessage: null,
};

export function isLockError(message: string | null | undefined): boolean {
  if (!message) return false;
  return LOCK_PATTERN.test(message);
}

/** Record a db error message. Returns true when it was a lock/busy error. */
export function recordDbError(message: string | null | undefined): boolean {
  if (!isLockError(message)) return false;
  stats.lockErrors += 1;
  stats.lastLockAt = new Date().toISOString();
  stats.lastMessage = (message ?? "").slice(0, 300);
  return true;
}

export function getDbBusyStats(): DbBusyStats {
  return { ...stats };
}
