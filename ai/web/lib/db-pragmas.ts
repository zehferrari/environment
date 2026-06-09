// Runtime SQLite pragmas enforced once per PrismaClient init (ENV-27/ZL-001).
//
// Prisma does not pin journal_mode or busy_timeout for us, so a fresh
// connection defaults to busy_timeout=0 and whatever journal the file was last
// left in. We run these on first init so every PM process gets WAL + a real
// lock wait window. Keep this list pure/declarative so it can be unit-tested
// without a live database.

export type SqlitePragma = {
  /** Pragma name as reported back by PRAGMA <name> (used for verification). */
  name: string;
  /** Desired value, normalized lowercase for string comparisons. */
  expected: string;
  /** Full statement executed at connection time. */
  statement: string;
};

export const SQLITE_RUNTIME_PRAGMAS: readonly SqlitePragma[] = [
  { name: "journal_mode", expected: "wal", statement: "PRAGMA journal_mode=WAL" },
  { name: "busy_timeout", expected: "5000", statement: "PRAGMA busy_timeout=5000" },
  { name: "synchronous", expected: "1", statement: "PRAGMA synchronous=NORMAL" },
  { name: "wal_autocheckpoint", expected: "1000", statement: "PRAGMA wal_autocheckpoint=1000" },
];

export function pragmaStatements(): string[] {
  return SQLITE_RUNTIME_PRAGMAS.map((p) => p.statement);
}
