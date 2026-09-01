import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";

type DbClient = Prisma.TransactionClient | typeof db;

export type StartConflict = {
  kind: "wip" | "branch";
  activeTask: { id: string; title: string; workItemKey?: string | null };
};

// Shared entry gate for In Progress: both the advisory auto-start selector and
// the authoritative transaction aggregate must resolve conflicts identically.
// Keeping this query outside either caller prevents the two start paths from
// drifting on work-item-key branch fallbacks again.
export async function findInProgressStartConflict(
  client: DbClient,
  args: {
    taskId: string;
    projectId: string;
    assigneeId: string | null;
    candidateBranch: string | null;
  },
): Promise<StartConflict | null> {
  if (args.assigneeId) {
    const activeTask = await client.task.findFirst({
      where: {
        id: { not: args.taskId },
        projectId: args.projectId,
        assigneeId: args.assigneeId,
        status: "In Progress",
        archivedAt: null,
        deletedAt: null,
      },
      orderBy: [{ statusChangedAt: "asc" }, { updatedAt: "asc" }],
      select: { id: true, title: true, workItemKey: true },
    });
    if (activeTask) return { kind: "wip", activeTask };
  }

  if (!args.candidateBranch) return null;

  const branchPeers = await client.task.findMany({
    where: {
      id: { not: args.taskId },
      projectId: args.projectId,
      status: "In Progress",
      archivedAt: null,
      deletedAt: null,
    },
    select: {
      id: true,
      title: true,
      workItemKey: true,
      branchName: true,
      epic: { select: { workItemKey: true, branchName: true } },
    },
  });
  const branchClash = branchPeers.find(
    (peer) => effectiveTaskBranchName(peer) === args.candidateBranch,
  );
  if (!branchClash) return null;

  return {
    kind: "branch",
    activeTask: {
      id: branchClash.id,
      title: branchClash.title,
      workItemKey: branchClash.workItemKey,
    },
  };
}
