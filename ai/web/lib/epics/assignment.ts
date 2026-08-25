import type { Prisma } from "@prisma/client";
import { unresolvedTaskPrerequisites } from "@/lib/tasks/blocking";
import { submitWorkflowCommandInTransaction } from "@/lib/tasks/orchestrator";
import type { OrchestratorResult, WorkflowActor } from "@/lib/tasks/orchestrator/types";

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
    // 2b: when a worker just freed itself (moved its task to Review), prefer it
    // for the Epic's next unblocked task so the same agent keeps driving.
    preferUserId?: string | null;
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

  const eligible: Array<{ id: string; username: string }> = [];
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
    // One active branch per agent: a worker already holding a To Do/In Progress
    // task is not eligible for another. Parallelism across a big Epic comes from
    // the pool's OTHER free workers each taking their own per-task branch.
    if (activeInProject === 0) {
      eligible.push({ id: worker.userId, username: worker.user.username });
    }
  }

  if (eligible.length === 0) return null;
  if (args.preferUserId) {
    const preferred = eligible.find((worker) => worker.id === args.preferUserId);
    if (preferred) return preferred;
  }
  return eligible[0];
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

export type PolicyEvidenceTrigger = {
  kind: "command_receipt" | "workflow_transition" | "monitor_incident" | "policy_event";
  id: string;
};

export class PolicyCommandRejected extends Error {
  constructor(
    readonly operation: "promote" | "assign",
    readonly taskId: string,
    readonly result: Exclude<OrchestratorResult, { status: "accepted" | "replayed" }>,
  ) {
    super(`pm_policy_${operation}_rejected:${taskId}:${result.status}:${result.reason}`);
    this.name = "PolicyCommandRejected";
  }
}

async function loadPolicyActor(tx: Prisma.TransactionClient, actorUserId: string): Promise<WorkflowActor> {
  const actor = await tx.user.findFirst({
    where: { id: actorUserId, status: "active" },
    select: { id: true, username: true, kind: true },
  });
  if (!actor) throw new Error(`pm_policy_actor_not_found:${actorUserId}`);
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind === "agent" ? "agent" : "human",
  };
}

function identityPart(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._:-]+/g, "-").slice(0, 160) || "unspecified";
}

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
    trigger?: PolicyEvidenceTrigger;
  },
) {
  const actor = await loadPolicyActor(tx, args.actorUserId);
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
    select: { id: true, title: true, workflowVersion: true },
  });
  if (tasks.length === 0) return [];

  const trigger = args.trigger ?? { kind: "policy_event" as const, id: args.via };
  for (const task of tasks) {
    const result = await submitWorkflowCommandInTransaction(tx, {
      taskId: task.id,
      intent: "triage_task",
      actor,
      expectedWorkflowVersion: task.workflowVersion,
      workflowCycleId: null,
      idempotencyKey: `pm-policy:promote:${identityPart(trigger.kind)}:${identityPart(trigger.id)}:${args.epicId}:${task.id}:v${task.workflowVersion}`,
      source: "pm-service",
      payload: { targetStatus: "To Do", reason: "Epic queue advanced" },
      evidence: {
        policy: "epic_queue_promotion",
        trigger,
        selectionReason: "open_epic_backlog_task_in_rank_order",
        selectedTaskId: task.id,
        expectedWorkflowVersion: task.workflowVersion,
        epicId: args.epicId,
        via: args.via,
      },
    });
    if (result.status !== "accepted" && result.status !== "replayed") {
      throw new PolicyCommandRejected("promote", task.id, result);
    }
  }
  return tasks;
}

// Assign unassigned To Do tasks (queue order) to available pool workers until
// either runs out. Each assignment makes that worker ineligible for the rest
// of the loop (their fresh To Do task counts as active inside the same
// transaction), so one call fills every free worker with exactly one task.
// Tasks with any uncleared prerequisite are never handed out — the same full
// dependency-graph rule the start/auto-start guards enforce.
export async function assignOpenEpicTasks(
  tx: Prisma.TransactionClient,
  args: {
    epicId: string;
    projectId: string;
    actorUserId: string;
    excludeUserIds?: Array<string | null | undefined>;
    // 2b: the worker that just freed itself, preferred for the next task.
    preferUserId?: string | null;
    via: string;
    notificationContextLine?: string;
    trigger?: PolicyEvidenceTrigger;
  },
) {
  const actor = await loadPolicyActor(tx, args.actorUserId);
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
      workflowVersion: true,
      updatedAt: true,
      blockedById: true,
      blockedBy: { select: { id: true, status: true, workItemKey: true } },
      dependencies: {
        select: {
          prerequisite: { select: { id: true, status: true, workItemKey: true } },
        },
      },
      project: { select: { slug: true } },
    },
  });
  if (openTasks.length === 0) {
    return { assignments: [] as EpicTaskAssignment[], skipped: "no_todo_task" as const };
  }

  const tasks = openTasks.filter((task) => unresolvedTaskPrerequisites(task).length === 0);
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
          unresolvedPrerequisites: Object.fromEntries(openTasks.map((task) => [
            task.id,
            unresolvedTaskPrerequisites(task).map((prerequisite) => prerequisite.workItemKey ?? prerequisite.id),
          ])),
        }),
      },
    });
    return { assignments: [] as EpicTaskAssignment[], skipped: "all_open_tasks_blocked" as const };
  }

  const assignments: EpicTaskAssignment[] = [];
  const trigger = args.trigger ?? { kind: "policy_event" as const, id: args.via };
  for (const task of tasks) {
    // Never assign a task to its own resolved reviewer: the per-task
    // actingManagerId is added to the epic-level exclusions so the review
    // gate can't collapse (assignee === reviewer would let an agent ship its
    // own unreviewed work).
    const worker = await findAvailableEpicWorker(tx, {
      epicId: args.epicId,
      projectId: args.projectId,
      excludeUserIds: [...(args.excludeUserIds ?? []), task.actingManagerId],
      preferUserId: args.preferUserId,
    });
    if (!worker) continue;

    // A plan approved while the task sat unassigned (reviewer pre-approved
    // flow) survives the assignment — the new assignee starts immediately.
    // Only an unapproved task gets the plan slate wiped.
    const approvedPlan = Boolean(task.approvedOn);
    const selectionReason = args.preferUserId === worker.id
      ? "preferred_freed_worker_for_next_unblocked_task"
      : "first_free_epic_worker_for_unblocked_queue_head";
    const queueGeneration = task.updatedAt.toISOString();
    const result = await submitWorkflowCommandInTransaction(tx, {
      taskId: task.id,
      intent: "assign_task",
      actor,
      expectedWorkflowVersion: task.workflowVersion,
      workflowCycleId: null,
      idempotencyKey: [
        "pm-policy:assign",
        identityPart(trigger.kind),
        identityPart(trigger.id),
        identityPart(selectionReason),
        queueGeneration,
        args.epicId,
        task.id,
        worker.id,
        `v${task.workflowVersion}`,
      ].join(":"),
      source: "pm-service",
      payload: {
        assigneeUsername: worker.username,
        afterPlanApproval: approvedPlan,
      },
      evidence: {
        policy: "epic_queue_refill",
        trigger,
        selectionReason,
        queueGeneration,
        assigneeLane: `${args.projectId}:${worker.id}`,
        selectedTaskId: task.id,
        selectedAssigneeId: worker.id,
        selectedAssigneeUsername: worker.username,
        expectedWorkflowVersion: task.workflowVersion,
        epicId: args.epicId,
        via: args.via,
        approvedPlanPreserved: approvedPlan,
        resetUnapprovedPlan: !approvedPlan,
        notification: {
          reason: "todo_start_required",
          body: [
            ...(args.notificationContextLine ? [args.notificationContextLine] : []),
            `Task "${task.title}" is now assigned to you in To Do.`,
            approvedPlan
              ? "Its Action Plan is already approved: move the task to In Progress through the workflow endpoint and start immediately."
              : "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. A plain chat reply is discussion only.",
            "If you have unresolved review feedback on another Review-stage task, address that feedback first — it stays your top priority.",
          ].join("\n"),
        },
      },
    });
    if (result.status !== "accepted" && result.status !== "replayed") {
      throw new PolicyCommandRejected("assign", task.id, result);
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
