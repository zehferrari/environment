import type { Prisma } from "@prisma/client";

// "One active Task per project" (docs/agent-pm-api.md § Role permissions):
// a worker holding a task in any of these statuses is not eligible for another
// automated assignment in that project. Review does NOT count — a task parked
// in Review frees its worker for the next assignment; unresolved review
// feedback remains the worker's first priority (WORKFLOW.md tier 1) but must
// not idle them while they wait on a reviewer.
// The limit is per worker, not per epic: an epic with N free pool workers
// may have N tasks in flight at once.
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
  const allowedRows = await tx.projectManagerAssignableAgent.findMany({
    where: { projectId: args.projectId },
    select: { userId: true },
  });
  const allowed = new Set(allowedRows.map((row) => row.userId));
  const restricted = allowed.size > 0;
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
    if (restricted && !allowed.has(worker.userId)) continue;
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

export type EpicTaskAssignment = {
  task: {
    id: string;
    title: string;
    actingManagerId: string | null;
    project: { slug: string };
  };
  worker: { id: string; username: string };
  // True when the task carried an approval granted while it was unassigned
  // (reviewer pre-approved flow) — the plan survives the assignment and the
  // worker may start immediately instead of re-planning.
  approvedPlan: boolean;
};

// Promote every open Backlog task of the epic to the To Do queue (rank after
// the current To Do tail). Shared by the epic-manager workflow advance_queue
// action and the engine-side epic-approval path.
export async function promoteEpicBacklogTasks(
  tx: Prisma.TransactionClient,
  args: {
    epicId: string;
    projectId: string;
    actorUserId: string;
    via: string;
  },
) {
  const tasks = await tx.task.findMany({
    where: {
      epicId: args.epicId,
      parentTaskId: null,
      archivedAt: null,
      deletedAt: null,
      private: false,
      status: "Backlog",
    },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true },
  });
  if (tasks.length === 0) return [];

  const maxRank = await tx.task.aggregate({
    where: { projectId: args.projectId, status: "To Do", archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });
  let nextRank = (maxRank._max.rank ?? 0) + 1;
  const now = new Date();
  for (const task of tasks) {
    await tx.task.update({
      where: { id: task.id },
      data: { status: "To Do", rank: nextRank++, statusChangedAt: now },
    });
    await tx.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: task.id,
        userId: args.actorUserId,
        kind: "task.move",
        payload: JSON.stringify({
          from: "Backlog",
          to: "To Do",
          via: args.via,
          action: "advance_queue",
          epicId: args.epicId,
        }),
      },
    });
  }
  return tasks;
}

// Assign unassigned To Do tasks (queue order) to available pool workers until
// either runs out. Each assignment makes that worker ineligible for the rest
// of the loop (their fresh To Do task counts as active inside the same
// transaction), so one call fills every free worker with exactly one task.
// Tasks with an uncleared blocker (blockedBy not Done) are never handed out —
// the same dependency rule the start/auto-start guards enforce.
export async function assignOpenEpicTasks(
  tx: Prisma.TransactionClient,
  args: {
    epicId: string;
    projectId: string;
    actorUserId: string;
    excludeUserIds?: Array<string | null | undefined>;
    via: string;
  },
) {
  const openTasks = await tx.task.findMany({
    where: {
      epicId: args.epicId,
      parentTaskId: null,
      archivedAt: null,
      deletedAt: null,
      private: false,
      status: "To Do",
      assigneeId: null,
    },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      actingManagerId: true,
      approvedOn: true,
      blockedById: true,
      blockedBy: { select: { status: true, workItemKey: true } },
      project: { select: { slug: true } },
    },
  });
  if (openTasks.length === 0) {
    return { assignments: [] as EpicTaskAssignment[], skipped: "no_todo_task" as const };
  }

  const tasks = openTasks.filter(
    (task) => !task.blockedById || task.blockedBy?.status === "Done",
  );
  if (tasks.length === 0) {
    await tx.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: openTasks[0].id,
        userId: args.actorUserId,
        kind: "task.workflow.next_assignment_skipped",
        payload: JSON.stringify({
          reason: "all_open_tasks_blocked",
          epicId: args.epicId,
          via: args.via,
          blockedTaskIds: openTasks.map((task) => task.id),
        }),
      },
    });
    return { assignments: [] as EpicTaskAssignment[], skipped: "all_open_tasks_blocked" as const };
  }

  const assignments: EpicTaskAssignment[] = [];
  for (const task of tasks) {
    // Never assign a task to its own resolved reviewer: the per-task
    // actingManagerId is added to the epic-level exclusions so the review
    // gate can't collapse (assignee === reviewer would let an agent ship its
    // own unreviewed work).
    const worker = await findAvailableEpicWorker(tx, {
      epicId: args.epicId,
      projectId: args.projectId,
      excludeUserIds: [...(args.excludeUserIds ?? []), task.actingManagerId],
    });
    if (!worker) continue;

    // A plan approved while the task sat unassigned (reviewer pre-approved
    // flow) survives the assignment — the new assignee starts immediately.
    // Only an unapproved task gets the plan slate wiped.
    const approvedPlan = Boolean(task.approvedOn);
    // Atomic claim: refills can race (two ready_for_review calls landing
    // together). Only the transaction that flips assigneeId from null wins;
    // the loser skips the task instead of silently overwriting.
    const claimed = await tx.task.updateMany({
      where: { id: task.id, assigneeId: null, status: "To Do" },
      data: approvedPlan
        ? { assigneeId: worker.id }
        : { assigneeId: worker.id, approvedOn: null, approvedById: null },
    });
    if (claimed.count !== 1) continue;
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
          approvedPlanPreserved: approvedPlan,
        }),
      },
    });
    if (!approvedPlan) {
      await tx.activityLog.create({
        data: {
          projectId: args.projectId,
          taskId: task.id,
          userId: args.actorUserId,
          kind: "task.action_plan.reset",
          payload: JSON.stringify({
            reason: "epic_queue_assignment",
            via: args.via,
            epicId: args.epicId,
          }),
        },
      });
    }
    assignments.push({ task, worker, approvedPlan });
  }

  if (assignments.length === 0) {
    await tx.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: tasks[0].id,
        userId: args.actorUserId,
        kind: "task.workflow.next_assignment_skipped",
        payload: JSON.stringify({
          reason: "no_available_epic_worker",
          epicId: args.epicId,
          via: args.via,
        }),
      },
    });
    return { assignments, skipped: "no_available_epic_worker" as const };
  }

  return { assignments, skipped: null };
}
