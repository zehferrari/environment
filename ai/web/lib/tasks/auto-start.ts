import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { epicAllowsAgentAction } from "@/lib/tasks/workflow-actors";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

type DbClient = Prisma.TransactionClient | typeof db;

export type StartConflict = {
  kind: "wip" | "branch";
  activeTask: { id: string; title: string; workItemKey?: string | null };
};

// Shared entry gate for In Progress (P4): every path that moves a task to
// In Progress (explicit workflow `start` AND PM auto-start) must pass both
// checks. Returns the first conflict found, or null when the task may start.
//
// 1. WIP limit — ≤1 In Progress task per agent per PROJECT. Review does not
//    count; assignment eligibility (To Do+In Progress) is a separate rule in
//    lib/epics/assignment.ts.
// 2. Branch-keyed serialization — never let two tasks that resolve to the
//    SAME effective branch be In Progress at once: two agents editing one
//    branch collide. Per-task branches (lib/work-items/branches.ts) make Epic
//    siblings independent; an explicit shared branchName (manager-forced
//    co-development) or a legacy shared Epic branch still serializes here
//    regardless of which agent holds each task.
export async function findInProgressStartConflict(
  client: DbClient,
  args: {
    taskId: string;
    projectId: string;
    assigneeId: string;
    candidateBranch: string | null;
  },
): Promise<StartConflict | null> {
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

  if (args.candidateBranch) {
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
    if (branchClash) {
      return {
        kind: "branch",
        activeTask: { id: branchClash.id, title: branchClash.title, workItemKey: branchClash.workItemKey },
      };
    }
  }
  return null;
}

export type TaskAutoStartResult =
  | {
      started: true;
      task: {
        id: string;
        title: string;
        projectId: string;
        projectSlug: string;
        assigneeId: string;
        assigneeUsername: string;
      };
    }
  | {
      started: false;
      reason:
        | "not_found"
        | "not_todo"
        | "not_approved"
        | "not_agent_assignee"
        | "blocked"
        | "epic_not_ready"
        | "worktree_unavailable"
        | "busy"
        | "changed";
      activeTask?: { id: string; title: string } | null;
      task?: { id: string; title: string; projectSlug: string; assigneeId: string | null } | null;
      worktreeError?: string;
    };

export async function startApprovedTodoTaskIfIdle(args: {
  taskId: string;
  actor: Actor;
  via: string;
}): Promise<TaskAutoStartResult> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      assigneeId: true,
      approvedOn: true,
      deletedAt: true,
      workItemKey: true,
      branchName: true,
      blockedById: true,
      blockedBy: { select: { id: true, title: true, status: true, workItemKey: true } },
      epicId: true,
      epic: { select: { status: true, workItemKey: true, branchName: true } },
      project: { select: { slug: true } },
      assignee: {
        select: {
          id: true,
          username: true,
          kind: true,
          status: true,
          agent: { select: { role: true, deactivatedAt: true } },
        },
      },
    },
  });

  if (!task || task.deletedAt) return { started: false, reason: "not_found", task: null };
  const taskRef = {
    id: task.id,
    title: task.title,
    projectSlug: task.project.slug,
    assigneeId: task.assigneeId,
  };
  if (task.status !== "To Do") return { started: false, reason: "not_todo", task: taskRef };
  if (!task.approvedOn) return { started: false, reason: "not_approved", task: taskRef };
  if (
    !task.assigneeId ||
    task.assignee?.kind !== "agent" ||
    task.assignee.status !== "active" ||
    !task.assignee.agent ||
    task.assignee.agent.role !== "coding" ||
    task.assignee.agent.deactivatedAt
  ) {
    return { started: false, reason: "not_agent_assignee", task: taskRef };
  }
  if (task.blockedById && task.blockedBy && task.blockedBy.status !== "Done") {
    return {
      started: false,
      reason: "blocked",
      task: taskRef,
      activeTask: { id: task.blockedBy.id, title: task.blockedBy.workItemKey ?? task.blockedBy.title },
    };
  }
  if (!epicAllowsAgentAction(task)) {
    return { started: false, reason: "epic_not_ready", task: taskRef };
  }

  try {
    await ensureTaskCodeWorktree(task.id, args.actor.id);
  } catch (err) {
    return {
      started: false,
      reason: "worktree_unavailable",
      task: taskRef,
      worktreeError: err instanceof TaskWorktreeError
        ? err.message
        : "Task worktree could not be created or validated.",
    };
  }

  const result = await db.$transaction(async (tx) => {
    // Shared In Progress entry gate (P4): per-project WIP limit + effective-
    // branch clash. Same helper backs the workflow endpoint's `start` action.
    const conflict = await findInProgressStartConflict(tx, {
      taskId: task.id,
      projectId: task.projectId,
      assigneeId: task.assigneeId!,
      candidateBranch: effectiveTaskBranchName(task),
    });
    if (conflict) {
      return {
        started: false as const,
        reason: "busy" as const,
        task: taskRef,
        activeTask: { id: conflict.activeTask.id, title: conflict.activeTask.title },
      };
    }

    const maxRank = await tx.task.aggregate({
      where: {
        projectId: task.projectId,
        status: "In Progress",
        archivedAt: null,
        deletedAt: null,
      },
      _max: { rank: true },
    });
    const now = new Date();
    const updated = await tx.task.updateMany({
      where: {
        id: task.id,
        status: "To Do",
        assigneeId: task.assigneeId,
        approvedOn: { not: null },
        deletedAt: null,
      },
      data: {
        status: "In Progress",
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: now,
      },
    });
    if (updated.count !== 1) {
      return { started: false as const, reason: "changed" as const, task: taskRef };
    }

    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actor.id,
        kind: "task.move",
        payload: JSON.stringify({
          from: "To Do",
          to: "In Progress",
          via: args.via,
          autoStart: true,
        }),
      },
    });

    await promoteEpicOnTaskInProgress(tx, {
      epicId: task.epicId,
      projectId: task.projectId,
      actorId: args.actor.id,
      via: args.via,
    });

    return {
      started: true as const,
      task: {
        id: task.id,
        title: task.title,
        projectId: task.projectId,
        projectSlug: task.project.slug,
        assigneeId: task.assigneeId!,
        assigneeUsername: task.assignee!.username,
      },
    };
  });

  if (result.started) publishBoardTouch(result.task.projectId);
  return result;
}
