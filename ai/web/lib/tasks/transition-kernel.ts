import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { attachRowToActiveCycle } from "@/lib/tasks/workflow-cycle";

export const TASK_WORKFLOW_STATUSES = [
  "Backlog",
  "To Do",
  "In Progress",
  "Review",
  "Done",
] as const;

export type TaskWorkflowStatus = (typeof TASK_WORKFLOW_STATUSES)[number];

export type WorkflowEffect = {
  type:
    | "branch_verify"
    | "review_finalize"
    | "task_notification"
    | "board_touch"
    | "epic_cleanup"
    | "epic_completion_review"
    | "epic_completion_review_approval"
    | "dependency_refill";
  key: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
};

export type TaskTransitionIntent =
  | "start"
  | "auto_start"
  | "submit_review"
  | "repository_validated"
  | "request_changes"
  | "repository_validation_failed"
  | "repository_reopen"
  | "accept_review"
  | "triage"
  | "approve_plan"
  | "reopen"
  | "queue"
  | "cancel"
  | "operator_override";

const LEGAL_EDGES: Record<Exclude<TaskTransitionIntent, "operator_override">, ReadonlyArray<readonly [TaskWorkflowStatus, TaskWorkflowStatus]>> = {
  start: [["To Do", "In Progress"]],
  auto_start: [["To Do", "In Progress"]],
  submit_review: [["In Progress", "Review"]],
  repository_validated: [["In Progress", "Review"]],
  request_changes: [["Review", "To Do"]],
  repository_validation_failed: [["In Progress", "To Do"], ["Review", "To Do"]],
  repository_reopen: [["Done", "Review"]],
  accept_review: [["Review", "Done"]],
  triage: [["Backlog", "To Do"]],
  approve_plan: [["Backlog", "To Do"]],
  reopen: [["Done", "To Do"], ["Review", "To Do"]],
  queue: [["Backlog", "To Do"], ["In Progress", "To Do"]],
  cancel: [["To Do", "Backlog"], ["In Progress", "Backlog"], ["Review", "Backlog"]],
};

export class TaskTransitionRejected extends Error {
  constructor(
    message: string,
    readonly code: "invalid_edge" | "version_conflict" | "status_conflict" | "not_found",
  ) {
    super(message);
    this.name = "TaskTransitionRejected";
  }
}

export function isTaskWorkflowStatus(value: string): value is TaskWorkflowStatus {
  return (TASK_WORKFLOW_STATUSES as readonly string[]).includes(value);
}

function assertLegalEdge(intent: TaskTransitionIntent, from: TaskWorkflowStatus, to: TaskWorkflowStatus) {
  if (intent === "operator_override") return;
  if (!LEGAL_EDGES[intent].some(([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to)) {
    throw new TaskTransitionRejected(
      `Workflow intent ${intent} cannot move a task from ${from} to ${to}.`,
      "invalid_edge",
    );
  }
}

function clippedJson(value: Record<string, unknown> | null | undefined, max = 16_000) {
  if (!value) return null;
  const encoded = JSON.stringify(value);
  return encoded.length > max ? encoded.slice(0, max) : encoded;
}

export async function enqueueWorkflowEffects(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    projectId: string;
    aggregateVersion: number;
    transitionId?: string | null;
    effects: WorkflowEffect[];
    workflowCycleId?: string | null;
  },
) {
  for (const effect of args.effects) {
    const dedupeKey = `${args.taskId}:v${args.aggregateVersion}:${effect.key}`;
    await tx.workflowOutbox.upsert({
      where: { dedupeKey },
      create: {
        taskId: args.taskId,
        projectId: args.projectId,
        transitionId: args.transitionId ?? null,
        workflowCycleId: args.workflowCycleId ?? null,
        aggregateVersion: args.aggregateVersion,
        effectType: effect.type,
        payload: JSON.stringify(effect.payload),
        dedupeKey,
        availableAt: effect.availableAt ?? new Date(),
      },
      update: {},
    });
  }
}

export async function applyTaskTransition(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    projectId: string;
    actorUserId?: string | null;
    intent: TaskTransitionIntent;
    from: TaskWorkflowStatus;
    to: TaskWorkflowStatus;
    source: string;
    idempotencyKey: string;
    expectedVersion?: number;
    rank?: "front" | "back" | number;
    evidence?: Record<string, unknown> | null;
    taskData?: Prisma.TaskUncheckedUpdateManyInput;
    effects?: WorkflowEffect[];
    mutate?: (args: {
      tx: Prisma.TransactionClient;
      transitionId: string;
      workflowVersion: number;
    }) => Promise<void>;
  },
) {
  if (!args.idempotencyKey.trim() || args.idempotencyKey.length > 500) {
    throw new Error("A bounded workflow transition idempotency key is required.");
  }
  const replay = await tx.workflowTransition.findUnique({
    where: {
      taskId_idempotencyKey: {
        taskId: args.taskId,
        idempotencyKey: args.idempotencyKey,
      },
    },
  });
  if (replay) {
    return { transition: replay, replayed: true as const };
  }

  const current = await tx.task.findUnique({
    where: { id: args.taskId },
    select: { status: true, workflowVersion: true, deletedAt: true, activeWorkflowCycleId: true },
  });
  if (!current || current.deletedAt) {
    throw new TaskTransitionRejected("Task not found.", "not_found");
  }
  if (!isTaskWorkflowStatus(current.status) || current.status !== args.from) {
    throw new TaskTransitionRejected(
      `Task status changed concurrently: expected ${args.from}, found ${current.status}.`,
      "status_conflict",
    );
  }
  if (args.expectedVersion !== undefined && current.workflowVersion !== args.expectedVersion) {
    throw new TaskTransitionRejected(
      `Task workflow version changed concurrently: expected ${args.expectedVersion}, found ${current.workflowVersion}.`,
      "version_conflict",
    );
  }
  assertLegalEdge(args.intent, args.from, args.to);

  let rank: number | undefined;
  if (typeof args.rank === "number") {
    rank = args.rank;
  } else if (args.rank === "front") {
    const edge = await tx.task.aggregate({
      where: { projectId: args.projectId, status: args.to, archivedAt: null, deletedAt: null },
      _min: { rank: true },
    });
    rank = (edge._min.rank ?? 0) - 1;
  } else {
    const edge = await tx.task.aggregate({
      where: { projectId: args.projectId, status: args.to, archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    rank = (edge._max.rank ?? 0) + 1;
  }

  const workflowVersion = current.workflowVersion + 1;
  const updated = await tx.task.updateMany({
    where: {
      id: args.taskId,
      status: args.from,
      workflowVersion: current.workflowVersion,
      deletedAt: null,
    },
    data: {
      ...args.taskData,
      status: args.to,
      rank,
      statusChangedAt: new Date(),
      workflowVersion,
    },
  });
  if (updated.count !== 1) {
    throw new TaskTransitionRejected(
      "Task status or workflow version changed while the transition was being committed.",
      "version_conflict",
    );
  }

  const transition = await tx.workflowTransition.create({
    data: {
      taskId: args.taskId,
      workflowCycleId: current.activeWorkflowCycleId,
      workflowVersion,
      intent: args.intent,
      fromStatus: args.from,
      toStatus: args.to,
      actorUserId: args.actorUserId ?? null,
      source: args.source,
      idempotencyKey: args.idempotencyKey,
      evidence: clippedJson(args.evidence),
    },
  });
  await tx.activityLog.create({
    data: {
      projectId: args.projectId,
      taskId: args.taskId,
      userId: args.actorUserId ?? null,
      kind: "task.move",
      payload: JSON.stringify({
        from: args.from,
        to: args.to,
        via: args.source,
        action: args.intent,
        workflowVersion,
        transitionId: transition.id,
        ...(args.evidence ?? {}),
      }),
    },
  });
  if (args.mutate) {
    await args.mutate({ tx, transitionId: transition.id, workflowVersion });
  }
  const dependencyRefillNeeded = args.to === "Done" && (
    await tx.taskDependency.count({ where: { prerequisiteTaskId: args.taskId } }) > 0 ||
    await tx.task.count({ where: { blockedById: args.taskId, deletedAt: null } }) > 0
  );
  await enqueueWorkflowEffects(tx, {
    taskId: args.taskId,
    projectId: args.projectId,
    aggregateVersion: workflowVersion,
    transitionId: transition.id,
    workflowCycleId: current.activeWorkflowCycleId,
    effects: [
      ...(args.effects ?? []),
      ...(dependencyRefillNeeded
        ? [{
            type: "dependency_refill" as const,
            key: "dependency-refill",
            payload: {
              prerequisiteTaskId: args.taskId,
              actorUserId: args.actorUserId ?? null,
            },
          }]
        : []),
    ],
  });
  return { transition, replayed: false as const };
}

export async function transitionTask(
  args: Parameters<typeof applyTaskTransition>[1],
) {
  return db.$transaction((tx) => applyTaskTransition(tx, args), { timeout: 15_000 });
}
