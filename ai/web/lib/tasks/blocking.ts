// Task hard-dependency ("blocked_by") validation (ENV-62).
//
// A task may declare one blocker — another task that must reach Done before this
// one is actionable. The only real hazard is a dependency cycle (A blocked_by B
// blocked_by … blocked_by A), which would deadlock the board. validateBlockedBy
// proves the new edge is safe: the blocker exists, lives in the same project,
// isn't the task itself, and does not already depend (transitively) on the task.

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

type Client = Prisma.TransactionClient | typeof db;

export type BlockedByCode = "SELF" | "NOT_FOUND" | "WRONG_PROJECT" | "CYCLE";
export type BlockedByResult = { ok: true } | { ok: false; code: BlockedByCode; message: string };

export async function validateBlockedBy(args: {
  taskId: string;
  projectId: string;
  blockerId: string;
  client?: Client;
}): Promise<BlockedByResult> {
  const client = args.client ?? db;
  if (args.blockerId === args.taskId) {
    return { ok: false, code: "SELF", message: "A task cannot be blocked by itself." };
  }
  const blocker = await client.task.findUnique({
    where: { id: args.blockerId },
    select: { id: true, projectId: true, deletedAt: true },
  });
  if (!blocker || blocker.deletedAt) {
    return { ok: false, code: "NOT_FOUND", message: "Blocking task not found." };
  }
  if (blocker.projectId !== args.projectId) {
    return { ok: false, code: "WRONG_PROJECT", message: "Blocking task must be in the same project." };
  }
  // Walk the blocker's own blocked-by chain; reaching taskId means this new edge
  // would close a cycle. `seen` guards against any pre-existing cycle.
  let current: string | null = args.blockerId;
  const seen = new Set<string>();
  while (current) {
    if (current === args.taskId) {
      return {
        ok: false,
        code: "CYCLE",
        message: "That would create a circular block — the chosen task already depends on this one.",
      };
    }
    if (seen.has(current)) break;
    seen.add(current);
    const row: { blockedById: string | null } | null = await client.task.findUnique({
      where: { id: current },
      select: { blockedById: true },
    });
    current = row?.blockedById ?? null;
  }
  return { ok: true };
}
