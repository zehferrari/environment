// Lightweight sub-task checklist core (ENV-60).
//
// A SubTask is NOT a child Task — it has no assignee, reviewer, status, key, or
// board presence. It is one goal line plus a completion timestamp. The point is
// progress: a task broken into checklist items shows "done/total" on its board
// card, so you can see how close an in-flight task is to finished.
//
// This module is auth-free so it is callable from both the human task-editor
// server actions and the token-scoped agent workflow endpoint. Callers are
// responsible for authorization; pass `expectTaskId` to scope a mutation to a
// single task. Every mutation writes an ActivityLog row (the actor is recorded
// there, which is how "who completed it / when" is audited without widening the
// minimal row shape).

import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

// ENV-118: the agent workflow endpoint runs these mutations inside the same
// transaction as its continuation-outbox write, so every mutation below takes
// an optional client. Omitted, it behaves exactly as before (its own
// transaction on the base client).
type TxClient = Prisma.TransactionClient | typeof db;

export const MAX_SUBTASK_TEXT = 500;
export const MAX_SUBTASKS_PER_TASK = 50;

// Checklist phases. "implementation" is the assignee's In Progress breakdown;
// "review" is the reviewer's topics-to-address list for the Review column.
export const SUBTASK_KINDS = ["implementation", "review"] as const;
export type SubTaskKind = (typeof SUBTASK_KINDS)[number];

export function normalizeSubTaskKind(value: unknown): SubTaskKind {
  return value === "review" ? "review" : "implementation";
}

export type SubTaskActivityKind =
  | "task.subtask.add"
  | "task.subtask.complete"
  | "task.subtask.reopen"
  | "task.subtask.delete";

// Strip an auto-generated leading ordinal like "1. " / "2) " from a step line.
export function stripStepNumber(text: string): string {
  return text.replace(/^\s*\d+[.)]\s+/, "").trim();
}

export async function createSubTaskItem(args: {
  taskId: string;
  text: string;
  actorUserId: string;
  completedAt?: Date | null;
  kind?: SubTaskKind;
  actionPlanStepId?: string | null;
  client?: TxClient;
}): Promise<{ id: string; created: boolean } | null> {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "subtask-checklist-actions",
    entryPoint: "createSubTaskItem",
    client: args.client ?? db,
  });
  const client = args.client ?? db;
  const text = args.text.trim().slice(0, MAX_SUBTASK_TEXT);
  if (!text) return null;
  const kind = normalizeSubTaskKind(args.kind);

  const existing = await client.subTask.findFirst({
    where: args.actionPlanStepId
      ? { actionPlanStepId: args.actionPlanStepId }
      : { taskId: args.taskId, kind, text },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const agg = await client.subTask.aggregate({
    where: { taskId: args.taskId },
    _max: { rank: true },
    _count: true,
  });
  if (agg._count >= MAX_SUBTASKS_PER_TASK) {
    throw new Error(`A task may have at most ${MAX_SUBTASKS_PER_TASK} checklist items.`);
  }

  const item = await client.subTask.create({
    data: {
      taskId: args.taskId,
      text,
      kind,
      actionPlanStepId: args.actionPlanStepId ?? null,
      rank: (agg._max.rank ?? 0) + 1,
      completedAt: args.completedAt ?? null,
    },
    select: { id: true, task: { select: { projectId: true } } },
  });
  await client.activityLog.create({
    data: {
      projectId: item.task.projectId,
      taskId: args.taskId,
      userId: args.actorUserId,
      kind: "task.subtask.add",
      payload: JSON.stringify({ subTaskId: item.id, text, kind }),
    },
  });
  return { id: item.id, created: true };
}

// Clamp a self-reported minutes value to a sane non-negative integer, or null.
function normalizeMinutes(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(Math.round(value), 60 * 24 * 365); // cap at a year of minutes
}

export async function setSubTaskCompletion(args: {
  subTaskId: string;
  completed: boolean;
  // undefined = leave minutes unchanged; a number/null sets/clears effort
  // (only meaningful while completed — reopening always clears it).
  minutesSpent?: number | null;
  actorUserId: string;
  expectTaskId?: string;
  client?: TxClient;
}): Promise<{ id: string; taskId: string; completedAt: Date | null; minutesSpent: number | null } | null> {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "subtask-checklist-actions",
    entryPoint: "setSubTaskCompletion",
    client: args.client ?? db,
  });
  const client = args.client ?? db;
  const item = await client.subTask.findUnique({
    where: { id: args.subTaskId },
    select: {
      id: true,
      taskId: true,
      text: true,
      completedAt: true,
      minutesSpent: true,
      task: { select: { projectId: true } },
    },
  });
  if (!item) return null;
  if (args.expectTaskId && item.taskId !== args.expectTaskId) return null;

  const wasDone = item.completedAt !== null;
  const completionChanged = wasDone !== args.completed;
  const completedAt = args.completed ? (item.completedAt ?? new Date()) : null;

  // Resolve next minutes: reopening clears it; otherwise apply an explicit value
  // if one was passed, else leave it as-is.
  const nextMinutes = !args.completed
    ? null
    : args.minutesSpent !== undefined
      ? normalizeMinutes(args.minutesSpent)
      : item.minutesSpent;
  const minutesChanged = nextMinutes !== item.minutesSpent;

  if (!completionChanged && !minutesChanged) {
    // Idempotent no-op — don't churn the activity feed.
    return { id: item.id, taskId: item.taskId, completedAt: item.completedAt, minutesSpent: item.minutesSpent };
  }

  const kind = completionChanged
    ? args.completed
      ? "task.subtask.complete"
      : "task.subtask.reopen"
    : "task.subtask.time";
  // The row write and its audit row stay atomic either way: on the caller's
  // transaction when one was supplied, in our own when it was not.
  const write = async (tx: TxClient) => {
    await tx.subTask.update({ where: { id: item.id }, data: { completedAt, minutesSpent: nextMinutes } });
    await tx.activityLog.create({
      data: {
        projectId: item.task.projectId,
        taskId: item.taskId,
        userId: args.actorUserId,
        kind,
        payload: JSON.stringify({ subTaskId: item.id, text: item.text, minutesSpent: nextMinutes }),
      },
    });
  };
  if (args.client) await write(args.client);
  else await db.$transaction((tx) => write(tx));
  return { id: item.id, taskId: item.taskId, completedAt, minutesSpent: nextMinutes };
}

export async function deleteSubTaskItem(args: {
  subTaskId: string;
  actorUserId: string;
  expectTaskId?: string;
  client?: TxClient;
}): Promise<{ taskId: string } | null> {
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "subtask-checklist-actions",
    entryPoint: "deleteSubTaskItem",
    client: args.client ?? db,
  });
  const client = args.client ?? db;
  const item = await client.subTask.findUnique({
    where: { id: args.subTaskId },
    select: {
      id: true,
      taskId: true,
      text: true,
      task: { select: { projectId: true } },
    },
  });
  if (!item) return null;
  if (args.expectTaskId && item.taskId !== args.expectTaskId) return null;

  const write = async (tx: TxClient) => {
    await tx.subTask.delete({ where: { id: item.id } });
    await tx.activityLog.create({
      data: {
        projectId: item.task.projectId,
        taskId: item.taskId,
        userId: args.actorUserId,
        kind: "task.subtask.delete",
        payload: JSON.stringify({ subTaskId: item.id, text: item.text }),
      },
    });
  };
  if (args.client) await write(args.client);
  else await db.$transaction((tx) => write(tx));
  return { taskId: item.taskId };
}

export async function reorderSubTaskItems(args: {
  taskId: string;
  orderedIds: string[];
}): Promise<void> {
  const existing = await db.subTask.findMany({
    where: { taskId: args.taskId },
    select: { id: true },
  });
  const valid = new Set(existing.map((e) => e.id));
  const ids = args.orderedIds.filter((id) => valid.has(id));
  if (ids.length === 0) return;
  await db.$transaction(
    ids.map((id, index) =>
      db.subTask.update({ where: { id }, data: { rank: index + 1 } }),
    ),
  );
}
