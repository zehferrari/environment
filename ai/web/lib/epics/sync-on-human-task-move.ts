import type { Prisma } from "@prisma/client";

// Human task moves are authoritative, but they must not leave an actionable
// child under a closed parent Epic. Agents are deliberately excluded: they
// cannot change Epic status and still pass through the normal workflow gates.
//
// Reopening to To Do preserves the approved-and-queued state. Entering
// In Progress or Review means work/review is already active, so the parent is
// In Progress. The compare-and-update guard makes repeated calls idempotent.
export async function syncEpicOnHumanTaskStatus(
  client: Prisma.TransactionClient,
  args: {
    epicId: string | null | undefined;
    projectId: string;
    taskId: string;
    actorId: string;
    actorKind: "human" | "agent";
    targetStatus: string;
    via: string;
  },
): Promise<boolean> {
  if (args.actorKind !== "human" || !args.epicId) return false;

  const desiredEpicStatus =
    args.targetStatus === "To Do"
      ? "To Do"
      : args.targetStatus === "In Progress" || args.targetStatus === "Review"
        ? "In Progress"
        : null;
  if (!desiredEpicStatus) return false;

  const epic = await client.epic.findUnique({
    where: { id: args.epicId },
    select: { id: true, status: true },
  });
  if (!epic) return false;

  const shouldSync =
    epic.status === "Done" ||
    (epic.status === "To Do" && desiredEpicStatus === "In Progress");
  if (!shouldSync || epic.status === desiredEpicStatus) return false;

  const now = new Date();
  const updated = await client.epic.updateMany({
    where: { id: epic.id, status: epic.status },
    data: { status: desiredEpicStatus, statusChangedAt: now },
  });
  if (updated.count !== 1) return false;

  await client.activityLog.create({
    data: {
      projectId: args.projectId,
      taskId: args.taskId,
      userId: args.actorId,
      kind: "epic.status",
      payload: JSON.stringify({
        epicId: epic.id,
        from: epic.status,
        to: desiredEpicStatus,
        via: args.via,
        action: epic.status === "Done"
          ? "child_task_reopened"
          : "child_task_started",
        taskId: args.taskId,
        taskStatus: args.targetStatus,
      }),
    },
  });
  return true;
}
