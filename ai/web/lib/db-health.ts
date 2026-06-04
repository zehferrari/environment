import { existsSync } from "fs";
import { dirname, isAbsolute, resolve } from "path";
import { fileURLToPath } from "url";
import { db } from "@/lib/db";

export type SqliteDbHealth = {
  path: string | null;
  url: string | null;
  outsideWorktree: boolean | null;
  pageCount: number | null;
  freelistCount: number | null;
  freelistRatio: number | null;
  journalMode: string | null;
  lockingMode: string | null;
  busyTimeoutMs: number | null;
  walExists: boolean | null;
  shmExists: boolean | null;
  error: string | null;
};

function normalizeSqliteUrl(raw: string | undefined) {
  if (!raw || !raw.startsWith("file:")) return { url: raw ?? null, path: null };

  const withoutQuery = raw.split("?")[0];
  try {
    if (withoutQuery.startsWith("file://")) {
      return { url: raw, path: fileURLToPath(withoutQuery) };
    }
  } catch {
    // Fall through to the simple Prisma-relative form.
  }

  const filePath = withoutQuery.slice("file:".length);
  if (!filePath) return { url: raw, path: null };
  if (isAbsolute(filePath)) return { url: raw, path: filePath };

  // Prisma resolves relative SQLite URLs from the schema directory.
  return { url: raw, path: resolve(process.cwd(), "prisma", filePath) };
}

function numberValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : value == null ? null : String(value);
}

async function pragmaNumber(name: string) {
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`PRAGMA ${name}`);
  const first = rows[0];
  return first ? numberValue(Object.values(first)[0]) : null;
}

async function pragmaString(name: string) {
  const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`PRAGMA ${name}`);
  const first = rows[0];
  return first ? stringValue(Object.values(first)[0]) : null;
}

export async function getSqliteDbHealth(): Promise<SqliteDbHealth> {
  const { url, path } = normalizeSqliteUrl(process.env.DATABASE_URL);
  const worktree = resolve(process.cwd());
  const outsideWorktree = path ? !resolve(path).startsWith(`${worktree}/`) : null;

  try {
    const [pageCount, freelistCount, journalMode, lockingMode, busyTimeoutMs] = await Promise.all([
      pragmaNumber("page_count"),
      pragmaNumber("freelist_count"),
      pragmaString("journal_mode"),
      pragmaString("locking_mode"),
      pragmaNumber("busy_timeout"),
    ]);

    const ratio = pageCount && freelistCount != null ? freelistCount / pageCount : null;
    return {
      path,
      url,
      outsideWorktree,
      pageCount,
      freelistCount,
      freelistRatio: ratio,
      journalMode,
      lockingMode,
      busyTimeoutMs,
      walExists: path ? existsSync(`${path}-wal`) : null,
      shmExists: path ? existsSync(`${path}-shm`) : null,
      error: null,
    };
  } catch (err) {
    return {
      path,
      url,
      outsideWorktree,
      pageCount: null,
      freelistCount: null,
      freelistRatio: null,
      journalMode: null,
      lockingMode: null,
      busyTimeoutMs: null,
      walExists: path ? existsSync(`${path}-wal`) : null,
      shmExists: path ? existsSync(`${path}-shm`) : null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatFreelistRatio(ratio: number | null) {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;
}

export function compactDbPath(path: string | null) {
  if (!path) return "unknown";
  const parent = dirname(path);
  return `${parent.split("/").slice(-3).join("/")}/${path.split("/").pop()}`;
}
