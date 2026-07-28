import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { ACTIVE_TASK_ASSIGNMENT_STATUSES } from "@/lib/epics/assignment";
import { startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";
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
      planRequested: boolean;
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

async function projectAssignableAllowlist(projectId: string) {
  const allowedRows = await db.projectManagerAssignableAgent.findMany({
    where: { projectId },
    select: { userId: true },
  });
  return allowedRows.length > 0 ? new Set(allowedRows.map((row) => row.userId)) : undefined;
}

async function findReviewerAssignedWorker(args: {
  projectId: string;
  defaultAssigneeId: string | null;
  excludedUserIds: Array<string | null | undefined>;
}) {
  const excluded = new Set(args.excludedUserIds.filter(Boolean) as string[]);
  const allowed = await projectAssignableAllowlist(args.projectId);
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

// Validate a reviewer-named assignee (P2): must be an active coding agent,
// not the task's reviewer/manager/reporter, inside the project's assignable
// allowlist (when one is configured), and not already holding active
// (To Do/In Progress) work in this project.
async function validateNamedAssignee(args: {
  username: string;
  projectId: string;
  excludedUserIds: Array<string | null | undefined>;
}): Promise<{ ok: true; user: { id: string; username: string } } | { ok: false; error: string; status: number }> {
  const user = await db.user.findFirst({
    where: { username: args.username },
    select: {
      id: true,
      username: true,
      status: true,
      kind: true,
      agent: { select: { role: true, deactivatedAt: true } },
    },
  });
  if (
    !user ||
    user.status !== "active" ||
    user.kind !== "agent" ||
    !user.agent ||
    user.agent.role !== "coding" ||
    user.agent.deactivatedAt
  ) {
    return { ok: false, error: `@${args.username} is not an eligible active coding agent`, status: 400 };
  }
  const excluded = new Set(args.excludedUserIds.filter(Boolean) as string[]);
  if (excluded.has(user.id)) {
    return { ok: false, error: `@${args.username} is this task's reviewer, manager, or reporter and cannot be its assignee`, status: 400 };
  }
  const allowed = await projectAssignableAllowlist(args.projectId);
  if (allowed && !allowed.has(user.id)) {
    return { ok: false, error: `@${args.username} is not in this project's assignable agent list`, status: 400 };
  }
  if (await hasActiveProjectTask(user.id, args.projectId)) {
    return { ok: false, error: `@${args.username} already has an active (To Do/In Progress) task in this project`, status: 409 };
  }
  return { ok: true, user: { id: user.id, username: user.username } };
}

// Reviewer-driven assignment (P2). Callable by the resolved reviewer on an
// UNASSIGNED Backlog/To Do task regardless of plan state; the reviewer may
// name the assignee explicitly (assigneeUsername) or let PM pick a free pool
// worker. After assignment:
//   - approved plan → normal start path (auto-start when idle, else
//     todo_start_required),
//   - no approved plan → a plan-request turn: the ASSIGNEE authors the
//     Action Plan (assignee-only authorship), the reviewer approves it.
export async function assignTaskAfterPlanApproval(args: {
  taskId: string;
  actor: Actor;
  assigneeUsername?: string;
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
      epic: { select: { actingManagerId: true } },
    },
  });
  if (!task || task.deletedAt) {
    return { ok: false, error: "Task not found", status: 404 };
  }
  if (args.requireReviewerUserId && task.actingManagerId !== args.requireReviewerUserId) {
    return { ok: false, error: "Only the assigned task reviewer can assign this unowned task", status: 403 };
  }
  if (task.assigneeId) {
    return { ok: false, error: "Task already has an assignee", status: 409 };
  }
  if (task.status !== "Backlog" && task.status !== "To Do") {
    return { ok: false, error: "Task must be in Backlog or To Do for reviewer assignment", status: 409 };
  }

  const excludedUserIds = [task.actingManagerId, task.epic?.actingManagerId, task.reporterId];
  let assignee: { id: string; username: string } | null = null;
  if (args.assigneeUsername) {
    const named = await validateNamedAssignee({
      username: args.assigneeUsername,
      projectId: task.projectId,
      excludedUserIds,
    });
    if (!named.ok) return { ok: false, error: named.error, status: named.status };
    assignee = named.user;
  } else {
    assignee = await findReviewerAssignedWorker({
      projectId: task.projectId,
      defaultAssigneeId: task.project.defaultAssigneeId,
      excludedUserIds,
    });
  }
  if (!assignee) {
    return { ok: false, error: "No eligible coding agent is currently available for this project", status: 409 };
  }

  // Without an approved plan the task stays where it is (Backlog stays
  // Backlog): approve_plan performs the Backlog → To Do promotion once the
  // new assignee's plan is accepted.
  const planApproved = Boolean(task.approvedOn);
  const movedToTodo = planApproved && task.status === "Backlog";
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
          named: Boolean(args.assigneeUsername),
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

  let startedNow = false;
  if (planApproved) {
    const autoStart = await startApprovedTodoTaskIfIdle({
      taskId: task.id,
      actor: args.actor,
      via: "reviewer-plan-approval",
    });
    startedNow = autoStart.started;
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: assignee.id,
      actor: args.actor,
      reason: "todo_start_required",
      body: autoStart.started
        ? [
            `The Action Plan for "${task.title}" was approved and reviewer @${args.actor.username ?? "unknown"} assigned it to you.`,
            "PM moved the task to In Progress because you have no other In Progress task.",
            "Start implementing the approved plan now. Do not post a visible acknowledgement unless a blocker or material plan change appears.",
          ].join("\n")
        : [
            `The Action Plan for "${task.title}" was approved and reviewer @${args.actor.username ?? "unknown"} assigned it to you.`,
            autoStart.reason === "busy"
              ? "You already have another In Progress task in this project, so this task remains in To Do until you are idle."
              : "Call the workflow endpoint with action=start, move the task to In Progress, and implement the approved plan.",
            "Do not post a visible acknowledgement unless a blocker or material plan change appears.",
          ].join("\n"),
    });
  } else {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: assignee.id,
      actor: args.actor,
      reason: "backlog_plan_requested",
      body: [
        `Reviewer @${args.actor.username ?? "unknown"} assigned you to "${task.title}", which has no approved Action Plan yet.`,
        "Read the full task context and existing comments, then post one concise technical implementation plan in Action Plan and wait for approval.",
        "Do not change task status and do not start work until the plan is approved.",
      ].join("\n"),
    });
  }
  publishBoardTouch(task.projectId);

  return {
    ok: true,
    task: {
      id: task.id,
      title: task.title,
      status: startedNow ? "In Progress" : movedToTodo ? "To Do" : task.status,
      projectSlug: task.project.slug,
    },
    assignee,
    movedToTodo,
    planRequested: !planApproved,
  };
}
