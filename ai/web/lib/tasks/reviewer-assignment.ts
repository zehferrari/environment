import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { ACTIVE_TASK_ASSIGNMENT_STATUSES } from "@/lib/epics/assignment";
import { publishBoardTouch } from "@/lib/pm/board-events";

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

type AssignmentResult =
  | {
      ok: true;
      task: { id: string; title: string; status: string; projectSlug: string };
      assignee: { id: string; username: string };
      movedToTodo: boolean;
    }
  | { ok: false; error: string; status?: number };

async function hasActiveProjectTask(userId: string, projectId: string) {
  const count = await db.task.count({
    where: {
      projectId,
      assigneeId: userId,
      archivedAt: null,
      deletedAt: null,
      status: { in: [...ACTIVE_TASK_ASSIGNMENT_STATUSES] },
    },
  });
  return count > 0;
}

async function eligibleCodingAgent(userId: string, projectId: string, excluded: Set<string>, allowed?: Set<string>) {
  if (excluded.has(userId)) return null;
  if (allowed && !allowed.has(userId)) return null;
  const user = await db.user.findFirst({
    where: {
      id: userId,
      status: "active",
      kind: "agent",
      agent: { is: { role: "coding", deactivatedAt: null } },
    },
    select: { id: true, username: true },
  });
  if (!user) return null;
  return (await hasActiveProjectTask(user.id, projectId)) ? null : user;
}

async function findReviewerAssignedWorker(args: {
  projectId: string;
  defaultAssigneeId: string | null;
  excludedUserIds: Array<string | null | undefined>;
}) {
  const excluded = new Set(args.excludedUserIds.filter(Boolean) as string[]);
  const allowedRows = await db.projectManagerAssignableAgent.findMany({
    where: { projectId: args.projectId },
    select: { userId: true },
  });
  const allowed = allowedRows.length > 0 ? new Set(allowedRows.map((row) => row.userId)) : undefined;
  if (args.defaultAssigneeId) {
    const defaultUser = await eligibleCodingAgent(args.defaultAssigneeId, args.projectId, excluded, allowed);
    if (defaultUser) return defaultUser;
  }

  const users = await db.user.findMany({
    where: {
      status: "active",
      kind: "agent",
      agent: { is: { role: "coding", deactivatedAt: null } },
      id: allowed ? { in: [...allowed], notIn: [...excluded] } : { notIn: [...excluded] },
    },
    orderBy: { username: "asc" },
    select: { id: true, username: true },
  });
  for (const user of users) {
    if (!(await hasActiveProjectTask(user.id, args.projectId))) return user;
  }
  return null;
}

export async function assignTaskAfterPlanApproval(args: {
  taskId: string;
  actor: Actor;
  requireReviewerUserId?: string;
}): Promise<AssignmentResult> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      deletedAt: true,
      project: { select: { slug: true, defaultAssigneeId: true } },
    },
  });
  if (!task || task.deletedAt) {
    return { ok: false, error: "Task not found", status: 404 };
  }
  if (args.requireReviewerUserId && task.actingManagerId !== args.requireReviewerUserId) {
    return { ok: false, error: "Only the assigned task reviewer can assign this unowned task", status: 403 };
  }
  if (!task.approvedOn) {
    return { ok: false, error: "Action Plan must be approved before reviewer assignment", status: 409 };
  }
  if (task.assigneeId) {
    return { ok: false, error: "Task already has an assignee", status: 409 };
  }
  if (task.status !== "Backlog" && task.status !== "To Do") {
    return { ok: false, error: "Task must be in Backlog or To Do for reviewer assignment", status: 409 };
  }

  const assignee = await findReviewerAssignedWorker({
    projectId: task.projectId,
    defaultAssigneeId: task.project.defaultAssigneeId,
    excludedUserIds: [task.actingManagerId, task.reporterId],
  });
  if (!assignee) {
    return { ok: false, error: "No eligible coding agent is currently available for this project", status: 409 };
  }

  const movedToTodo = task.status === "Backlog";
  await db.$transaction(async (tx) => {
    const rank = movedToTodo
      ? await tx.task.aggregate({
          where: { projectId: task.projectId, status: "To Do", archivedAt: null, deletedAt: null },
          _max: { rank: true },
        })
      : null;
    const now = new Date();
    await tx.task.update({
      where: { id: task.id },
      data: {
        assigneeId: assignee.id,
        ...(movedToTodo
          ? {
              status: "To Do",
              rank: (rank?._max.rank ?? 0) + 1,
              statusChangedAt: now,
            }
          : {}),
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actor.id,
        kind: "task.assign",
        payload: JSON.stringify({
          from: null,
          to: assignee.username,
          via: "reviewer-plan-approval",
        }),
      },
    });
    if (movedToTodo) {
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "task.move",
          payload: JSON.stringify({
            from: "Backlog",
            to: "To Do",
            via: "reviewer-plan-approval",
          }),
        },
      });
    }
  });

  await sendTaskWorkflowNotification({
    taskId: task.id,
    targetUserId: assignee.id,
    actor: args.actor,
    reason: "todo_start_required",
    body: [
      `The Action Plan for "${task.title}" was approved and reviewer @${args.actor.username ?? "unknown"} assigned it to you.`,
      "Call the workflow endpoint with action=start, move the task to In Progress, and implement the approved plan.",
      "Do not post a visible acknowledgement unless a blocker or material plan change appears.",
    ].join("\n"),
  });
  publishBoardTouch(task.projectId);

  return {
    ok: true,
    task: { id: task.id, title: task.title, status: movedToTodo ? "To Do" : task.status, projectSlug: task.project.slug },
    assignee,
    movedToTodo,
  };
}
