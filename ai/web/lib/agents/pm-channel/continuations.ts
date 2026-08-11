// ENV-118 — the continuation outbox.
//
// A continuation-required workflow action (start, add_subtask, ...) is a step
// inside an execution episode. Arming a continuation row in the SAME
// transaction as the run/job write is the crash-safety property the Epic asks
// for: if the process dies between "start task" and "queue the next turn",
// the armed row survives and the drain still schedules the turn.
//
// Lifecycle:
//   armed      — a continue action happened; the turn is still running.
//   queued     — the turn ended with no episode-terminal action. Drain it.
//   dispatching— a drain worker holds the row.
//   dispatched — a fresh execution turn was enqueued.
//   superseded — an episode-terminal action, a cancel, or a precondition that
//                says the episode legitimately ended. No turn is scheduled.
//   failed     — the drain could not enqueue a turn within its attempt budget.

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";

export const CONTINUATION_OPEN_STATUSES = ["armed", "queued", "dispatching"] as const;

type TxClient = Prisma.TransactionClient | typeof db;

/**
 * Arm one continuation per run inside the caller's transaction. Idempotent on
 * (runId, messageId, action): repeating the same action in one episode renews
 * the row rather than queueing a second turn.
 *
 * `status` defaults to `armed`, which is right while the turn is still running:
 * the run's settle promotes it to `queued`. ENV-121's rollover seal can happen
 * AFTER its run has already settled (the fenced turn ended, then PM wrote the
 * derived checkpoint), and there is no settle left to promote the row — those
 * callers pass `queued` so the drain can see it.
 */
export async function armPmChannelContinuations(
  tx: TxClient,
  args: {
    runs: { id: string; projectId: string | null; taskId: string | null; epicId: string | null }[];
    agentSlug: string;
    messageId: string;
    action: string;
    now: Date;
    status?: "armed" | "queued";
  },
) {
  const status = args.status ?? "armed";
  for (const run of args.runs) {
    // Only task episodes can be continued: an epic workflow turn has no
    // assignee-owned implementation loop to resume.
    if (!run.taskId) continue;
    await tx.pmChannelContinuation.upsert({
      where: {
        runId_messageId_action: {
          runId: run.id,
          messageId: args.messageId,
          action: args.action,
        },
      },
      create: {
        runId: run.id,
        agentSlug: args.agentSlug,
        projectId: run.projectId,
        taskId: run.taskId,
        epicId: run.epicId,
        messageId: args.messageId,
        action: args.action,
        status,
        availableAt: args.now,
      },
      update: {
        status,
        availableAt: args.now,
        lastError: null,
      },
    });
  }
}

/**
 * An episode-terminal action (or a cancel) closes the episode: every open
 * continuation for those runs becomes irrelevant.
 */
export async function supersedePmChannelContinuations(
  tx: TxClient,
  args: { runIds: string[]; reason: string },
) {
  if (args.runIds.length === 0) return;
  await tx.pmChannelContinuation.updateMany({
    where: {
      runId: { in: args.runIds },
      status: { in: [...CONTINUATION_OPEN_STATUSES] },
    },
    data: { status: "superseded", lastError: args.reason },
  });
}

/**
 * The turn ended. Any still-armed continuation becomes drainable, which is
 * what turns "the agent called start and then said nothing" into a scheduled
 * next turn instead of a falsely successful workflow.
 *
 * Returns the number of continuations moved to `queued`.
 */
export async function queuePmChannelContinuationsForRun(args: {
  runId: string;
  now?: Date;
}): Promise<number> {
  const now = args.now ?? new Date();
  const updated = await db.pmChannelContinuation.updateMany({
    where: { runId: args.runId, status: "armed" },
    data: { status: "queued", availableAt: now },
  });
  return updated.count;
}

/** Does an open continuation already own the next turn for this run? */
export async function runHasOpenPmChannelContinuation(runId: string) {
  const row = await db.pmChannelContinuation.findFirst({
    where: { runId, status: { in: [...CONTINUATION_OPEN_STATUSES] } },
    select: { id: true },
  });
  return Boolean(row);
}

/**
 * Does an open or already-dispatched continuation own the next turn for this
 * (task, agent)? The legacy reply-time auto-continuation consults this so the
 * two paths can never both enqueue a turn and produce two active runs in one
 * lane (WFI-001).
 */
export async function taskHasPmChannelContinuationForMessage(args: {
  taskId: string;
  agentSlug: string;
  messageId: string;
}) {
  const row = await db.pmChannelContinuation.findFirst({
    where: {
      taskId: args.taskId,
      agentSlug: args.agentSlug,
      messageId: args.messageId,
      status: { in: [...CONTINUATION_OPEN_STATUSES, "dispatched"] },
    },
    select: { id: true },
  });
  return Boolean(row);
}
