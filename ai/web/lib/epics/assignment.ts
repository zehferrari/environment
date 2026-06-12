import type { Prisma } from "@prisma/client";

export const ACTIVE_TASK_ASSIGNMENT_STATUSES = ["To Do", "In Progress"] as const;

export async function findAvailableEpicWorker(
  tx: Prisma.TransactionClient,
  args: {
    epicId: string;
    projectId: string;
    excludeUserIds?: Array<string | null | undefined>;
  },
) {
  const excluded = new Set(args.excludeUserIds?.filter(Boolean) as string[]);
  const workers = await tx.epicWorker.findMany({
    where: {
      epicId: args.epicId,
      user: {
        is: {
          status: "active",
          kind: "agent",
          agent: { is: { role: "coding", deactivatedAt: null } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
    select: {
      userId: true,
      user: { select: { username: true } },
    },
  });

  for (const worker of workers) {
    if (excluded.has(worker.userId)) continue;
    const activeInProject = await tx.task.count({
      where: {
        projectId: args.projectId,
        assigneeId: worker.userId,
        archivedAt: null,
        deletedAt: null,
        status: { in: [...ACTIVE_TASK_ASSIGNMENT_STATUSES] },
      },
    });
    if (activeInProject === 0) {
      return {
        id: worker.userId,
        username: worker.user.username,
      };
    }
  }

  return null;
}

export async function assignFirstOpenEpicTask(
  tx: Prisma.TransactionClient,
  args: {
    epicId: string;
    projectId: string;
    actorUserId: string;
    excludeUserIds?: Array<string | null | undefined>;
    via: string;
  },
) {
  const activeAssigned = await tx.task.findFirst({
    where: {
      epicId: args.epicId,
      parentTaskId: null,
      archivedAt: null,
      deletedAt: null,
      assigneeId: { not: null },
      status: { in: [...ACTIVE_TASK_ASSIGNMENT_STATUSES] },
    },
    select: { id: true, assigneeId: true },
  });
  if (activeAssigned) {
    return { task: null, worker: null, skipped: "active_task_already_assigned" as const };
  }

  const task = await tx.task.findFirst({
    where: {
      epicId: args.epicId,
      parentTaskId: null,
      archivedAt: null,
      deletedAt: null,
      status: "To Do",
    },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      actingManagerId: true,
      project: { select: { slug: true } },
    },
  });
  if (!task) return { task: null, worker: null, skipped: "no_todo_task" as const };

  const worker = await findAvailableEpicWorker(tx, {
    epicId: args.epicId,
    projectId: args.projectId,
    excludeUserIds: args.excludeUserIds,
  });
  if (!worker) {
    await tx.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: task.id,
        userId: args.actorUserId,
        kind: "task.workflow.next_assignment_skipped",
        payload: JSON.stringify({
          reason: "no_available_epic_worker",
          epicId: args.epicId,
          via: args.via,
        }),
      },
    });
    return { task: null, worker: null, skipped: "no_available_epic_worker" as const };
  }

  await tx.task.update({
    where: { id: task.id },
    data: { assigneeId: worker.id, approvedOn: null, approvedById: null },
  });
  await tx.activityLog.create({
    data: {
      projectId: args.projectId,
      taskId: task.id,
      userId: args.actorUserId,
      kind: "task.assign",
      payload: JSON.stringify({
        from: null,
        to: worker.username,
        via: args.via,
        epicId: args.epicId,
      }),
    },
  });
  await tx.activityLog.create({
    data: {
      projectId: args.projectId,
      taskId: task.id,
      userId: args.actorUserId,
      kind: "task.action_plan.reset",
      payload: JSON.stringify({
        reason: "epic_sequential_assignment",
        via: args.via,
        epicId: args.epicId,
      }),
    },
  });

  return { task, worker, skipped: null };
}
