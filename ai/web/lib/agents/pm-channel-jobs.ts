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
import { publishPmChannelStreamEvent } from "@/lib/agents/pm-channel-stream";
import {
  appendPmChannelStreamEvent,
  appendPmChannelStreamEventForTarget,
} from "@/lib/agents/pm-channel-stream-log";

type DispatchJobPayload = Omit<SendPmChannelTurnArgs, "fetchImpl">;

const MAX_ATTEMPTS = Number.parseInt(process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS ?? "3", 10);

function flagEnabled(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function pmAsyncDispatchEnabled() {
  return flagEnabled(process.env.PM_ASYNC_DISPATCH);
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

async function appendAndPublishStatus(args: {
  runId: string;
  payload: DispatchJobPayload;
  runStatus: "queued" | "accepted" | "retryable" | "failed" | "complete";
  error?: string | null;
}) {
  const persisted = await appendPmChannelStreamEvent({
    runId: args.runId,
    event: "status",
    input: {
      event: "status",
      runStatus: args.runStatus,
      error: args.error ?? undefined,
    },
  });
  publishPmChannelStreamEvent({
    target: args.payload.replyTarget,
    event: "status",
    runStatus: args.runStatus,
    error: args.error ?? undefined,
    seq: persisted.seq,
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
  await appendAndPublishStatus({ runId: run.id, payload, runStatus: "queued" });
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

export async function runPmChannelJob(job: NonNullable<Awaited<ReturnType<typeof claimNextPmChannelJob>>>) {
  const payload = parseJobPayload(job.payload);
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
    await appendAndPublishStatus({ runId: job.runId, payload, runStatus: "accepted" });
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
    runId: job.runId,
    payload,
    runStatus: status,
    error,
  });
  return result;
}

export async function runPmChannelWorkerOnce(workerId = `pm-channel-worker:${process.pid}`) {
  const job = await claimNextPmChannelJob(workerId);
  if (!job) return { claimed: false as const };
  const result = await runPmChannelJob(job);
  return { claimed: true as const, jobId: job.id, ok: result.ok, error: result.error ?? null };
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
  await appendPmChannelStreamEventForTarget({ target: parsed, event: "done", runStatus: "complete" });
}
