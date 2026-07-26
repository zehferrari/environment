import type { Prisma } from "@prisma/client";

// When a child task enters In Progress, its parent epic must reflect that work
// has actually started: a To Do epic is promoted to In Progress (this is the
// epic analogue of a task's To Do → In Progress start). Idempotent — a no-op
// when there is no parent epic or the epic is already past To Do. Accepts a
// transaction client OR the base db client, so callers can run it inside their
// existing status-change transaction.
export async function promoteEpicOnTaskInProgress(
  client: Prisma.TransactionClient,
  args: {
    epicId: string | null | undefined;
    projectId: string;
    actorId: string;
    via: string;
  },
): Promise<boolean> {
  if (!args.epicId) return false;
  const epic = await client.epic.findUnique({
    where: { id: args.epicId },
    select: { id: true, status: true },
  });
  if (!epic || epic.status !== "To Do") return false;
  const now = new Date();
  await client.epic.update({
    where: { id: epic.id },
    data: { status: "In Progress", statusChangedAt: now },
  });
  await client.activityLog.create({
    data: {
      projectId: args.projectId,
      userId: args.actorId,
      kind: "epic.status",
      payload: JSON.stringify({
        epicId: epic.id,
        from: "To Do",
        to: "In Progress",
        via: args.via,
        action: "child_task_started",
      }),
    },
  });
  return true;
}
