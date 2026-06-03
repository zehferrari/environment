import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

const PREFIX_RE = /^\s*\d+\.\s+/;

export function stripEpicTaskNumber(title: string) {
  return title.replace(PREFIX_RE, "").trim();
}

export async function nextEpicTaskTitle(
  epicId: string,
  title: string,
  tx: Pick<Prisma.TransactionClient, "task"> = db,
) {
  const base = stripEpicTaskNumber(title);
  const count = await tx.task.count({
    where: {
      epicId,
      parentTaskId: null,
      archivedAt: null,
      deletedAt: null,
    },
  });
  return `${count + 1}. ${base}`;
}
