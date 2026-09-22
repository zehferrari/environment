import { db } from "@/lib/db";
import { prepareCompactTaskTurn } from "@/lib/agents/pm-channel/task-runtime";
import { isOwnerUserId } from "@/lib/auth/permissions";
import {
  dispatchOpenClawPmChannelTurn,
  parsePmChannelReplyTarget,
  sendOpenClawPmChannelTurn,
  type PmChannelReplyTarget,
  type SendPmChannelTurnArgs,
  type SendPmChannelTurnResult,
} from "@/lib/agents/pm-channel/openclaw";
import {
  pmChannelRunTargetKey,
  recordPmChannelRunQueued,
} from "@/lib/agents/pm-channel/runs";
import {
  reconcileAbandonedLeases,
  reserveExecutionLane,
  releaseExecutionLane,
} from "@/lib/agents/pm-channel/execution-lane";
import { publishPmChannelStreamEvent } from "@/lib/agents/pm-channel/stream";
import { enqueuePmChannelStreamDurability } from "@/lib/agents/pm-channel/stream-log";
import {
  rollbackDispatchedMessageId,
  rotateAgentSessionBinding,
} from "@/lib/agents/auth/session-bindings";
import { isPmTerminalFailureText } from "@/lib/agents/ops/pm-silence";
import { fenceSupersededPmChannelRuns } from "@/lib/agents/pm-channel/supersession";
import { rollOverTaskExecutionEpisodeForContextPressure } from "@/lib/agents/episodes/lifecycle";
import {
  armPmChannelContinuations,
  CONTEXT_PRESSURE_RECOVERY_ACTION,
} from "@/lib/agents/pm-channel/continuations";
import { resolveAgentTaskAccess } from "@/lib/agents/private-task-access";

// Idempotency discriminator for the turn-failure retry policy: only
// PM-generated notification/nudge turns are safe to auto-replay. Stamped at
// enqueue by sendTaskWorkflowNotification / sendEpicWorkflowNotification;
// everything else defaults to "conversation" (terminal on turn failure).
export type PmChannelTurnClass = "notification" | "conversation";

export type SendPmChannelTurnRequest = SendPmChannelTurnArgs & {
  turnClass?: PmChannelTurnClass;
};

type DispatchJobPayload = Omit<SendPmChannelTurnRequest, "fetchImpl">;

const MAX_ATTEMPTS = Number.parseInt(process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS ?? "3", 10);
const CLAIM_TIMEOUT_MS = Number.parseInt(process.env.PM_CHANNEL_JOB_CLAIM_TIMEOUT_MS ?? "120000", 10);
const ACCEPTED_TIMEOUT_MS = Number.parseInt(process.env.PM_CHANNEL_JOB_ACCEPTED_TIMEOUT_MS ?? "1800000", 10);
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

function serializableArgs(args: SendPmChannelTurnRequest): DispatchJobPayload {
  const { fetchImpl: _fetchImpl, ...rest } = args;
  return rest;
}

function parseJobPayload(value: string): DispatchJobPayload {
  const payload = JSON.parse(value) as DispatchJobPayload;
  const target = parsePmChannelReplyTarget(payload.replyTarget);
  if (!target) throw new Error("Invalid PM channel job reply target");
  return { ...payload, replyTarget: target };
}

async function dispatchTargetIsAuthorized(
  target: PmChannelReplyTarget,
  agentSlug: string,
) {
  if (target.kind === "direct") return true;
  if (target.kind === "epic-chat") {
    return Boolean(await db.epic.findFirst({
      where: { id: target.epicId, deletedAt: null, private: false },
      select: { id: true },
    }));
  }
  return (await resolveAgentTaskAccess({ taskId: target.taskId, agentSlug })).allowed;
}

async function cancelJobForPolicy(args: {
  job: { id: string; runId: string };
  payload: DispatchJobPayload;
  error: string;
}) {
  const now = new Date();
  await db.$transaction([
    db.pmChannelJob.update({
      where: { id: args.job.id },
      data: {
        status: "canceled",
        claimedBy: null,
        claimedAt: null,
        completedAt: now,
        lastError: args.error,
      },
    }),
    db.pmChannelRun.update({
      where: { id: args.job.runId },
      data: {
        status: "cancelled",
        error: args.error,
        completedAt: now,
        failedAt: null,
        finishedAt: now,
        finishedReason: "cancelled_by_policy",
        lastEventAt: now,
      },
    }),
    db.pmChannelContinuation.updateMany({
      where: { runId: args.job.runId, status: { in: ["armed", "queued", "dispatching"] } },
      data: { status: "superseded", lastError: "run canceled by dispatch policy" },
    }),
  ]);
  await appendAndPublishStatus({ payload: args.payload, runStatus: "cancelled", error: args.error });
  await rollbackDispatchedTurnBinding(args.payload);
  return { ok: true, status: 200, driver: "openclaw-pm-channel" } satisfies SendPmChannelTurnResult;
}

function retryDelayMs(attemptCount: number) {
  const base = Number.parseInt(process.env.PM_CHANNEL_JOB_RETRY_BASE_MS ?? "15000", 10);
  const boundedBase = Number.isFinite(base) && base > 0 ? base : 15_000;
  return Math.min(5 * 60_000, boundedBase * Math.max(1, 2 ** Math.max(0, attemptCount - 1)));
}

function maxAttempts() {
  return Number.isFinite(MAX_ATTEMPTS) && MAX_ATTEMPTS > 0 ? MAX_ATTEMPTS : 3;
}

// Same marker sendTaskWorkflowNotification/epic notifications put on the
// mirrored message body and ai-monitor keys its orphan scan on. Used only as
// a fallback classifier for jobs enqueued before turnClass existed.
const WORKFLOW_NOTIFICATION_PREFIX = "PM workflow notification for @";

function payloadTurnClass(payload: DispatchJobPayload): PmChannelTurnClass {
  if (payload.turnClass === "notification" || payload.turnClass === "conversation") {
    return payload.turnClass;
  }
  return payload.text.startsWith(WORKFLOW_NOTIFICATION_PREFIX) ? "notification" : "conversation";
}

// Turn-failure error classes that are safe to retry: the turn provably ended
// without a durable outcome (no visible reply / in-process gateway abort, the
// distinct strings the driver emits). Watchdog-labeled failures and dispatch
// errors are NOT in this set — they have their own ladders.
export function isRetryablePmChannelTurnFailure(error: string) {
  return (
    error === "Agent finished without posting a reply." ||
    error.startsWith("gateway aborted turn") ||
    isPmTerminalFailureText(error)
  );
}

// Second idempotency layer for retried turns: the agent is told the previous
// attempt may have partially completed. Prepended to the DISPATCHED copy of
// the payload only — never persisted into the job payload.
const RETRY_TURN_FAILURE_PREAMBLE =
  "NOTE: a previous attempt of this turn aborted mid-run and may have partially completed. "
  + "Verify the current task state (status, subtasks, comments) before repeating any action; "
  + "do not duplicate work already done.";

function claimTimeoutMs() {
  return Number.isFinite(CLAIM_TIMEOUT_MS) && CLAIM_TIMEOUT_MS > 0
    ? CLAIM_TIMEOUT_MS
    : 120_000;
}

function acceptedTimeoutMs() {
  return Number.isFinite(ACCEPTED_TIMEOUT_MS) && ACCEPTED_TIMEOUT_MS > 0
    ? ACCEPTED_TIMEOUT_MS
    : 1_800_000;
}

function recoveryMaxAgeMs() {
  return Number.isFinite(RECOVERY_MAX_AGE_MS) && RECOVERY_MAX_AGE_MS > 0
    ? RECOVERY_MAX_AGE_MS
    : 21_600_000;
}

async function appendAndPublishStatus(args: {
  payload: DispatchJobPayload;
  runStatus: "queued" | "accepted" | "delivered" | "waiting_capacity" | "admitted" | "completed" | "failed" | "timed_out" | "cancelled" | "superseded";
  error?: string | null;
}) {
  const input = {
    target: args.payload.replyTarget,
    event: "status" as const,
    runStatus: args.runStatus,
    error: args.error ?? undefined,
  };
  // Publishing remains immediate for in-process subscribers, but callers
  // must not return/disconnect their Prisma client until the durable frame is
  // stored. The old fire-and-forget helper left short-lived CLI producers
  // (`pm-workflow-nudge`) retrying forever against a disconnected engine.
  publishPmChannelStreamEvent(input);
  await enqueuePmChannelStreamDurability(input);
}

export async function enqueueOpenClawPmChannelTurn(
  args: SendPmChannelTurnRequest,
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

// Dispatch circuit breaker. A dead agent gateway once absorbed 878
// re-dispatches over 4 days (~40M tokens of prompts) with zero escalation:
// every run failed, and every failure triggered another full-context send.
// When the agent's recent runs are ALL failures, suppress further dispatches
// (recording a visible activity row) and let one probe through per cooldown
// window so recovery is still automatic once the gateway returns.
const BREAKER_CONSECUTIVE_FAILURES = 5;
const BREAKER_PROBE_INTERVAL_MS = 10 * 60 * 1000;

async function channelBreakerOpen(agentSlug: string): Promise<{ open: boolean; failures?: number }> {
  // Evaluate over TERMINAL runs only (failed/complete). In-flight rows
  // (queued/accepted/streaming) are upserted from a prior run's row, so
  // counting them would let a single in-flight probe reopen the gate for
  // every waiting dispatch. Order by updatedAt, not createdAt: runs are
  // upserted per target key, so createdAt is frozen at the first-ever
  // dispatch and the recency check would be permanently true.
  const recent = await db.pmChannelRun.findMany({
    where: { agentSlug, status: { in: ["failed", "completed", "timed_out", "cancelled", "superseded"] } },
    orderBy: { updatedAt: "desc" },
    take: BREAKER_CONSECUTIVE_FAILURES,
    select: { status: true },
  });
  if (recent.length < BREAKER_CONSECUTIVE_FAILURES) return { open: false };
  if (!recent.every((run) => run.status === "failed")) return { open: false };
  // Armed: last N terminal runs all failed. Allow exactly one probe per
  // interval — suppress while ANY run (including a probe just enqueued as
  // 'queued') was touched within the window. The enqueue path records a
  // queued run synchronously, so a probe we let through blocks the next
  // dispatch until it resolves or the interval elapses; a probe that
  // completes lands in the terminal set above and closes the gate.
  const newest = await db.pmChannelRun.findFirst({
    where: { agentSlug },
    orderBy: { updatedAt: "desc" },
    select: { updatedAt: true },
  });
  const sinceLast = newest ? Date.now() - newest.updatedAt.getTime() : Number.POSITIVE_INFINITY;
  if (sinceLast > BREAKER_PROBE_INTERVAL_MS) return { open: false, failures: recent.length };
  return { open: true, failures: recent.length };
}

export async function sendOrQueueOpenClawPmChannelTurn(
  args: SendPmChannelTurnRequest,
): Promise<SendPmChannelTurnResult> {
  const breaker = await channelBreakerOpen(args.agentSlug);
  if (breaker.open) {
    await db.activityLog.create({
      data: {
        projectId: args.projectId,
        userId: args.actor.id,
        kind: "pm.channel.dispatch_suppressed",
        targetAgent: args.agentSlug,
        payload: JSON.stringify({
          reason: "channel_down_breaker",
          consecutiveFailures: breaker.failures,
          probeIntervalMs: BREAKER_PROBE_INTERVAL_MS,
          replyTarget: args.replyTarget,
        }),
      },
    }).catch(() => {});
    return {
      ok: false,
      driver: "openclaw-pm-channel",
      error: `channel down: last ${breaker.failures} runs for ${args.agentSlug} failed; dispatch suppressed (next probe within ${Math.round(BREAKER_PROBE_INTERVAL_MS / 60000)}m)`,
    };
  }
  args = await prepareCompactTaskTurn(args);
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

/**
 * Reconcile the job half of already-terminal runs.
 *
 * Run settlement and job settlement historically happened in separate paths.
 * A crash or an older writer could therefore leave an `accepted`/`claimed`
 * job attached to a failed, timed-out, cancelled, or superseded run. The
 * file-drop envelope for that job remains durable and can arrive much later;
 * unless the job is terminal too, it keeps trying to resurrect a dead run and
 * can monopolise the active task/agent lane.
 */
export async function settleTerminalRunPmChannelJobs(now = new Date()) {
  const [completed, failed, canceled] = await db.$transaction([
    db.pmChannelJob.updateMany({
      where: {
        status: { in: ["queued", "claimed", "accepted", "retryable"] },
        run: { status: "completed" },
      },
      data: {
        status: "complete",
        claimedBy: null,
        claimedAt: null,
        completedAt: now,
        lastError: null,
      },
    }),
    db.pmChannelJob.updateMany({
      where: {
        status: { in: ["queued", "claimed", "accepted", "retryable"] },
        run: { status: { in: ["failed", "timed_out"] } },
      },
      data: {
        status: "failed",
        claimedBy: null,
        claimedAt: null,
        completedAt: now,
        lastError: "run was already terminal before job settlement",
      },
    }),
    db.pmChannelJob.updateMany({
      where: {
        status: { in: ["queued", "claimed", "accepted", "retryable"] },
        run: { status: { in: ["cancelled", "superseded"] } },
      },
      data: {
        status: "canceled",
        claimedBy: null,
        claimedAt: null,
        completedAt: now,
        lastError: "run was already cancelled or superseded before job settlement",
      },
    }),
  ]);
  return completed.count + failed.count + canceled.count;
}

export async function requeueStaleClaimedPmChannelJobs(now = new Date()) {
  // Repair terminal-run orphans before considering lease recovery. They are
  // not retry candidates, regardless of job age or attempt count.
  await settleTerminalRunPmChannelJobs(now);
  const staleClaimedBefore = new Date(now.getTime() - claimTimeoutMs());
  // Dispatch claims should be short, but an accepted gateway turn is already
  // executing and may legitimately spend many minutes in tools before its
  // first PM-visible callback. Reusing the two-minute claim lease for both
  // states caused duplicate dispatches, terminal false failures, and monitor
  // restarts that killed active work.
  const staleAcceptedBefore = new Date(now.getTime() - acceptedTimeoutMs());
  const recentAfter = new Date(now.getTime() - recoveryMaxAgeMs());
  const stale = await db.pmChannelJob.findMany({
    where: {
      OR: [
        { status: "claimed", claimedAt: { gt: recentAfter, lt: staleClaimedBefore } },
        {
          status: "accepted",
          acceptedAt: { gt: recentAfter, lt: staleAcceptedBefore },
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
    const jobStatus = exhausted ? "failed" : "retryable";
    const runStatus: "failed" | "queued" = exhausted ? "failed" : "queued";
    const error = exhausted
      ? `PM channel job ${job.status} lease expired after max attempts`
      : `PM channel job ${job.status} lease expired; requeued`;
    await db.$transaction([
      db.pmChannelJob.updateMany({
        where: { id: job.id, status: job.status },
        data: {
          status: jobStatus,
          availableAt: now,
          claimedBy: null,
          claimedAt: null,
          lastError: error,
        },
      }),
      db.pmChannelRun.update({
        where: { id: job.runId },
        data: {
          status: runStatus,
          error,
          failedAt: exhausted ? now : null,
          finishedAt: exhausted ? now : null,
          finishedReason: exhausted ? "job_lease_expired" : null,
          lastEventAt: now,
          // ENV-118 (WFI-005): only a terminal write records a disposition.
          disposition: exhausted ? "failed" : "continue",
        },
      }),
    ]);
    try {
      const payload = parseJobPayload(job.payload);
      appendAndPublishStatus({
        payload,
        runStatus,
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
  // The run may have been superseded after this worker claimed its job. Never
  // dispatch a terminal or already-accepted generation a second time.
  if (!currentRun || !["queued", "waiting_capacity"].includes(currentRun.status)) {
    await settleTerminalRunPmChannelJobs();
    return { ok: true, status: 200, driver: "openclaw-pm-channel" } satisfies SendPmChannelTurnResult;
  }
  // Jobs are durable and may outlive a policy change. Re-check human
  // authority at delivery time so a queued/retryable turn from a former
  // member cannot wake an agent after the owner-only rule takes effect.
  if (payload.actor.kind !== "agent" && !(await isOwnerUserId(payload.actor.id))) {
    return cancelJobForPolicy({
      job,
      payload,
      error: "PM channel dispatch canceled: the original human sender is not the active Mission Control owner",
    });
  }
  if (!(await dispatchTargetIsAuthorized(payload.replyTarget, payload.agentSlug))) {
    return cancelJobForPolicy({
      job,
      payload,
      error: "PM channel dispatch canceled: private or unavailable work cannot be delivered to agents",
    });
  }
  const fence = await fenceSupersededPmChannelRuns({ replacementRunId: job.runId });
  if (!fence.ok) {
    const error = `replacement dispatch fenced until the superseded process stops: ${fence.error}`;
    const now = new Date();
    await db.$transaction([
      db.pmChannelJob.update({
        where: { id: job.id },
        data: {
          status: "retryable",
          availableAt: new Date(now.getTime() + retryDelayMs(job.attemptCount)),
          claimedBy: null,
          claimedAt: null,
          lastError: error,
        },
      }),
      db.pmChannelRun.update({
        where: { id: job.runId },
        data: {
          status: "queued",
          error,
          failedAt: null,
          finishedAt: null,
          finishedReason: null,
          disposition: "continue",
          lastEventAt: now,
        },
      }),
    ]);
    await appendAndPublishStatus({ payload, runStatus: "queued", error });
    return { ok: false, driver: "openclaw-pm-channel", error } satisfies SendPmChannelTurnResult;
  }
  // ENV-159: Reserve the execution lane before dispatching. If the lane is
  // occupied by another run, mark this run as waiting_capacity and retry
  // later — capacity waiting does not consume retry attempts.
  const agentSlug = payload.replyTarget.agentSlug;
  const laneResult = await reserveExecutionLane({
    agentSlug,
    runId: job.runId,
    taskId: payload.replyTarget.kind === "task-chat" || payload.replyTarget.kind === "task-comment"
      ? payload.replyTarget.taskId
      : null,
  });
  if (!laneResult.acquired) {
    const now = new Date();
    await db.$transaction([
      db.pmChannelJob.update({
        where: { id: job.id },
        data: {
          status: "retryable",
          availableAt: new Date(now.getTime() + 5000),
          claimedBy: null,
          claimedAt: null,
          lastError: `agent_capacity: blocked by run ${laneResult.blockedByRunId}`,
          attemptCount: { decrement: 1 },
        },
      }),
      db.pmChannelRun.update({
        where: { id: job.runId },
        data: {
          status: "waiting_capacity",
          blockedReason: "agent_capacity",
          blockedByRunId: laneResult.blockedByRunId,
          blockedByTaskId: laneResult.blockedByTaskId,
          capacityBlockedAt: now,
          lastEventAt: now,
        },
      }),
    ]);
    await appendAndPublishStatus({ payload, runStatus: "waiting_capacity" });
    return { ok: true, status: 202, driver: "openclaw-pm-channel" } satisfies SendPmChannelTurnResult;
  }
  // A job whose last failure was a retryable TURN failure (no-reply/abort) is
  // being re-run: warn the agent the previous attempt may have partially
  // completed. Dispatch-copy only; the stored payload stays pristine.
  const retryingAfterTurnFailure = Boolean(
    job.lastError && isRetryablePmChannelTurnFailure(job.lastError),
  );
  const result = await dispatchOpenClawPmChannelTurn(
    retryingAfterTurnFailure
      ? { ...payload, text: `${RETRY_TURN_FAILURE_PREAMBLE}\n\n${payload.text}` }
      : payload,
  );
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

  // ENV-159: Release the execution lane on dispatch failure.
  await releaseExecutionLane({ runId: job.runId });
  const attemptCount = job.attemptCount;
  const exhausted = attemptCount >= (Number.isFinite(MAX_ATTEMPTS) && MAX_ATTEMPTS > 0 ? MAX_ATTEMPTS : 3);
  const jobStatus = exhausted ? "failed" : "retryable";
  const runStatus: "failed" | "queued" = exhausted ? "failed" : "queued";
  const error = clippedError(result.error ?? "PM channel dispatch failed");
  await db.$transaction([
    db.pmChannelJob.update({
      where: { id: job.id },
      data: {
        status: jobStatus,
        availableAt: new Date(now.getTime() + (exhausted ? 0 : retryDelayMs(attemptCount))),
        claimedBy: null,
        claimedAt: null,
        lastError: error,
      },
    }),
    db.pmChannelRun.update({
      where: { id: job.runId },
      data: {
        status: runStatus,
        error,
        failedAt: exhausted ? now : null,
        finishedAt: exhausted ? now : null,
        finishedReason: exhausted ? "dispatch_exhausted" : null,
        lastEventAt: now,
        disposition: exhausted ? "failed" : "continue",
      },
    }),
  ]);
  await appendAndPublishStatus({
    payload,
    runStatus: runStatus,
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

// Turn-failure retry policy (PH-124 item D). A no-reply/abort ending used to
// bypass the job retry ladder entirely: runs.ts wrote a terminal failed run
// and marked the job failed WITHOUT rolling back the incremental chat
// baseline. Now a notification-class turn with a retryable error class gets
// the shared ladder (same MAX_ATTEMPTS counter as dispatch retries, so the
// two ladders can never multiply into 2xN attempts); everything else fails
// terminally WITH the binding rollback. Conversation (human-authored) turns
// stay terminal on purpose: the human can resend, and auto-replaying an
// implementation instruction risks re-running partially-completed work. With
// item B in place, any turn that performed a durable workflow action settles
// complete and never reaches this path.
export async function retryOrFailPmChannelJobForTurnFailure(args: {
  targetKey: string;
  error: string;
  now?: Date;
}): Promise<"retried" | "exhausted" | "no_job"> {
  const now = args.now ?? new Date();
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: args.targetKey },
    select: {
      id: true,
      status: true,
      projectId: true,
      taskId: true,
      agentSlug: true,
      messageId: true,
    },
  });
  if (!run || run.status === "cancelled" || run.status === "superseded" || run.status === "timed_out") return "no_job";
  const job = await db.pmChannelJob.findUnique({
    where: { runId: run.id },
    select: { id: true, attemptCount: true, payload: true },
  });
  if (!job) return "no_job";
  let payload: DispatchJobPayload;
  try {
    payload = parseJobPayload(job.payload);
  } catch {
    return "no_job";
  }

  const error = clippedError(args.error) ?? args.error;
  const isTaskExecutionTarget =
    payload.replyTarget.kind === "task-chat" || payload.replyTarget.kind === "task-comment";
  const contextPressureRecovery =
    payloadTurnClass(payload) === "notification" &&
    isPmTerminalFailureText(args.error) &&
    isTaskExecutionTarget &&
    Boolean(run.taskId);

  if (contextPressureRecovery && run.taskId) {
    const recovered = await db.$transaction(async (tx) => {
      const rollover = await rollOverTaskExecutionEpisodeForContextPressure(tx, {
        taskId: run.taskId!,
        projectId: run.projectId,
        agentSlug: run.agentSlug,
      });
      // Plan/review notifications have task-shaped reply targets too, but no
      // assignee execution episode. Preserve their existing bounded retry path.
      if (!rollover) return false;

      await tx.pmChannelJob.updateMany({
        where: { id: job.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
        data: {
          status: "failed",
          claimedBy: null,
          claimedAt: null,
          lastError: error,
        },
      });
      await tx.pmChannelRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          error,
          failedAt: now,
          finishedAt: now,
          finishedReason: "context_pressure_episode_recovered",
          lastEventAt: now,
          // The failed transport turn is terminal, but execution continues in
          // the fresh successor episode queued below.
          disposition: "continue",
        },
      });
      await tx.pmChannelContinuation.updateMany({
        where: { runId: run.id, status: { in: ["armed", "queued", "dispatching"] } },
        data: { status: "superseded", lastError: "replaced by context-pressure recovery" },
      });
      await armPmChannelContinuations(tx, {
        runs: [{ id: run.id, projectId: run.projectId, taskId: run.taskId, epicId: null }],
        agentSlug: run.agentSlug,
        messageId: run.messageId,
        action: CONTEXT_PRESSURE_RECOVERY_ACTION,
        now,
        status: "queued",
      });
      return true;
    });
    if (recovered) {
      await appendAndPublishStatus({ payload, runStatus: "failed", error });
      return "retried";
    }
  }

  const eligible =
    job.attemptCount < maxAttempts() &&
    payloadTurnClass(payload) === "notification" &&
    isRetryablePmChannelTurnFailure(args.error);

  if (eligible) {
    let retryPayload = payload;
    if (isPmTerminalFailureText(args.error)) {
      const rotated = await rotateAgentSessionBinding({
        agentSlug: payload.agentSlug,
        currentSessionKey: payload.sessionKey,
        recoveryId: `failure-${run.id}-${job.attemptCount}`,
        reason: "context_failure",
      });
      if (rotated) retryPayload = { ...payload, sessionKey: rotated.openclawSessionKey };
    }
    await db.$transaction([
      db.pmChannelJob.updateMany({
        where: { id: job.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
        data: {
          status: "retryable",
          availableAt: new Date(now.getTime() + retryDelayMs(job.attemptCount)),
          claimedBy: null,
          claimedAt: null,
          lastError: error,
          payload: JSON.stringify(retryPayload),
        },
      }),
      db.pmChannelRun.update({
        where: { id: run.id },
        data: {
          status: "queued",
          error,
          failedAt: null,
          lastEventAt: now,
          disposition: "continue",
          sessionKey: retryPayload.sessionKey,
        },
      }),
    ]);
    await appendAndPublishStatus({ payload: retryPayload, runStatus: "queued", error });
    return "retried";
  }

  await db.$transaction([
    db.pmChannelJob.updateMany({
      where: { id: job.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
      data: {
        status: "failed",
        claimedBy: null,
        claimedAt: null,
        lastError: error,
      },
    }),
    db.pmChannelRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        error,
        failedAt: now,
        finishedAt: now,
        finishedReason: "turn_failure_exhausted",
        lastEventAt: now,
        disposition: "failed",
      },
    }),
    db.pmChannelContinuation.updateMany({
      where: { runId: run.id, status: { in: ["armed", "queued", "dispatching"] } },
      data: { status: "superseded", lastError: "turn failed terminally" },
    }),
  ]);
  await appendAndPublishStatus({ payload, runStatus: "failed", error });
  await rollbackDispatchedTurnBinding(payload);
  return "exhausted";
}

export async function runPmChannelWorkerOnce(workerId = `pm-channel-worker:${process.pid}`) {
  const job = await claimNextPmChannelJob(workerId);
  if (!job) return { claimed: false as const };
  const result = await runPmChannelJob(job);
  return {
    claimed: true as const,
    jobId: job.id,
    ok: result.ok,
    error: "error" in result ? result.error ?? null : null,
  };
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

  // Recover leaked lane rows before any watchdog or outbox path can dispatch a
  // replacement. This is the no-manual-repair path for a service crash after a
  // run became terminal but before its callback released the lane.
  let executionLanesReconciled = 0;
  try {
    executionLanesReconciled = await reconcileAbandonedLeases();
  } catch (err) {
    console.warn("[pm-channel] abandoned execution lane reconciliation failed", err);
  }

  // ENV-118: drain the continuation outbox alongside the job queue. A turn
  // that took a continuation-required action and then ended gets its next
  // execution turn from here, so "start" can never leave a task silently
  // parked as a successful workflow.
  // ENV-121 (second review): seal first, drain second. A successor episode is
  // scheduled only once its predecessor's checkpoint is durable, so a turn that
  // died without writing one would otherwise stall the task forever. The
  // sweeper writes PM's derived checkpoint after a grace period and queues the
  // successor, and running it before the drain means that successor goes out in
  // this same pass rather than the next one.
  // ENV-121 (third review): the seal's two halves are one transaction now, but
  // it can still commit a durable checkpoint with no successor armed when there
  // is no run row to attach the continuation to. That is the one partial state
  // left, and `sweepUnscheduledEpisodeSuccessors` is what repairs it — without
  // it, the task stalls behind a checkpoint nobody is coming to read.
  let episodeBarriers = { sealed: 0, scheduled: 0 };
  let episodeSuccessors = { scheduled: 0, stillUnscheduled: 0 };
  try {
    const { sweepUnsealedEpisodeRolloverBarriers, sweepUnscheduledEpisodeSuccessors } =
      await import("@/lib/agents/episodes/rollover");
    episodeBarriers = await sweepUnsealedEpisodeRolloverBarriers();
    episodeSuccessors = await sweepUnscheduledEpisodeSuccessors();
  } catch (err) {
    console.warn("[pm-channel] episode rollover barrier sweep failed", err);
  }

  // ENV-123: detect and repair BEFORE the continuation drain, for the same
  // reason the episode seal runs before it — a recovery continuation the
  // watchdog queues here goes out in this pass instead of the next one. The
  // watchdog only ever writes outbox rows and settles dead runs, so the drain
  // below is what actually schedules the turns, exactly as it does for
  // ordinary continuations.
  let watchdog = { findings: 0, repaired: 0, escalated: 0, breakerOpen: 0 };
  try {
    const { runWorkflowWatchdog } = await import("@/lib/agents/watchdog/run");
    const report = await runWorkflowWatchdog();
    watchdog = {
      findings: report.counts.findings,
      repaired: report.repaired,
      escalated: report.escalated,
      breakerOpen: report.breakerOpen,
    };
    for (const error of report.errors.slice(0, 3)) {
      console.warn("[pm-channel] workflow watchdog", error);
    }
  } catch (err) {
    console.warn("[pm-channel] workflow watchdog failed", err);
  }

  // Reconcile the durable transition/outbox ledger with repository runners
  // and process fences before draining effects. Safe repairs requeue an
  // existing recorded effect, retry an existing cancellation request, or
  // finish an accepted review when the immutable candidate, completed
  // repository state, and verified Epic merge audit all agree. Missing
  // evidence is escalated instead of reconstructed from comments.
  let reconciliation = { findings: 0, repaired: 0, escalated: 0 };
  try {
    const { runWorkflowReconciliation } = await import("@/lib/tasks/workflow-reconciler");
    const report = await runWorkflowReconciliation();
    reconciliation = {
      findings: report.findings.length,
      repaired: report.repaired,
      escalated: report.escalated,
    };
    for (const error of report.errors.slice(0, 3)) {
      console.warn("[pm-channel] workflow reconciliation", error);
    }
  } catch (err) {
    console.warn("[pm-channel] workflow reconciliation failed", err);
  }

  // Domain transitions commit their non-database consequences to the generic
  // workflow outbox. Drain it before PM-channel continuations so a newly
  // committed assignee/reviewer wake or repository job is projected in this
  // same worker pass. Expired dispatcher leases are reclaimed here too.
  let workflowEffects = { completed: 0, retried: 0, failed: 0 };
  try {
    const { drainWorkflowOutbox } = await import("@/lib/tasks/workflow-outbox-drain");
    workflowEffects = await drainWorkflowOutbox({ workerId: `${workerId}:workflow-effects` });
  } catch (err) {
    console.warn("[pm-channel] workflow outbox drain failed", err);
  }

  let continuations = { dispatched: 0, superseded: 0, failed: 0 };
  try {
    const { drainPmChannelContinuations } = await import(
      "@/lib/agents/pm-channel/continuation-drain"
    );
    continuations = await drainPmChannelContinuations();
  } catch (err) {
    console.warn("[pm-channel] continuation drain failed", err);
  }

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

  return {
    claimed,
    accepted,
    retryableOrFailed,
    errors,
    workflowEffects,
    reconciliation,
    continuations,
    episodeBarriers,
    episodeSuccessors,
    watchdog,
    executionLanesReconciled,
  };
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
  const input = { target: parsed, event: "done" as const, runStatus: "completed" as const };
  publishPmChannelStreamEvent(input);
  await enqueuePmChannelStreamDurability(input);
}
