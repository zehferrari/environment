import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import { db } from "@/lib/db";
import { ACTIVE_TASK_ASSIGNMENT_STATUSES } from "@/lib/epics/assignment";
import { startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { applyTaskTransition, enqueueWorkflowEffects, type WorkflowEffect } from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";

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
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "auto-start-and-queue-refill",
    entryPoint: "assignTaskAfterPlanApproval",
  });
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      workflowVersion: true,
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
  const effects: WorkflowEffect[] = [
    { type: "board_touch", key: "board-reviewer-assignment", payload: {} },
    {
      type: "task_notification",
      key: `reviewer-assignment:${assignee.id}`,
      payload: {
        taskId: task.id,
        targetUserId: assignee.id,
        actor: args.actor,
        reason: planApproved ? "todo_start_required" : "backlog_plan_requested",
        body: planApproved
          ? [
              `The Action Plan for "${task.title}" was approved and reviewer @${args.actor.username ?? "unknown"} assigned it to you.`,
              "PM will auto-start it if the execution lane and repository gates are free. Check the current status: implement immediately if In Progress, otherwise call action=start when it remains To Do.",
              "Do not post a visible acknowledgement unless a blocker or material plan change appears.",
            ].join("\n")
          : [
              `Reviewer @${args.actor.username ?? "unknown"} assigned you to "${task.title}", which has no approved Action Plan yet.`,
              "Read the full task context and existing comments, then post one concise structured implementation plan through action=submit_plan and wait for approval.",
              "Do not change task status and do not start work until the plan is approved.",
            ].join("\n"),
      },
    },
  ];
  await db.$transaction(async (tx) => {
    if (movedToTodo) {
      await applyTaskTransition(tx, {
        taskId: task.id,
        projectId: task.projectId,
        actorUserId: args.actor.id,
        intent: "queue",
        from: "Backlog",
        to: "To Do",
        source: "reviewer-plan-approval",
        idempotencyKey: `reviewer-assign:${assignee.id}:v${task.workflowVersion + 1}`,
        taskData: { assigneeId: assignee.id },
        effects,
      });
    } else {
      await tx.task.update({ where: { id: task.id }, data: { assigneeId: assignee.id } });
      await enqueueWorkflowEffects(tx, {
        taskId: task.id,
        projectId: task.projectId,
        aggregateVersion: task.workflowVersion,
        effects,
      });
    }
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
          // Reviewer authority: assignee !== reviewer is enforced above, so
          // this row can never be an agent granting itself a task.
          assignedBy: "reviewer",
          named: Boolean(args.assigneeUsername),
        }),
      },
    });
  });

  let startedNow = false;
  if (planApproved) {
    const autoStart = await startApprovedTodoTaskIfIdle({
      taskId: task.id,
      actor: args.actor,
      via: "reviewer-plan-approval",
    });
    startedNow = autoStart.started;
  }
  await drainWorkflowOutbox({ limit: effects.length }).catch(() => {});
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
