import { db } from "@/lib/db";

type Repair = {
  scope: "task" | "epic";
  id: string;
  title: string;
  field: "reporterId" | "assigneeId" | "actingManagerId";
  agentUsername: string;
  action: "cleared";
};

async function latestActivityUser(args: {
  taskId?: string;
  projectId?: string;
  payloadContains?: string;
  kinds: string[];
}) {
  const row = await db.activityLog.findFirst({
    where: {
      ...(args.taskId ? { taskId: args.taskId } : {}),
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.payloadContains ? { payload: { contains: args.payloadContains } } : {}),
      kind: { in: args.kinds },
    },
    orderBy: { createdAt: "desc" },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

async function main() {
  const monitor = await db.user.findFirst({
    where: {
      status: "active",
      kind: "agent",
      agent: { is: { role: "monitor", deactivatedAt: null } },
    },
    select: { id: true },
  }) ?? await db.user.findFirst({
    where: { username: "zeh", status: "active" },
    select: { id: true },
  });
  if (!monitor) throw new Error("No monitor/human user available for self-assignment guard logs");

  const repairs: Repair[] = [];

  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      OR: [
        { reporter: { is: { kind: "agent" } } },
        { assignee: { is: { kind: "agent" } } },
        { actingManager: { is: { kind: "agent" } } },
      ],
    },
    select: {
      id: true,
      title: true,
      projectId: true,
      reporterId: true,
      assigneeId: true,
      actingManagerId: true,
      reporter: { select: { username: true, kind: true } },
      assignee: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
    },
  });

  for (const task of tasks) {
    const data: { reporterId?: null; assigneeId?: null; actingManagerId?: null } = {};
    const localRepairs: Repair[] = [];
    if (task.reporterId && task.reporter?.kind === "agent") {
      data.reporterId = null;
      localRepairs.push({
        scope: "task",
        id: task.id,
        title: task.title,
        field: "reporterId",
        agentUsername: task.reporter.username,
        action: "cleared",
      });
    }
    if (
      task.assigneeId &&
      task.assignee?.kind === "agent" &&
      await latestActivityUser({ taskId: task.id, kinds: ["task.assign"] }) === task.assigneeId
    ) {
      data.assigneeId = null;
      localRepairs.push({
        scope: "task",
        id: task.id,
        title: task.title,
        field: "assigneeId",
        agentUsername: task.assignee.username,
        action: "cleared",
      });
    }
    if (
      task.actingManagerId &&
      task.actingManager?.kind === "agent" &&
      await latestActivityUser({ taskId: task.id, kinds: ["task.acting_manager"] }) === task.actingManagerId
    ) {
      data.actingManagerId = null;
      localRepairs.push({
        scope: "task",
        id: task.id,
        title: task.title,
        field: "actingManagerId",
        agentUsername: task.actingManager.username,
        action: "cleared",
      });
    }
    if (Object.keys(data).length > 0) {
      await db.$transaction([
        db.task.update({ where: { id: task.id }, data }),
        db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: monitor.id,
            kind: "pm.self_assignment_guard",
            payload: JSON.stringify({ repairs: localRepairs }),
          },
        }),
      ]);
      repairs.push(...localRepairs);
    }
  }

  const epics = await db.epic.findMany({
    where: {
      deletedAt: null,
      OR: [
        { reporter: { is: { kind: "agent" } } },
        { actingManager: { is: { kind: "agent" } } },
      ],
    },
    select: {
      id: true,
      title: true,
      projectId: true,
      reporterId: true,
      actingManagerId: true,
      reporter: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
    },
  });

  for (const epic of epics) {
    const data: { reporterId?: null; actingManagerId?: null } = {};
    const localRepairs: Repair[] = [];
    if (epic.reporterId && epic.reporter?.kind === "agent") {
      data.reporterId = null;
      localRepairs.push({
        scope: "epic",
        id: epic.id,
        title: epic.title,
        field: "reporterId",
        agentUsername: epic.reporter.username,
        action: "cleared",
      });
    }
    if (
      epic.actingManagerId &&
      epic.actingManager?.kind === "agent" &&
      await latestActivityUser({
        projectId: epic.projectId,
        payloadContains: epic.id,
        kinds: ["epic.acting_manager"],
      }) === epic.actingManagerId
    ) {
      data.actingManagerId = null;
      localRepairs.push({
        scope: "epic",
        id: epic.id,
        title: epic.title,
        field: "actingManagerId",
        agentUsername: epic.actingManager.username,
        action: "cleared",
      });
    }
    if (Object.keys(data).length > 0) {
      await db.$transaction([
        db.epic.update({ where: { id: epic.id }, data }),
        db.activityLog.create({
          data: {
            projectId: epic.projectId,
            userId: monitor.id,
            kind: "pm.self_assignment_guard",
            payload: JSON.stringify({ repairs: localRepairs }),
          },
        }),
      ]);
      repairs.push(...localRepairs);
    }
  }

  console.log(JSON.stringify({ ok: true, repairCount: repairs.length, repairs }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect();
    process.exit(1);
  });
