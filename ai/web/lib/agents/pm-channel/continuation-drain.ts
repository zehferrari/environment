// ENV-118 — the continuation outbox drain.
//
// Split from lib/agents/pm-channel/continuations.ts on purpose: the outbox
// WRITE primitives are called from runs.ts, and dispatching a continuation
// needs sendTaskWorkflowNotification, which imports the job queue, which
// imports runs.ts. Keeping the dispatcher in its own module keeps the run
// recorder's import graph free of the notification stack.

import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import {
  activeFormalBlockerStatesByTask,
  formalBlockerNeedsExternalInput,
} from "@/lib/tasks/formal-blocker";

const MAX_CONTINUATION_ATTEMPTS = 3;
const DRAIN_BATCH = 10;

function clippedError(error: string | null | undefined) {
  if (!error) return null;
  return error.length > 2_000 ? error.slice(0, 2_000) : error;
}

type ContinuationRow = {
  id: string;
  runId: string;
  agentSlug: string;
  taskId: string | null;
  projectId: string | null;
  messageId: string;
  action: string;
  attempts: number;
};

async function settle(
  id: string,
  status: "dispatched" | "superseded" | "failed",
  data: { lastError?: string | null; dispatchedMessageId?: string | null; dispatchedAt?: Date | null } = {},
) {
  await db.pmChannelContinuation.update({
    where: { id },
    data: {
      status,
      lastError: clippedError(data.lastError ?? null),
      dispatchedMessageId: data.dispatchedMessageId ?? null,
      dispatchedAt: data.dispatchedAt ?? null,
    },
  });
}

/**
 * Decide whether this continuation still deserves a turn, and enqueue one if
 * so. Preconditions mirror the reply-time helper: the task must still be an
 * active, In-Progress, agent-assigned repository episode with no external
 * blocker and no competing run.
 */
async function dispatchContinuation(row: ContinuationRow): Promise<"dispatched" | "superseded" | "failed"> {
  if (!row.taskId) {
    await settle(row.id, "superseded", { lastError: "continuation has no task scope" });
    return "superseded";
  }

  const task = await db.task.findUnique({
    where: { id: row.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      assigneeId: true,
      deletedAt: true,
      repositoryRun: { select: { phase: true } },
    },
  });
  if (!task || task.deletedAt || task.status !== "In Progress" || !task.assigneeId) {
    await settle(row.id, "superseded", { lastError: "task is no longer an active execution episode" });
    return "superseded";
  }
  if (task.repositoryRun && task.repositoryRun.phase !== "active") {
    await settle(row.id, "superseded", { lastError: "repository run is no longer active" });
    return "superseded";
  }

  const agent = await db.agent.findUnique({
    where: { slug: row.agentSlug },
    select: { user: { select: { id: true } } },
  });
  if (!agent?.user || agent.user.id !== task.assigneeId) {
    await settle(row.id, "superseded", { lastError: "continuation agent no longer owns the task" });
    return "superseded";
  }

  const lifecycleRows = await db.activityLog.findMany({
    where: {
      taskId: task.id,
      kind: {
        in: [
          "task.blocker",
          "task.extra_work.blocker",
          "task.blocker.cleared",
          "task.blocker.permission.granted",
        ],
      },
    },
    orderBy: { createdAt: "desc" },
    select: { taskId: true, kind: true, payload: true, createdAt: true },
  });
  const activeBlocker = activeFormalBlockerStatesByTask(lifecycleRows).get(task.id) ?? null;
  if (activeBlocker && formalBlockerNeedsExternalInput(activeBlocker)) {
    await settle(row.id, "superseded", { lastError: "a formal blocker is waiting on external input" });
    return "superseded";
  }

  // Two active runs in one lane is WFI-001. If something else is already
  // running for this agent on this task, that turn IS the continuation.
  const competingRun = await db.pmChannelRun.findFirst({
    where: {
      taskId: task.id,
      agentSlug: row.agentSlug,
      messageId: { not: row.messageId },
      status: { in: ["queued", "accepted", "streaming", "retryable"] },
    },
    select: { id: true },
  });
  if (competingRun) {
    await settle(row.id, "superseded", { lastError: "another run for this agent is already active on the task" });
    return "superseded";
  }

  const continuation = await sendTaskWorkflowNotification({
    taskId: task.id,
    targetUserId: task.assigneeId,
    actor: { id: agent.user.id, kind: "agent", username: row.agentSlug },
    reason: "monitor_recovery",
    body: [
      `Your execution turn for "${task.title}" recorded the workflow action \`${row.action}\`, which continues the episode rather than ending it, and then the turn ended without an episode-terminal action.`,
      "The task is still In Progress and PM has scheduled this fresh execution turn for you. Nothing about the previous turn was lost: check the task's current status, checklist, and comments before repeating any step.",
      "Continue the remaining implementation and verification now. Finish through ready_for_review, or record one precise external dependency with flag_blocker. Do not stop at another progress comment.",
    ].join("\n"),
  });

  if (!continuation) {
    const attempts = row.attempts;
    if (attempts >= MAX_CONTINUATION_ATTEMPTS) {
      await settle(row.id, "failed", { lastError: "could not enqueue a continuation turn" });
      return "failed";
    }
    await db.pmChannelContinuation.update({
      where: { id: row.id },
      data: {
        status: "queued",
        availableAt: new Date(Date.now() + 60_000 * attempts),
        lastError: "could not enqueue a continuation turn",
      },
    });
    return "failed";
  }

  const dispatchedAt = new Date();
  await settle(row.id, "dispatched", {
    dispatchedMessageId: continuation.messageId,
    dispatchedAt,
  });
  await db.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      userId: agent.user.id,
      kind: "task.workflow.continuation",
      targetAgent: row.agentSlug,
      payload: JSON.stringify({
        continuationId: row.id,
        runId: row.runId,
        sourceMessageId: row.messageId,
        action: row.action,
        continuationMessageId: continuation.messageId,
      }),
    },
  }).catch(() => {});
  return "dispatched";
}

/**
 * Claim queued continuation rows and turn each into a fresh execution turn.
 * Runs alongside the stale-job requeue in the PM channel worker drain.
 */
export async function drainPmChannelContinuations(args: { limit?: number; now?: Date } = {}) {
  const now = args.now ?? new Date();
  const limit = args.limit ?? DRAIN_BATCH;
  let dispatched = 0;
  let superseded = 0;
  let failed = 0;

  for (let i = 0; i < limit; i += 1) {
    const candidate = await db.pmChannelContinuation.findFirst({
      where: { status: "queued", availableAt: { lte: now } },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!candidate) break;

    const claimed = await db.pmChannelContinuation.updateMany({
      where: { id: candidate.id, status: "queued" },
      data: { status: "dispatching", attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;

    const row = await db.pmChannelContinuation.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        runId: true,
        agentSlug: true,
        taskId: true,
        projectId: true,
        messageId: true,
        action: true,
        attempts: true,
      },
    });
    if (!row) continue;

    try {
      const outcome = await dispatchContinuation(row);
      if (outcome === "dispatched") dispatched += 1;
      else if (outcome === "superseded") superseded += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error("[pm-channel] continuation drain failed", row.id, error);
      const message = error instanceof Error ? error.message : String(error);
      await db.pmChannelContinuation
        .update({
          where: { id: row.id },
          data: {
            status: row.attempts >= MAX_CONTINUATION_ATTEMPTS ? "failed" : "queued",
            availableAt: new Date(now.getTime() + 60_000 * Math.max(1, row.attempts)),
            lastError: clippedError(message),
          },
        })
        .catch(() => {});
    }
  }

  return { dispatched, superseded, failed };
}
