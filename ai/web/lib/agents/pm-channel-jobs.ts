import { db } from "@/lib/db";
import {
  dispatchOpenClawPmChannelTurn,
  parsePmChannelReplyTarget,
  sendOpenClawPmChannelTurn,
  type SendPmChannelTurnArgs,
  type SendPmChannelTurnResult,
} from "@/lib/agents/openclaw-pm-channel";
import {
  pmChannelRunTargetKey,
  recordPmChannelRunQueued,
} from "@/lib/agents/pm-channel-runs";
import { publishPmChannelStreamEventDurably } from "@/lib/agents/pm-channel-stream-log";
import { rollbackDispatchedMessageId } from "@/lib/agents/session-bindings";

type DispatchJobPayload = Omit<SendPmChannelTurnArgs, "fetchImpl">;

const MAX_ATTEMPTS = Number.parseInt(process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS ?? "3", 10);
const CLAIM_TIMEOUT_MS = Number.parseInt(process.env.PM_CHANNEL_JOB_CLAIM_TIMEOUT_MS ?? "120000", 10);
const RECOVERY_MAX_AGE_MS = Number.parseInt(process.env.PM_CHANNEL_JOB_RECOVERY_MAX_AGE_MS ?? "21600000", 10);

function flagDisabled(value: string | undefined) {
  return value === "0" || value === "false" || value === "no" || value === "off";
}

// ZL-002: async dispatch is the default send path. The send action persists
// the message + enqueues a job and returns immediately after DB commit;
// gateway dispatch happens off the request via the worker. Set
// PM_ASYNC_DISPATCH to a falsy value (0/false/no/off) to opt back into the
// legacy synchronous dispatch path (used by some tests).
export function pmAsyncDispatchEnabled() {
  return !flagDisabled(process.env.PM_ASYNC_DISPATCH);
}

function inlineWorkerNudgeEnabled() {
  return process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE !== "0";
}

function clippedError(error: string | null | undefined) {
  if (!error) return null;
  return error.length > 2_000 ? error.slice(0, 2_000) : error;
}

function serializableArgs(args: SendPmChannelTurnArgs): DispatchJobPayload {
  const { fetchImpl: _fetchImpl, ...rest } = args;
  return rest;
}

function parseJobPayload(value: string): DispatchJobPayload {
  const payload = JSON.parse(value) as DispatchJobPayload;
  const target = parsePmChannelReplyTarget(payload.replyTarget);
  if (!target) throw new Error("Invalid PM channel job reply target");
  return { ...payload, replyTarget: target };
}

function retryDelayMs(attemptCount: number) {
  const base = Number.parseInt(process.env.PM_CHANNEL_JOB_RETRY_BASE_MS ?? "15000", 10);
  const boundedBase = Number.isFinite(base) && base > 0 ? base : 15_000;
  return Math.min(5 * 60_000, boundedBase * Math.max(1, 2 ** Math.max(0, attemptCount - 1)));
}

function claimTimeoutMs() {
  return Number.isFinite(CLAIM_TIMEOUT_MS) && CLAIM_TIMEOUT_MS > 0
    ? CLAIM_TIMEOUT_MS
    : 120_000;
}

function recoveryMaxAgeMs() {
  return Number.isFinite(RECOVERY_MAX_AGE_MS) && RECOVERY_MAX_AGE_MS > 0
    ? RECOVERY_MAX_AGE_MS
    : 21_600_000;
}

async function appendAndPublishStatus(args: {
  payload: DispatchJobPayload;
  runStatus: "queued" | "accepted" | "retryable" | "failed" | "complete" | "canceled";
  error?: string | null;
}) {
  publishPmChannelStreamEventDurably({
    target: args.payload.replyTarget,
    event: "status",
    runStatus: args.runStatus,
    error: args.error ?? undefined,
  });
}

export async function enqueueOpenClawPmChannelTurn(
  args: SendPmChannelTurnArgs,
): Promise<SendPmChannelTurnResult> {
  const payload = serializableArgs(args);
  const run = await recordPmChannelRunQueued({
    target: args.replyTarget,
    kind: args.kind,
    projectId: args.projectId ?? null,
    gatewayPort: args.gatewayPort,
    sessionKey: args.sessionKey,
  });
  if (!run) {
    return {
      ok: false,
      driver: "openclaw-pm-channel",
      error: "failed to persist PM channel run",
    };
  }

  await db.pmChannelJob.upsert({
    where: { runId: run.id },
    create: {
      runId: run.id,
      agentSlug: args.agentSlug,
      kind: args.kind,
      payload: JSON.stringify(payload),
      status: "queued",
      lastError: null,
    },
    update: {
      agentSlug: args.agentSlug,
      kind: args.kind,
      payload: JSON.stringify(payload),
      status: "queued",
      availableAt: new Date(),
      claimedBy: null,
      claimedAt: null,
      acceptedAt: null,
      completedAt: null,
      lastError: null,
    },
  });
  await appendAndPublishStatus({ payload, runStatus: "queued" });
  if (inlineWorkerNudgeEnabled()) {
    setTimeout(() => {
      runPmChannelWorkerOnce(`pm-inline:${process.pid}`).catch((err) => {
        console.warn("[pm-channel] inline worker nudge failed", err);
      });
    }, 0);
  }
  return { ok: true, status: 202, driver: "openclaw-pm-channel" };
}

export async function sendOrQueueOpenClawPmChannelTurn(
  args: SendPmChannelTurnArgs,
): Promise<SendPmChannelTurnResult> {
  if (pmAsyncDispatchEnabled()) {
    return enqueueOpenClawPmChannelTurn(args);
  }
  return sendOpenClawPmChannelTurn(args);
}

export async function claimNextPmChannelJob(workerId: string) {
  const now = new Date();
  await requeueStaleClaimedPmChannelJobs(now);
  const job = await db.pmChannelJob.findFirst({
    where: {
      status: { in: ["queued", "retryable"] },
      availableAt: { lte: now },
    },
    orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    select: { id: true, status: true },
  });
  if (!job) return null;

  const claimed = await db.pmChannelJob.updateMany({
    where: {
      id: job.id,
      status: job.status,
      availableAt: { lte: now },
    },
    data: {
      status: "claimed",
      claimedBy: workerId,
      claimedAt: now,
      attemptCount: { increment: 1 },
    },
  });
  if (claimed.count !== 1) return null;

  return db.pmChannelJob.findUnique({
    where: { id: job.id },
    include: { run: true },
  });
}

export async function requeueStaleClaimedPmChannelJobs(now = new Date()) {
  const staleBefore = new Date(now.getTime() - claimTimeoutMs());
  const recentAfter = new Date(now.getTime() - recoveryMaxAgeMs());
  const stale = await db.pmChannelJob.findMany({
    where: {
      OR: [
        { status: "claimed", claimedAt: { gt: recentAfter, lt: staleBefore } },
        {
          status: "accepted",
          acceptedAt: { gt: recentAfter, lt: staleBefore },
          run: {
            streamingAt: null,
            completedAt: null,
            failedAt: null,
          },
        },
      ],
    },
    take: 50,
    select: {
      id: true,
      runId: true,
      payload: true,
      attemptCount: true,
      status: true,
    },
  });
  for (const job of stale) {
    const exhausted = job.attemptCount >= (Number.isFinite(MAX_ATTEMPTS) && MAX_ATTEMPTS > 0 ? MAX_ATTEMPTS : 3);
    const status = exhausted ? "failed" : "retryable";
    const error = exhausted
      ? `PM channel job ${job.status} lease expired after max attempts`
      : `PM channel job ${job.status} lease expired; requeued`;
    await db.$transaction([
      db.pmChannelJob.updateMany({
        where: { id: job.id, status: job.status },
        data: {
          status,
          availableAt: now,
          claimedBy: null,
          claimedAt: null,
          lastError: error,
        },
      }),
      db.pmChannelRun.update({
        where: { id: job.runId },
        data: {
          status,
          error,
          failedAt: exhausted ? now : null,
          lastEventAt: now,
        },
      }),
    ]);
    try {
      const payload = parseJobPayload(job.payload);
      appendAndPublishStatus({
        payload,
        runStatus: status,
        error,
      }).catch((err) => {
        console.warn("[pm-channel] failed to publish stale claim recovery", {
          jobId: job.id,
          error: err,
        });
      });
      if (exhausted) await rollbackDispatchedTurnBinding(payload);
    } catch (err) {
      console.warn("[pm-channel] failed to publish stale claim recovery", {
        jobId: job.id,
        error: err,
      });
    }
  }
  return stale.length;
}

export async function runPmChannelJob(job: NonNullable<Awaited<ReturnType<typeof claimNextPmChannelJob>>>) {
  const payload = parseJobPayload(job.payload);
  const currentRun = await db.pmChannelRun.findUnique({
    where: { id: job.runId },
    select: { status: true },
  });
  if (currentRun?.status === "canceled") {
    await db.pmChannelJob.update({
      where: { id: job.id },
      data: {
        status: "canceled",
        claimedBy: null,
        claimedAt: null,
        completedAt: new Date(),
        lastError: null,
      },
    });
    await appendAndPublishStatus({ payload, runStatus: "canceled" });
    return { ok: true, status: 200, driver: "openclaw-pm-channel" } satisfies SendPmChannelTurnResult;
  }
  const result = await dispatchOpenClawPmChannelTurn(payload);
  const now = new Date();

  if (result.ok) {
    await db.pmChannelJob.update({
      where: { id: job.id },
      data: {
        status: "accepted",
        acceptedAt: now,
        lastError: null,
      },
    });
    await appendAndPublishStatus({ payload, runStatus: "accepted" });
    return result;
  }

  const attemptCount = job.attemptCount;
  const exhausted = attemptCount >= (Number.isFinite(MAX_ATTEMPTS) && MAX_ATTEMPTS > 0 ? MAX_ATTEMPTS : 3);
  const status = exhausted ? "failed" : "retryable";
  const error = clippedError(result.error ?? "PM channel dispatch failed");
  await db.$transaction([
    db.pmChannelJob.update({
      where: { id: job.id },
      data: {
        status,
        availableAt: new Date(now.getTime() + (exhausted ? 0 : retryDelayMs(attemptCount))),
        claimedBy: null,
        claimedAt: null,
        lastError: error,
      },
    }),
    db.pmChannelRun.update({
      where: { id: job.runId },
      data: {
        status,
        error,
        failedAt: exhausted ? now : null,
        lastEventAt: now,
      },
    }),
  ]);
  await appendAndPublishStatus({
    payload,
    runStatus: status,
    error,
  });
  if (exhausted) {
    await rollbackDispatchedTurnBinding(payload);
  }
  return result;
}

// When a room-chat turn fails for good, roll back the optimistic incremental
// baseline so the next turn rebuilds full context (see rollbackDispatchedMessageId).
// Only task-chat/epic-chat advance the binding; comments and direct chats do not.
async function rollbackDispatchedTurnBinding(payload: DispatchJobPayload) {
  const target = payload.replyTarget;
  if (target.kind === "task-chat") {
    await rollbackDispatchedMessageId({
      scopeType: "task",
      scopeId: target.taskId,
      agentSlug: target.agentSlug,
      messageId: target.messageId,
    });
  } else if (target.kind === "epic-chat") {
    await rollbackDispatchedMessageId({
      scopeType: "epic",
      scopeId: target.epicId,
      agentSlug: target.agentSlug,
      messageId: target.messageId,
    });
  }
}

export async function runPmChannelWorkerOnce(workerId = `pm-channel-worker:${process.pid}`) {
  const job = await claimNextPmChannelJob(workerId);
  if (!job) return { claimed: false as const };
  const result = await runPmChannelJob(job);
  return { claimed: true as const, jobId: job.id, ok: result.ok, error: result.error ?? null };
}

function workerDrainMaxJobs() {
  const value = Number.parseInt(process.env.PM_CHANNEL_WORKER_DRAIN_MAX_JOBS ?? "25", 10);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 25;
}

export async function runPmChannelWorkerDrain(
  workerId = `pm-channel-worker:${process.pid}`,
  maxJobs = workerDrainMaxJobs(),
) {
  const limit = Number.isFinite(maxJobs) && maxJobs > 0 ? Math.floor(maxJobs) : 1;
  let claimed = 0;
  let accepted = 0;
  let retryableOrFailed = 0;
  const errors: string[] = [];

  for (let i = 0; i < limit; i += 1) {
    const outcome = await runPmChannelWorkerOnce(workerId);
    if (!outcome.claimed) break;
    claimed += 1;
    if (outcome.ok) {
      accepted += 1;
    } else {
      retryableOrFailed += 1;
      if (outcome.error) errors.push(clippedError(outcome.error) ?? outcome.error);
    }
  }

  return { claimed, accepted, retryableOrFailed, errors };
}

export async function markPmChannelJobCompleteForTarget(target: unknown) {
  const parsed = parsePmChannelReplyTarget(target);
  if (!parsed) return;
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(parsed) },
    select: { id: true },
  });
  if (!run) return;
  await db.pmChannelJob.updateMany({
    where: { runId: run.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
    data: { status: "complete", completedAt: new Date(), lastError: null },
  });
}

export async function pmChannelQueueStats() {
  const [queued, claimed, retryable, failed, oldestQueued, recentErrors] = await Promise.all([
    db.pmChannelJob.count({ where: { status: "queued" } }),
    db.pmChannelJob.count({ where: { status: "claimed" } }),
    db.pmChannelJob.count({ where: { status: "retryable" } }),
    db.pmChannelJob.count({ where: { status: "failed" } }),
    db.pmChannelJob.findFirst({
      where: { status: { in: ["queued", "retryable"] } },
      orderBy: { availableAt: "asc" },
      select: { availableAt: true, agentSlug: true, kind: true, lastError: true },
    }),
    db.pmChannelJob.findMany({
      where: { lastError: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, agentSlug: true, kind: true, status: true, attemptCount: true, lastError: true, updatedAt: true },
    }),
  ]);
  return { queued, claimed, retryable, failed, oldestQueued, recentErrors };
}

export async function appendPmChannelCompletionEvent(target: unknown) {
  const parsed = parsePmChannelReplyTarget(target);
  if (!parsed) return;
  publishPmChannelStreamEventDurably({ target: parsed, event: "done", runStatus: "complete" });
}
