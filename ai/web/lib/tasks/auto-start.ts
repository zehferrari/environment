import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { epicAllowsAgentAction } from "@/lib/tasks/workflow-actors";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";
import { applyTaskTransition, TaskTransitionRejected } from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import { unresolvedTaskPrerequisites } from "@/lib/tasks/blocking";

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
      workflowVersion: true,
      projectId: true,
      assigneeId: true,
      approvedOn: true,
      deletedAt: true,
      workItemKey: true,
      branchName: true,
      blockedById: true,
      blockedBy: { select: { id: true, title: true, status: true, workItemKey: true } },
      dependencies: {
        select: {
          prerequisite: { select: { id: true, title: true, status: true, workItemKey: true } },
        },
      },
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
  const [unresolvedPrerequisite] = unresolvedTaskPrerequisites(task);
  if (unresolvedPrerequisite) {
    return {
      started: false,
      reason: "blocked",
      task: taskRef,
      activeTask: {
        id: unresolvedPrerequisite.id,
        title: unresolvedPrerequisite.workItemKey ?? unresolvedPrerequisite.title ?? "another task",
      },
    };
  }
  if (!epicAllowsAgentAction(task)) {
    return { started: false, reason: "epic_not_ready", task: taskRef };
  }

  try {
    await ensureTaskCodeWorktree(task.id, task.assigneeId);
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

  let result: TaskAutoStartResult;
  try {
    result = await db.$transaction(async (tx) => {
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

    await applyTaskTransition(tx, {
      taskId: task.id,
      projectId: task.projectId,
      actorUserId: args.actor.id,
      intent: "auto_start",
      from: "To Do",
      to: "In Progress",
      source: args.via,
      idempotencyKey: `auto-start:${args.via}:v${task.workflowVersion + 1}`,
      evidence: { autoStart: true, assigneeId: task.assigneeId },
      effects: [{ type: "board_touch", key: "board-auto-start", payload: {} }],
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
  } catch (error) {
    if (error instanceof TaskTransitionRejected) {
      return { started: false, reason: "changed", task: taskRef };
    }
    throw error;
  }

  if (result.started) {
    await drainWorkflowOutbox({ limit: 1 }).catch(() => {});
    publishBoardTouch(result.task.projectId);
  }
  return result;
}
