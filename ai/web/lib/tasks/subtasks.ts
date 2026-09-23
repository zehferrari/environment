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

import type { Prisma } from "@prisma/client";

import { ReviewCorrectionError } from "./review-findings-input";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
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
    throw new ReviewCorrectionError(`A task may have at most ${MAX_SUBTASKS_PER_TASK} checklist items.`);
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
  completionEvidence?: string;
  // undefined = leave minutes unchanged; a number/null sets/clears effort
  // (only meaningful while completed — reopening always clears it).
  minutesSpent?: number | null;
  actorUserId: string;
  expectTaskId?: string;
  client?: TxClient;
}): Promise<{ id: string; taskId: string; completedAt: Date | null; minutesSpent: number | null } | null> {
  if (!args.client) return db.$transaction(tx => setSubTaskCompletion({ ...args, client: tx }));
  const client = args.client;
  const item = await client.subTask.findUnique({
    where: { id: args.subTaskId },
    select: {
      id: true,
      taskId: true,
      text: true,
      completedAt: true,
      reviewFinding: true,
      minutesSpent: true,
      task: { select: { projectId: true } },
    },
  });
  if (!item) return null;
  if (args.expectTaskId && item.taskId !== args.expectTaskId) return null;

  const finding = item.reviewFinding;
  const evidence = args.completionEvidence?.trim();
  if (finding && args.completed && (!item.completedAt || finding.status !== "resolved") && (!evidence || evidence.length > 10000)) {
    throw new ReviewCorrectionError("This correction requires completionEvidence describing the fix and verification before it can be marked complete.");
  }
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

  const findingChanged = !!finding && (finding.status !== (args.completed ? "resolved" : "open") || !!evidence && evidence !== finding.completionEvidence);
  if (!completionChanged && !minutesChanged && !findingChanged) {
    // Idempotent no-op — don't churn the activity feed.
    return { id: item.id, taskId: item.taskId, completedAt: item.completedAt, minutesSpent: item.minutesSpent };
  }

  const kind = completionChanged
    ? args.completed
      ? "task.subtask.complete"
      : "task.subtask.reopen"
    : findingChanged ? "task.review_finding.evidence" : "task.subtask.time";
  // The row write and its audit row stay atomic either way: on the caller's
  // transaction when one was supplied, in our own when it was not.
  const write = async (tx: TxClient) => {
    await tx.subTask.update({ where: { id: item.id }, data: { completedAt, minutesSpent: nextMinutes } });
    if (finding) await tx.reviewFinding.update({ where: { id: finding.id }, data: {
      status: args.completed ? "resolved" : "open",
      completionEvidence: args.completed ? (evidence || finding.completionEvidence) : null,
      resolvedAt: completedAt, resolvedById: args.completed ? args.actorUserId : null,
    } });
    await tx.activityLog.create({
      data: {
        projectId: item.task.projectId,
        taskId: item.taskId,
        userId: args.actorUserId,
        kind,
        payload: JSON.stringify({ subTaskId: item.id, text: item.text, minutesSpent: nextMinutes, findingId: finding?.id, completionEvidence: evidence }),
      },
    });
  };
  if (args.client) await write(args.client);
  else await db.$transaction((tx) => write(tx));
  return { id: item.id, taskId: item.taskId, completedAt, minutesSpent: nextMinutes };
}

export async function deleteSubTaskItem(args: {
  supersededReason?: string;
  ownerInstructionCommentId?: string;
  subTaskId: string;
  actorUserId: string;
  expectTaskId?: string;
  client?: TxClient;
}): Promise<{ taskId: string } | null> {
  if (!args.client) return db.$transaction(tx => deleteSubTaskItem({ ...args, client: tx }));
  const client = args.client;
  const item = await client.subTask.findUnique({
    where: { id: args.subTaskId },
    select: {
      id: true,
      taskId: true,
      text: true,
      reviewFinding: { include: { reviewRun: { select: { reviewedAt: true } } } },
      task: { select: { projectId: true, assigneeId: true, actingManagerId: true, reporterId: true, epic: { select: { status: true, actingManagerId: true } } } },
    },
  });
  if (!item) return null;
  if (args.expectTaskId && item.taskId !== args.expectTaskId) return null;

  const finding = item.reviewFinding;
  if (args.supersededReason && !finding) throw new ReviewCorrectionError("Supersession applies only to a review correction.");
  if (finding) {
    const reviewerId = resolveReviewOwnerId(item.task);
    const actor = await client.user.findUnique({ where: { id: args.actorUserId }, select: { kind: true, isOwner: true } });
    const owner = actor?.kind === "human" && actor.isOwner;
    if (!owner && (args.actorUserId !== reviewerId || args.actorUserId === item.task.assigneeId)) throw new ReviewCorrectionError("Only the independent reviewer or owner can supersede a review correction.");
    const reason = args.supersededReason?.trim();
    if (!reason || reason.length > 10000 || !args.ownerInstructionCommentId) throw new ReviewCorrectionError("Superseding a correction requires a reason and the exact ownerInstructionCommentId; unfinished corrections cannot be deleted.");
    const instruction = await client.comment.findFirst({ where: { id: args.ownerInstructionCommentId, taskId: item.taskId, deletedAt: null, user: { kind: "human", isOwner: true } } });
    if (!instruction || instruction.createdAt < (finding.reviewRun.reviewedAt ?? finding.createdAt)) throw new ReviewCorrectionError("Cite a current owner instruction on this task, posted after the finding, that supersedes this requirement.");
  }
  const write = async (tx: TxClient) => {
    if (finding) await tx.reviewFinding.update({ where: { id: finding.id }, data: {
      status: "superseded", supersededReason: args.supersededReason!.trim(),
      ownerInstructionCommentId: args.ownerInstructionCommentId, resolvedById: args.actorUserId, resolvedAt: new Date(),
    } });
    await tx.subTask.delete({ where: { id: item.id } });
    await tx.activityLog.create({
      data: {
        projectId: item.task.projectId,
        taskId: item.taskId,
        userId: args.actorUserId,
        kind: finding ? "task.review_finding.superseded" : "task.subtask.delete",
        payload: JSON.stringify({ subTaskId: item.id, text: item.text, findingId: finding?.id, reason: args.supersededReason, ownerInstructionCommentId: args.ownerInstructionCommentId }),
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
