// ORCH-01 — Task workflow cycle lifecycle.
//
// One cycle = one implementation attempt from start through validation and
// review. The cycle is the durable review-attempt identity: a candidate SHA is
// evidence, not a process identity. The same SHA may legitimately appear in a
// later cycle after the prior cycle closed (V23-36 regression).
//
// Cycle lifecycle:
//   - start from To Do opens sequence N+1 and stores it on
//     Task.activeWorkflowCycleId.
//   - ready_for_review updates the cycle's candidateSha; it does not create
//     another cycle.
//   - successful validation creates the immutable review lease (ReviewRun) for
//     that cycle.
//   - review_feedback / validation failure / cancellation / abandonment closes
//     the cycle with a specific outcome.
//   - accepted repository finalization closes the cycle as `completed` in the
//     same transaction that moves Review to Done.
//   - any new start requires the prior cycle to be terminal.
//
// All cycle writes go through this module so the "one open cycle per task"
// invariant is enforced in one place. Callers must pass a Prisma transaction
// client because cycle mutations commit atomically with the transition that
// opens/closes them (core invariant 4: atomic decision and effects).

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const CYCLE_OUTCOMES = [
  "completed",
  "changes_requested",
  "validation_failed",
  "cancelled",
  "abandoned",
] as const;
export type CycleOutcome = (typeof CYCLE_OUTCOMES)[number];

export const CYCLE_STATUSES = ["open", "closed"] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export type TaskWorkflowCycleRow = {
  id: string;
  taskId: string;
  sequence: number;
  status: CycleStatus;
  outcome: CycleOutcome | null;
  openedWorkflowVersion: number;
  closedWorkflowVersion: number | null;
  openedByTransitionId: string | null;
  closedByTransitionId: string | null;
  baseSha: string | null;
  candidateSha: string | null;
};

class CycleInvariantError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CycleInvariantError";
  }
}

export { CycleInvariantError };

/**
 * Allocate the next cycle sequence for a task and open it. Must run inside the
 * same transaction as the transition kernel call that opens the implementation
 * attempt (core invariant 4: atomic decision and effects).
 *
 * Sequence allocation is concurrency-safe: the @@unique([taskId, sequence])
 * index means two concurrent `open` calls produce one winner and one
 * constraint violation. The winner's sequence is max(existing)+1.
 *
 * Invariant 5 (one open cycle per task): a task with a non-terminal cycle
 * cannot open a new one. Callers that need to close first must call
 * closeTaskWorkflowCycle in the same transaction before this.
 */
export async function openTaskWorkflowCycle(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    openedWorkflowVersion: number;
    openedByTransitionId?: string | null;
    baseSha?: string | null;
  },
): Promise<TaskWorkflowCycleRow> {
  // Reject if an open cycle already exists. This is the explicit invariant 5
  // guard; the transition kernel's expectedVersion check also catches the
  // common concurrent-start case, but this is the durable assertion.
  const existingOpen = await tx.taskWorkflowCycle.findFirst({
    where: { taskId: args.taskId, status: "open" },
    select: { id: true, sequence: true },
  });
  if (existingOpen) {
    throw new CycleInvariantError(
      `Task ${args.taskId} already has an open workflow cycle (sequence ${existingOpen.sequence}); close it before opening a new one.`,
      "open_cycle_exists",
    );
  }

  const lastSequence = await tx.taskWorkflowCycle.aggregate({
    where: { taskId: args.taskId },
    _max: { sequence: true },
  });
  const nextSequence = (lastSequence._max.sequence ?? 0) + 1;

  const cycle = await tx.taskWorkflowCycle.create({
    data: {
      taskId: args.taskId,
      sequence: nextSequence,
      status: "open",
      openedWorkflowVersion: args.openedWorkflowVersion,
      openedByTransitionId: args.openedByTransitionId ?? null,
      baseSha: args.baseSha ?? null,
    },
  });
  await tx.task.update({
    where: { id: args.taskId },
    data: { activeWorkflowCycleId: cycle.id },
  });
  return {
    id: cycle.id,
    taskId: cycle.taskId,
    sequence: cycle.sequence,
    status: cycle.status as CycleStatus,
    outcome: (cycle.outcome as CycleOutcome | null) ?? null,
    openedWorkflowVersion: cycle.openedWorkflowVersion,
    closedWorkflowVersion: cycle.closedWorkflowVersion,
    openedByTransitionId: cycle.openedByTransitionId,
    closedByTransitionId: cycle.closedByTransitionId,
    baseSha: cycle.baseSha,
    candidateSha: cycle.candidateSha,
  };
}

/**
 * Close the active cycle with a terminal outcome. Must run inside the same
 * transaction as the transition kernel call that closes the implementation
 * attempt (review_feedback / validation failure / finalization / cancel).
 *
 * Invariant 8 (immutable review decision): once a cycle's ReviewRun is
 * `accepted` or `changes_requested`, the cycle row's outcome reflects that
 * decision and is never modified.
 */
export async function closeTaskWorkflowCycle(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    outcome: CycleOutcome;
    closedWorkflowVersion?: number | null;
    closedByTransitionId?: string | null;
    candidateSha?: string | null;
  },
): Promise<TaskWorkflowCycleRow | null> {
  const current = await tx.task.findUnique({
    where: { id: args.taskId },
    select: { activeWorkflowCycleId: true },
  });
  if (!current?.activeWorkflowCycleId) return null;
  const updated = await tx.taskWorkflowCycle.update({
    where: { id: current.activeWorkflowCycleId },
    data: {
      status: "closed",
      outcome: args.outcome,
      closedWorkflowVersion: args.closedWorkflowVersion ?? null,
      closedByTransitionId: args.closedByTransitionId ?? null,
      candidateSha: args.candidateSha ?? undefined,
      closedAt: new Date(),
    },
  });
  await tx.task.update({
    where: { id: args.taskId },
    data: { activeWorkflowCycleId: null },
  });
  return {
    id: updated.id,
    taskId: updated.taskId,
    sequence: updated.sequence,
    status: updated.status as CycleStatus,
    outcome: updated.outcome as CycleOutcome | null,
    openedWorkflowVersion: updated.openedWorkflowVersion,
    closedWorkflowVersion: updated.closedWorkflowVersion,
    openedByTransitionId: updated.openedByTransitionId,
    closedByTransitionId: updated.closedByTransitionId,
    baseSha: updated.baseSha,
    candidateSha: updated.candidateSha,
  };
}

/**
 * Update the active cycle with the candidate SHA after a successful
 * ready_for_review submission. Does not create a new cycle (invariant: one
 * cycle per implementation attempt).
 */
export async function updateTaskWorkflowCycleCandidate(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    candidateSha: string | null;
    baseSha?: string | null;
  },
): Promise<TaskWorkflowCycleRow | null> {
  const current = await tx.task.findUnique({
    where: { id: args.taskId },
    select: { activeWorkflowCycleId: true },
  });
  if (!current?.activeWorkflowCycleId) return null;
  const updated = await tx.taskWorkflowCycle.update({
    where: { id: current.activeWorkflowCycleId },
    data: {
      candidateSha: args.candidateSha,
      ...(args.baseSha !== undefined ? { baseSha: args.baseSha } : {}),
    },
  });
  return {
    id: updated.id,
    taskId: updated.taskId,
    sequence: updated.sequence,
    status: updated.status as CycleStatus,
    outcome: updated.outcome as CycleOutcome | null,
    openedWorkflowVersion: updated.openedWorkflowVersion,
    closedWorkflowVersion: updated.closedWorkflowVersion,
    openedByTransitionId: updated.openedByTransitionId,
    closedByTransitionId: updated.closedByTransitionId,
    baseSha: updated.baseSha,
    candidateSha: updated.candidateSha,
  };
}

/**
 * Read the active cycle for a task, or null if the task is not in an
 * implementation/review attempt. Used by the orchestrator guards and the
 * context serializer.
 */
export async function getActiveTaskWorkflowCycle(
  taskId: string,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<TaskWorkflowCycleRow | null> {
  const task = await client.task.findUnique({
    where: { id: taskId },
    select: { activeWorkflowCycleId: true },
  });
  if (!task?.activeWorkflowCycleId) return null;
  const cycle = await client.taskWorkflowCycle.findUnique({
    where: { id: task.activeWorkflowCycleId },
  });
  if (!cycle) return null;
  return {
    id: cycle.id,
    taskId: cycle.taskId,
    sequence: cycle.sequence,
    status: cycle.status as CycleStatus,
    outcome: cycle.outcome as CycleOutcome | null,
    openedWorkflowVersion: cycle.openedWorkflowVersion,
    closedWorkflowVersion: cycle.closedWorkflowVersion,
    openedByTransitionId: cycle.openedByTransitionId,
    closedByTransitionId: cycle.closedByTransitionId,
    baseSha: cycle.baseSha,
    candidateSha: cycle.candidateSha,
  };
}

/**
 * Read a specific cycle by id. Used by review-handoff and the context
 * serializer to load a cycle-scoped review lease.
 */
export async function getTaskWorkflowCycle(
  cycleId: string,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<TaskWorkflowCycleRow | null> {
  const cycle = await client.taskWorkflowCycle.findUnique({
    where: { id: cycleId },
  });
  if (!cycle) return null;
  return {
    id: cycle.id,
    taskId: cycle.taskId,
    sequence: cycle.sequence,
    status: cycle.status as CycleStatus,
    outcome: cycle.outcome as CycleOutcome | null,
    openedWorkflowVersion: cycle.openedWorkflowVersion,
    closedWorkflowVersion: cycle.closedWorkflowVersion,
    openedByTransitionId: cycle.openedByTransitionId,
    closedByTransitionId: cycle.closedByTransitionId,
    baseSha: cycle.baseSha,
    candidateSha: cycle.candidateSha,
  };
}

/**
 * Idempotently attach a transition/outbox row to the active cycle. Called by
 * the transition kernel's dual-write path (ORCH-01 phase A) so legacy writes
 * carry cycle metadata without changing their existing call sites.
 *
 * No-op if the task has no active cycle (e.g. legacy Backlog-only tasks that
 * have never started). This preserves backwards compatibility during the
 * expand/dual-write rollout.
 */
export async function attachRowToActiveCycle(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    table: "workflowTransition" | "workflowOutbox";
    rowId: string;
  },
): Promise<void> {
  const task = await tx.task.findUnique({
    where: { id: args.taskId },
    select: { activeWorkflowCycleId: true },
  });
  if (!task?.activeWorkflowCycleId) return;
  if (args.table === "workflowTransition") {
    await tx.workflowTransition.update({
      where: { id: args.rowId },
      data: { workflowCycleId: task.activeWorkflowCycleId },
    });
  } else {
    await tx.workflowOutbox.update({
      where: { id: args.rowId },
      data: { workflowCycleId: task.activeWorkflowCycleId },
    });
  }
}