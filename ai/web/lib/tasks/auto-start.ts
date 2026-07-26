import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { epicAllowsAgentAction } from "@/lib/tasks/workflow-actors";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

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
        | "busy"
        | "changed";
      activeTask?: { id: string; title: string } | null;
      task?: { id: string; title: string; projectSlug: string; assigneeId: string | null } | null;
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

  const result = await db.$transaction(async (tx) => {
    const activeTask = await tx.task.findFirst({
      where: {
        id: { not: task.id },
        assigneeId: task.assigneeId,
        status: "In Progress",
        archivedAt: null,
        deletedAt: null,
      },
      orderBy: [{ statusChangedAt: "asc" }, { updatedAt: "asc" }],
      select: { id: true, title: true },
    });
    if (activeTask) {
      return {
        started: false as const,
        reason: "busy" as const,
        task: taskRef,
        activeTask,
      };
    }

    // Branch-keyed serialization: never let two tasks that resolve to the SAME
    // effective branch be In Progress at once — two agents editing one branch
    // collide. Per-task branches (lib/work-items/branches.ts) make Epic siblings
    // independent so an Epic fans out to multiple agents; an explicit shared
    // branchName (manager-forced co-development) or a legacy shared Epic branch
    // still serializes here regardless of which agent holds each task.
    const candidateBranch = effectiveTaskBranchName(task);
    if (candidateBranch) {
      const branchPeers = await tx.task.findMany({
        where: {
          id: { not: task.id },
          projectId: task.projectId,
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
        (peer) => effectiveTaskBranchName(peer) === candidateBranch,
      );
      if (branchClash) {
        return {
          started: false as const,
          reason: "busy" as const,
          task: taskRef,
          activeTask: { id: branchClash.id, title: branchClash.title },
        };
      }
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
