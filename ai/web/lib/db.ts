import { PrismaClient, Prisma } from "@prisma/client";
import { pragmaStatements } from "@/lib/db-pragmas";
import { recordDbError } from "@/lib/db-busy-counter";

declare global {
  var __prisma: PrismaClient | undefined;
  var __prismaPragmasApplied: boolean | undefined;
  var __prismaPragmasPromise: Promise<void> | undefined;
}

function createClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? [
            { level: "query", emit: "stdout" },
            { level: "warn", emit: "stdout" },
            { level: "error", emit: "event" },
          ]
        : [{ level: "error", emit: "event" }],
  });

  // Keep prior behavior (errors visible on stdout) while also feeding the
  // SQLITE_BUSY/lock counter surfaced on System → Activity.
  client.$on("error" as never, (event: Prisma.LogEvent) => {
    recordDbError(event.message);
    console.error("[prisma]", event.message);
  });

  return client;
}

export const db: PrismaClient = global.__prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = db;
}

// Pin WAL + a real busy_timeout once per process. Prisma leaves journal_mode and
// busy_timeout at their file/connection defaults otherwise (ENV-27/ZL-001). Fire
// once, guarded by a global so HMR re-imports don't re-run it.
export async function ensureSqlitePragmas(): Promise<void> {
  if (global.__prismaPragmasApplied) return;
  if (global.__prismaPragmasPromise) return global.__prismaPragmasPromise;

  global.__prismaPragmasPromise = (async () => {
    try {
      for (const statement of pragmaStatements()) {
        // Several set-form PRAGMAs (journal_mode, busy_timeout, wal_autocheckpoint)
        // return a row in SQLite, which Prisma's $executeRawUnsafe rejects with
        // P2010 "Execute returned results, which is not allowed in SQLite". Use
        // $queryRawUnsafe so the set still applies whether or not a row comes back.
        await db.$queryRawUnsafe(statement);
      }
      global.__prismaPragmasApplied = true;
    } catch (err) {
      global.__prismaPragmasApplied = false;
      console.error("[prisma] failed to apply SQLite runtime pragmas:", err);
    } finally {
      global.__prismaPragmasPromise = undefined;
    }
  })();
  return global.__prismaPragmasPromise;
}

// Only auto-apply when a database is actually configured. Standalone tsx test
// scripts import lib modules without DATABASE_URL and must not trigger a
// connection attempt on import.
if (process.env.DATABASE_URL) {
  void ensureSqlitePragmas();
}
