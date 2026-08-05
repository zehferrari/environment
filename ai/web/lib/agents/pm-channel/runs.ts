import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type {
  PmChannelReplyTarget,
  PmChannelTurnKind,
  SendPmChannelTurnResult,
} from "@/lib/agents/pm-channel/openclaw";
import type { PmChannelStreamEventKind } from "@/lib/agents/pm-channel/stream";
import { pmChannelRunTargetKey } from "@/lib/agents/pm-channel/bus";
import { retryOrFailPmChannelJobForTurnFailure } from "@/lib/agents/pm-channel/jobs";
import {
  armPmChannelContinuations,
  queuePmChannelContinuationsForRun,
  supersedePmChannelContinuations,
} from "@/lib/agents/pm-channel/continuations";
import {
  workflowActionDisposition,
  workflowActionEffectOrFinish,
  workflowActionResult,
  type WorkflowActionResult,
} from "@/lib/agents/workflow/action-effect";
import {
  isContinuationRequiredAction,
  type WorkflowDisposition,
} from "@/lib/workflow-invariants";

// Re-exported for existing importers; the definition moved to bus.ts so the
// bus envelope id and the run identity can never drift apart.
export { pmChannelRunTargetKey };

// Leased state machine statuses (ENV-117).
// "retryable" is removed from run status — it lives only on PmChannelJob.
export type PmChannelRunStatus =
  | "queued"
  | "accepted"
  | "streaming"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "superseded";

const LEASE_DURATION_MS = Number.parseInt(
  process.env.PM_OPENCLAW_LEASE_MS ?? "120000",
  10,
);
const FIRST_STREAM_WARNING_MS = Number.parseInt(
  process.env.PM_OPENCLAW_FIRST_STREAM_WARNING_MS ?? "15000",
  10,
);

// Terminal statuses that should never be resurrected by late events.
const TERMINAL_STATUSES = new Set<PmChannelRunStatus>([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "superseded",
]);

// Non-terminal statuses that represent active runs.
const ACTIVE_STATUSES = new Set<string>(["queued", "accepted", "streaming"]);

function leaseDurationMs() {
  return Number.isFinite(LEASE_DURATION_MS) && LEASE_DURATION_MS >= 30_000
    ? LEASE_DURATION_MS
    : 120_000;
}

function targetIds(target: PmChannelReplyTarget) {
  return {
    taskId: target.kind === "task-chat" || target.kind === "task-comment" ? target.taskId : null,
    epicId: target.kind === "epic-chat" ? target.epicId : null,
  };
}

function clippedError(error: string | null | undefined) {
  if (!error) return null;
  return error.length > 2_000 ? error.slice(0, 2_000) : error;
}

// ENV-118. Every terminal write records an explicit disposition (WFI-005), and
// a run that ends while a continuation is armed ends as `continue`: the episode
// is not over, PM owes the agent another turn.
async function settlePmChannelJobsForTargetKey(args: {
  targetKey: string;
  status: "complete" | "failed";
  now: Date;
  error?: string | null;
}) {
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: args.targetKey },
    select: { id: true },
  });
  if (!run) return;
  await db.pmChannelJob.updateMany({
    where: { runId: run.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
    data: {
      status: args.status,
      claimedBy: null,
      claimedAt: null,
      completedAt: args.status === "complete" ? args.now : null,
      lastError: args.status === "failed" ? clippedError(args.error) : null,
    },
  });
}

/**
 * The disposition to stamp when a stream event settles a run.
 *
 * A run that reaches its end while a continuation is still armed did NOT
 * finish its episode — the agent took a continuation-required action (start,
 * add_subtask, ...) and then stopped without an episode-terminal one. That is
 * exactly the "start makes the PM job successful while actual work has not
 * begun" bug. The disposition becomes `continue` and the armed continuation is
 * queued, so the drain schedules a fresh execution turn.
 */
async function resolveSettleDisposition(args: {
  targetKey: string;
  status: "complete" | "failed";
  now: Date;
}): Promise<WorkflowDisposition> {
  if (args.status === "failed") return "failed";
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: args.targetKey },
    select: { id: true, disposition: true },
  });
  if (!run) return "completed";
  const queued = await queuePmChannelContinuationsForRun({ runId: run.id, now: args.now });
  if (queued > 0) return "continue";
  // A workflow action that already settled this run recorded its own
  // disposition; a later done/error event must not overwrite it.
  return (run.disposition as WorkflowDisposition | null) ?? "completed";
}

async function record(run: () => Promise<unknown>, label: string) {
  try {
    await run();
  } catch (err) {
    console.warn(`[pm-channel] failed to persist ${label}`, err);
  }
}

// PH-124: a late error event on an already-settled run must not flip the
// legitimate settle, but it must not vanish either. The anomaly lives on the
// run row (completionAnomaly/completionAnomalyAt) plus this durable audit row
// so ai-monitor probes and the run inspector can see the masked failure.
// userId is intentionally absent — precedent: pm.channel.latency_warning.
async function recordCompletionAnomaly(args: {
  target: PmChannelReplyTarget;
  targetKey: string;
  event: "done" | "error";
  error: string | null;
  settledStatus: string | null;
  hadDurableReply: boolean;
}) {
  const payload = {
    targetKey: args.targetKey,
    kind: args.target.kind,
    agentSlug: args.target.agentSlug,
    messageId: args.target.messageId,
    event: args.event,
    error: args.error,
    settledStatus: args.settledStatus,
    hadDurableReply: args.hadDurableReply,
  };
  console.warn("[pm-channel] completion anomaly on settled run", payload);
  await db.activityLog.create({
    data: {
      kind: "pm.channel.completion_anomaly",
      targetAgent: args.target.agentSlug,
      payload: JSON.stringify(payload),
    },
  });
}

function warningMs(value: number, fallback: number) {
  return Number.isFinite(value) && value >= 1_000 ? value : fallback;
}

function replyActivityKind(target: PmChannelReplyTarget) {
  if (target.kind === "direct") return "agent.direct_chat.reply";
  if (target.kind === "epic-chat") return "epic.chat.reply";
  if (target.kind === "task-comment") return "task.comment";
  return "task.chat.reply";
}

function silentActivityKind(target: PmChannelReplyTarget) {
  if (target.kind === "direct") return "agent.direct_chat.silent";
  if (target.kind === "epic-chat") return "epic.chat.silent";
  if (target.kind === "task-comment") return "task.comment.silent";
  return "task.chat.silent";
}

export async function pmChannelTargetHasDurableReply(target: PmChannelReplyTarget) {
  const row = await db.activityLog.findFirst({
    where: {
      kind: { in: [replyActivityKind(target), silentActivityKind(target)] },
      targetAgent: target.agentSlug,
      payload: { contains: `"inReplyToMessageId":"${target.messageId}"` },
    },
    select: { id: true },
  });
  return Boolean(row);
}

export async function pmChannelTargetIsCanceled(target: PmChannelReplyTarget) {
  const row = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: { status: true },
  });
  return row?.status === "cancelled";
}

export async function cancelPmChannelRunForTarget(args: {
  target: PmChannelReplyTarget;
  actorUserId: string;
}) {
  const now = new Date();
  const targetKey = pmChannelRunTargetKey(args.target);
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey },
    select: { id: true, status: true },
  });
  if (!run) return { canceled: false as const, reason: "not_found" as const };
  if (TERMINAL_STATUSES.has(run.status as PmChannelRunStatus)) {
    return { canceled: false as const, reason: "terminal" as const, status: run.status };
  }
  await db.$transaction([
    db.pmChannelRun.update({
      where: { id: run.id },
      data: {
        status: "cancelled",
        error: null,
        completedAt: now,
        failedAt: null,
        finishedAt: now,
        finishedReason: "cancelled",
        lastEventAt: now,
      },
    }),
    db.pmChannelJob.updateMany({
      where: { runId: run.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
      data: { status: "canceled", completedAt: now, lastError: null },
    }),
    // A canceled episode is over by human decision: never resume it.
    db.pmChannelContinuation.updateMany({
      where: { runId: run.id, status: { in: ["armed", "queued", "dispatching"] } },
      data: { status: "superseded", lastError: "run canceled" },
    }),
    db.activityLog.create({
      data: {
        userId: args.actorUserId,
        kind: "pm.channel.cancel",
        targetAgent: args.target.agentSlug,
        payload: JSON.stringify({
          targetKey,
          target: args.target,
        }),
      },
    }),
  ]);
  return { canceled: true as const, runId: run.id };
}

async function failRun(target: PmChannelReplyTarget, error: string) {
  const now = new Date();
  return db.pmChannelRun.update({
    where: { targetKey: pmChannelRunTargetKey(target) },
    data: {
      status: "failed",
      error: clippedError(error),
      failedAt: now,
      finishedAt: now,
      finishedReason: clippedError(error) ?? "failed",
      lastEventAt: now,
      disposition: "failed",
    },
    select: {
      id: true,
      status: true,
      error: true,
      lastEventAt: true,
      streamSeq: true,
      createdAt: true,
      updatedAt: true,
      acceptedAt: true,
      streamingAt: true,
      completedAt: true,
      failedAt: true,
      finishedAt: true,
      finishedReason: true,
    },
  });
}

async function timeOutRun(target: PmChannelReplyTarget, reason: string) {
  const now = new Date();
  return db.pmChannelRun.update({
    where: { targetKey: pmChannelRunTargetKey(target) },
    data: {
      status: "timed_out",
      error: clippedError(reason),
      failedAt: now,
      finishedAt: now,
      finishedReason: "lease_expired",
      lastEventAt: now,
    },
    select: {
      id: true,
      status: true,
      error: true,
      lastEventAt: true,
      streamSeq: true,
      createdAt: true,
      updatedAt: true,
      acceptedAt: true,
      streamingAt: true,
      completedAt: true,
      failedAt: true,
      finishedAt: true,
      finishedReason: true,
    },
  });
}

export async function recordPmChannelRunQueued(args: {
  target: PmChannelReplyTarget;
  kind: PmChannelTurnKind;
  projectId?: string | null;
  gatewayPort?: number | null;
  sessionKey?: string | null;
}) {
  const now = new Date();
  const ids = targetIds(args.target);
  const targetKey = pmChannelRunTargetKey(args.target);
  try {
    // Transactionally supersede ALL existing non-terminal runs for the same
    // (taskId, agentSlug) and create/refresh the new run in one atomic operation.
    // This prevents races where a crash between the supersede and the upsert
    // could leave no active run or incorrect lineage.
    if (ids.taskId) {
      return await db.$transaction(async (tx) => {
        // Find ALL active duplicates for this (taskId, agentSlug), including
        // the current targetKey if it already exists as active.
        const existingActive = await tx.pmChannelRun.findMany({
          where: {
            taskId: ids.taskId,
            agentSlug: args.target.agentSlug,
            status: { in: [...ACTIVE_STATUSES] },
          },
          select: { id: true, targetKey: true },
        });

        // Reserve a new run ID for lineage BEFORE superseding, so the
        // supersede update can set supersededByRunId atomically. This avoids
        // creating a second active row (which would violate the partial
        // unique index) before the old rows are moved out of active status.
        const reservedRunId = randomUUID();

        // Supersede every prior active run FIRST, pointing each to the
        // reserved new run ID. This clears the active slot before we insert
        // the replacement, so the partial unique index is never violated.
        const priorActive = existingActive.filter((r) => r.targetKey !== targetKey);
        if (priorActive.length > 0) {
          await tx.pmChannelRun.updateMany({
            where: {
              id: { in: priorActive.map((r) => r.id) },
            },
            data: {
              status: "superseded",
              finishedAt: now,
              finishedReason: "superseded_by_newer_run",
              supersededByRunId: reservedRunId,
              // A supersede is a terminal write, so WFI-005 wants a
              // disposition — and it is `continue`, never `completed`: the
              // episode did not finish, a newer run took it over.
              disposition: "continue",
            },
          });
          // ENV-118: retiring a run closes its continuation lane. The newer run
          // IS the continuation, so leaving the old row armed would put two
          // turns in the same lane once the drain picked it up (WFI-001).
          await supersedePmChannelContinuations(tx, {
            runIds: priorActive.map((r) => r.id),
            reason: "a newer run took over the episode",
          });
        }

        // If the current targetKey already exists as active, supersede it
        // too (it will be replaced by the upsert below, but we need to clear
        // its active status first to avoid a transient unique-index conflict
        // if another row for the same taskId+agentSlug was just superseded).
        const currentActive = existingActive.find((r) => r.targetKey === targetKey);
        if (currentActive) {
          await tx.pmChannelRun.update({
            where: { id: currentActive.id },
            data: {
              status: "superseded",
              finishedAt: now,
              finishedReason: "superseded_by_replacement",
              supersededByRunId: reservedRunId,
              disposition: "continue",
            },
          });
          await supersedePmChannelContinuations(tx, {
            runIds: [currentActive.id],
            reason: "the run was replaced in its lane",
          });
        }

        // Now create or upsert the replacement run with the reserved ID.
        // All prior active rows are already superseded, so the partial unique
        // index will not conflict.
        const newRun = await tx.pmChannelRun.upsert({
          where: { targetKey },
          create: {
            id: reservedRunId,
            targetKey,
            kind: args.kind,
            agentSlug: args.target.agentSlug,
            messageId: args.target.messageId,
            projectId: args.projectId ?? null,
            taskId: ids.taskId,
            epicId: ids.epicId,
            sessionKey: args.sessionKey ?? null,
            gatewayPort: args.gatewayPort ?? null,
            status: "queued",
            error: null,
            lastEventAt: now,
          },
          update: {
            kind: args.kind,
            agentSlug: args.target.agentSlug,
            messageId: args.target.messageId,
            projectId: args.projectId ?? null,
            taskId: ids.taskId,
            epicId: ids.epicId,
            sessionKey: args.sessionKey ?? null,
            gatewayPort: args.gatewayPort ?? null,
            httpStatus: null,
            status: "queued",
            error: null,
            // Full timestamp reset — no contradictory history (ENV-117)
            acceptedAt: null,
            streamingAt: null,
            completedAt: null,
            failedAt: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            finishedAt: null,
            finishedReason: null,
            supersededByRunId: null,
            lastEventAt: now,
          },
          select: {
            id: true,
            targetKey: true,
            status: true,
            streamSeq: true,
          },
        });

        return newRun;
      });
    }

    return await db.pmChannelRun.upsert({
      where: { targetKey },
      create: {
        targetKey,
        kind: args.kind,
        agentSlug: args.target.agentSlug,
        messageId: args.target.messageId,
        projectId: args.projectId ?? null,
        taskId: ids.taskId,
        epicId: ids.epicId,
        sessionKey: args.sessionKey ?? null,
        gatewayPort: args.gatewayPort ?? null,
        status: "queued",
        error: null,
        lastEventAt: now,
      },
      update: {
        kind: args.kind,
        agentSlug: args.target.agentSlug,
        messageId: args.target.messageId,
        projectId: args.projectId ?? null,
        taskId: ids.taskId,
        epicId: ids.epicId,
        sessionKey: args.sessionKey ?? null,
        gatewayPort: args.gatewayPort ?? null,
        httpStatus: null,
        status: "queued",
        error: null,
        acceptedAt: null,
        streamingAt: null,
        completedAt: null,
        failedAt: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        finishedAt: null,
        finishedReason: null,
        supersededByRunId: null,
        lastEventAt: now,
      },
      select: {
        id: true,
        targetKey: true,
        status: true,
        streamSeq: true,
      },
    });
  } catch (err) {
    console.warn("[pm-channel] failed to persist queued run", err);
    return null;
  }
}

export async function recordPmChannelRunDispatch(args: {
  target: PmChannelReplyTarget;
  result: SendPmChannelTurnResult;
}) {
  const now = new Date();
  const ok = args.result.ok;
  const leaseExpiresAt = ok ? new Date(now.getTime() + leaseDurationMs()) : null;
  // ENV-122: Persist provider/model provenance from the dispatch response
  // so comment creation sites can copy them from the run.
  const provider = ok ? (args.result.provider ?? null) : null;
  const model = ok ? (args.result.model ?? null) : null;
  await record(
    () => db.pmChannelRun.update({
      where: { targetKey: pmChannelRunTargetKey(args.target) },
      data: {
        httpStatus: args.result.status ?? null,
        driver: args.result.transportMode
          ? `openclaw-pm-channel:${args.result.transportMode}`
          : "openclaw-pm-channel",
        status: ok ? "accepted" : "failed",
        error: ok ? null : clippedError(args.result.error),
        acceptedAt: ok ? now : null,
        failedAt: ok ? null : now,
        leaseExpiresAt,
        heartbeatAt: ok ? now : null,
        finishedAt: ok ? null : now,
        finishedReason: ok ? null : clippedError(args.result.error) ?? "dispatch_failed",
        lastEventAt: now,
        ...(provider !== null ? { provider } : {}),
        ...(model !== null ? { model } : {}),
      },
    }),
    "dispatch run state",
  );
}

/**
 * Record a workflow action against the agent's live run(s).
 *
 * ENV-118: the action's EFFECT decides what happens to the run, instead of
 * every action unconditionally settling it complete.
 *
 *   continue — renew the lease, leave the run active, and arm a continuation
 *              in the same transaction. Reporting "job complete" here is the
 *              bug: `start` would mark the turn successful before any work.
 *   wait     — settle `complete` with disposition `waiting_external`: the
 *              episode ended because somebody else has to act.
 *   finish   — settle `complete` with a successful disposition.
 *
 * Both terminal effects record `settledByAction`, and both supersede any armed
 * continuation, so the episode is not resumed after it legitimately ended.
 *
 * Returns the structured action result, or null when no live run matched (the
 * caller still has a valid workflow outcome; only the run bookkeeping is a
 * no-op).
 */
export interface PmChannelWorkflowActionArgs {
  taskId?: string | null;
  epicId?: string | null;
  agentSlug: string;
  messageId: string;
  action: string;
  taskState?: string | null;
}

function workflowActionTargetKeys(args: PmChannelWorkflowActionArgs): string[] {
  return args.epicId
    ? [pmChannelRunTargetKey({
        kind: "epic-chat",
        agentSlug: args.agentSlug,
        epicId: args.epicId,
        messageId: args.messageId,
      })]
    : args.taskId
      ? [
          pmChannelRunTargetKey({
            kind: "task-comment",
            agentSlug: args.agentSlug,
            taskId: args.taskId,
            messageId: args.messageId,
          }),
          pmChannelRunTargetKey({
            kind: "task-chat",
            agentSlug: args.agentSlug,
            taskId: args.taskId,
            messageId: args.messageId,
          }),
        ]
      : [];
}

/**
 * The run/job/outbox half of a workflow action, executed on the CALLER'S
 * transaction client.
 *
 * ENV-118 review finding: arming the outbox atomically with the run write was
 * not enough. The route committed its domain mutation (`moveTaskStatus`,
 * `promoteEpicOnTaskInProgress`, the subtask write, …) first and only then
 * opened a SEPARATE transaction for this bookkeeping, so a crash in between
 * still left an In Progress task with no continuation — the exact loss window
 * the task exists to close.
 *
 * Taking `tx` from the caller closes it: `runWorkflowActionAtomically` (see
 * lib/agents/workflow/transactional-action.ts) runs the domain mutation and
 * this function in ONE transaction, so neither can commit alone.
 *
 * Errors are NOT swallowed here — they must propagate so the caller's
 * transaction rolls back. `recordPmChannelRunWorkflowAction` keeps the old
 * best-effort semantics for callers that have no domain mutation to protect.
 */
export async function applyPmChannelRunWorkflowAction(
  tx: Prisma.TransactionClient,
  args: PmChannelWorkflowActionArgs,
): Promise<WorkflowActionResult> {
  const now = new Date();
  const targetKeys = workflowActionTargetKeys(args);
  const result = workflowActionResult({ action: args.action, taskState: args.taskState });
  if (targetKeys.length === 0) return result;

  const effect = workflowActionEffectOrFinish(args.action);
  const disposition = workflowActionDisposition(args.action);

  const runs = await tx.pmChannelRun.findMany({
    where: { targetKey: { in: targetKeys } },
    select: { id: true, status: true, projectId: true, taskId: true, epicId: true },
  });
  if (runs.length === 0) return result;
  const runIds = runs.map((run) => run.id);
  // A workflow action can queue its own follow-up notification (completing
  // the last subtask raises `ready_for_review_available`), and ENV-117
  // supersedes the older run the moment the newer one queues. So by the
  // time we get here the run this action belongs to may already be
  // superseded. The action still happened and must still be recorded — but
  // the newer run IS the continuation, so arming a second one would put two
  // turns in the same lane (WFI-001).
  const liveRuns = runs.filter((run) => ACTIVE_STATUSES.has(run.status));

  if (effect === "continue") {
    // Record the action on every run the agent's grant covers, live or
    // already superseded: `continue` settles nothing, so there is no
    // terminal write to protect with a status guard, and a superseded
    // run whose disposition stayed null would read as "turn ended, no
    // reason given".
    await tx.pmChannelRun.updateMany({
      where: { id: { in: runIds } },
      data: {
        error: null,
        lastEventAt: now,
        lastAction: args.action,
        lastActionAt: now,
        disposition: "continue",
      },
    });
    // Only a live run arms a continuation. A superseded one already has
    // its successor queued.
    await armPmChannelContinuations(tx, {
      runs: liveRuns,
      agentSlug: args.agentSlug,
      messageId: args.messageId,
      action: args.action,
      now,
    });
    const retiredRunIds = runs
      .filter((run) => !ACTIVE_STATUSES.has(run.status))
      .map((run) => run.id);
    if (retiredRunIds.length > 0) {
      await supersedePmChannelContinuations(tx, {
        runIds: retiredRunIds,
        reason: "a newer run took over the episode",
      });
    }
    return result;
  }

  await tx.pmChannelRun.updateMany({
    where: {
      id: { in: runIds },
      status: { in: ["queued", "accepted", "streaming"] },
    },
    data: {
      status: "completed",
      error: null,
      completedAt: now,
      failedAt: null,
      finishedAt: now,
      finishedReason: `workflow_action:${args.action}`,
      lastEventAt: now,
      lastAction: args.action,
      lastActionAt: now,
      settledByAction: args.action,
      disposition,
    },
  });
  await tx.pmChannelJob.updateMany({
    where: {
      runId: { in: runIds },
      status: { in: ["queued", "claimed", "accepted", "retryable"] },
    },
    data: {
      status: "complete",
      completedAt: now,
      lastError: null,
    },
  });
  await supersedePmChannelContinuations(tx, {
    runIds,
    reason: `episode ended by ${args.action}`,
  });
  return result;
}

/**
 * Best-effort standalone recorder, for callers with no domain mutation of
 * their own to protect (episode-terminal actions, already-idempotent no-ops).
 *
 * A route that mutates task state as part of a CONTINUATION-REQUIRED action
 * must use `runWorkflowActionAtomically` instead: this wrapper opens its own
 * transaction, which is precisely the split the ENV-118 review rejected.
 *
 * That is enforced, not documented: a continuation-required action reaching
 * this function has to say in so many words that it wrote nothing durable of
 * its own. The guard is what stops a future action from quietly re-opening the
 * loss window by copying the nearest call site.
 */
export async function recordPmChannelRunWorkflowAction(
  args: PmChannelWorkflowActionArgs & { withoutDomainMutation?: true },
): Promise<WorkflowActionResult> {
  if (isContinuationRequiredAction(args.action) && !args.withoutDomainMutation) {
    throw new Error(
      `recordPmChannelRunWorkflowAction cannot record the continuation-required action "${args.action}": ` +
        "run it through runWorkflowActionAtomically so the domain mutation and the continuation outbox " +
        "commit together, or pass withoutDomainMutation:true if this call site genuinely writes nothing.",
    );
  }
  const result = workflowActionResult({ action: args.action, taskState: args.taskState });
  await record(
    () => db.$transaction((tx) => applyPmChannelRunWorkflowAction(tx, args)),
    `workflow action run state (${args.action})`,
  );
  return result;
}

export async function recordPmChannelRunEvent(args: {
  target: PmChannelReplyTarget;
  event: PmChannelStreamEventKind;
  error?: string | null;
}) {
  const now = new Date();
  const ids = targetIds(args.target);
  const targetKey = pmChannelRunTargetKey(args.target);
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs());

  if (args.event === "done") {
    await record(
      async () => {
        const existing = await db.pmChannelRun.findUnique({
          where: { targetKey },
          select: { status: true },
        });
        if (
          existing?.status === "cancelled" ||
          existing?.status === "superseded" ||
          existing?.status === "failed" ||
          existing?.status === "timed_out"
        ) return;
        const hadDurableReply = await pmChannelTargetHasDurableReply(args.target);
        if (existing?.status === "completed" || hadDurableReply) {
          // Legitimate settle. A plain done stays anomaly-free; a done that
          // still CARRIES an error (the stream-callback durable-reply
          // conversion passes it through) records the masked failure as a
          // completion anomaly without touching the settled status.
          const anomalyError = args.error ? clippedError(args.error) : null;
          const anomaly = anomalyError
            ? { completionAnomaly: anomalyError, completionAnomalyAt: now }
            : {};
          const disposition = await resolveSettleDisposition({
            targetKey,
            status: "complete",
            now,
          });
          await db.pmChannelRun.upsert({
            where: { targetKey },
            create: {
              targetKey,
              kind: args.target.kind,
              agentSlug: args.target.agentSlug,
              messageId: args.target.messageId,
              taskId: ids.taskId,
              epicId: ids.epicId,
              status: "completed",
              completedAt: now,
              failedAt: null,
              finishedAt: now,
              finishedReason: "done",
              lastEventAt: now,
              disposition,
              ...anomaly,
            },
            update: {
              status: "completed",
              error: null,
              completedAt: now,
              failedAt: null,
              finishedAt: now,
              finishedReason: "done",
              lastEventAt: now,
              disposition,
              ...anomaly,
            },
          });
          if (anomalyError) {
            await recordCompletionAnomaly({
              target: args.target,
              targetKey,
              event: "done",
              error: anomalyError,
              settledStatus: existing?.status ?? null,
              hadDurableReply,
            });
          }
          await settlePmChannelJobsForTargetKey({ targetKey, status: "complete", now });
          return;
        }
        // No visible reply and no durable settle: route through the shared
        // retry policy. Notification turns retry with backoff; conversation
        // turns (and exhausted retries) fail terminally with the incremental
        // chat baseline rolled back.
        const error = "Agent finished without posting a reply.";
        const outcome = await retryOrFailPmChannelJobForTurnFailure({ targetKey, error, now });
        if (outcome !== "no_job") return;
        await db.pmChannelRun.upsert({
          where: { targetKey },
          create: {
            targetKey,
            kind: args.target.kind,
            agentSlug: args.target.agentSlug,
            messageId: args.target.messageId,
            taskId: ids.taskId,
            epicId: ids.epicId,
            status: "failed",
            error,
            failedAt: now,
            finishedAt: now,
            finishedReason: "no_reply",
            lastEventAt: now,
            disposition: "failed",
          },
          update: {
            status: "failed",
            error,
            failedAt: now,
            finishedAt: now,
            finishedReason: "no_reply",
            lastEventAt: now,
            disposition: "failed",
          },
        });
        await settlePmChannelJobsForTargetKey({
          targetKey,
          status: "failed",
          now,
          error,
        });
      },
      "done run state",
    );
    return;
  }

  if (args.event === "error") {
    await record(
      async () => {
        const existing = await db.pmChannelRun.findUnique({
          where: { targetKey },
          select: { status: true },
        });
        // The legacy reply callback and typed stream callback can report the
        // same terminal failure concurrently. Once either has driven the run
        // into a terminal state, the other event is idempotent and must not run
        // the retry ladder again or convert the outcome into an anomaly.
        if (
          existing?.status === "cancelled" ||
          existing?.status === "superseded" ||
          existing?.status === "failed" ||
          existing?.status === "timed_out"
        ) return;
        const hadDurableReply = await pmChannelTargetHasDurableReply(args.target);
        if (existing?.status === "completed" || hadDurableReply) {
          // The run already settled (workflow action or durable reply). Keep
          // the settle, but persist the late error as a completion anomaly
          // instead of discarding it (PH-124).
          const anomalyError = clippedError(args.error) ?? "late stream error on settled run";
          const disposition = await resolveSettleDisposition({
            targetKey,
            status: "complete",
            now,
          });
          await db.pmChannelRun.upsert({
            where: { targetKey },
            create: {
              targetKey,
              kind: args.target.kind,
              agentSlug: args.target.agentSlug,
              messageId: args.target.messageId,
              taskId: ids.taskId,
              epicId: ids.epicId,
              status: "completed",
              completedAt: now,
              failedAt: null,
              finishedAt: now,
              finishedReason: "done",
              lastEventAt: now,
              disposition,
              completionAnomaly: anomalyError,
              completionAnomalyAt: now,
            },
            update: {
              status: "completed",
              error: null,
              completedAt: now,
              failedAt: null,
              finishedAt: now,
              finishedReason: "done",
              lastEventAt: now,
              disposition,
              completionAnomaly: anomalyError,
              completionAnomalyAt: now,
            },
          });
          await recordCompletionAnomaly({
            target: args.target,
            targetKey,
            event: "error",
            error: anomalyError,
            settledStatus: existing?.status ?? null,
            hadDurableReply,
          });
          await settlePmChannelJobsForTargetKey({ targetKey, status: "complete", now });
          return;
        }

        const error = clippedError(args.error) ?? "OpenClaw stream failed";
        const outcome = await retryOrFailPmChannelJobForTurnFailure({ targetKey, error, now });
        if (outcome !== "no_job") return;
        await db.pmChannelRun.upsert({
          where: { targetKey },
          create: {
            targetKey,
            kind: args.target.kind,
            agentSlug: args.target.agentSlug,
            messageId: args.target.messageId,
            taskId: ids.taskId,
            epicId: ids.epicId,
            status: "failed",
            error,
            failedAt: now,
            finishedAt: now,
            finishedReason: "stream_error",
            lastEventAt: now,
            disposition: "failed",
          },
          update: {
            status: "failed",
            error,
            failedAt: now,
            finishedAt: now,
            finishedReason: "stream_error",
            lastEventAt: now,
            disposition: "failed",
          },
        });
        await settlePmChannelJobsForTargetKey({ targetKey, status: "failed", now, error });
      },
      "error run state",
    );
    return;
  }

  // For streaming/tool/token/partial/final events: renew the lease.
  const status: PmChannelRunStatus =
    args.event === "final"
      ? "completed"
      : "streaming";
  await record(
    async () => {
      const existing = await db.pmChannelRun.findUnique({
        where: { targetKey },
        select: { id: true, status: true, createdAt: true, acceptedAt: true, streamingAt: true },
      });
      // Never resurrect a run the watchdog (or a prior terminal event) already
      // settled. A late streaming chunk must not reopen a terminal run
      // and re-show the spinner; a late `final` may still upgrade a failed run
      // to completed because a real reply did arrive after all.
      if (existing?.status === "completed" || existing?.status === "cancelled" || existing?.status === "superseded") return;
      if (existing?.status === "failed" && status !== "completed") return;
      if (existing?.status === "timed_out" && status !== "completed") return;
      const firstTokenAt = existing?.streamingAt ?? now;
      const firstStreamMs = existing?.streamingAt || !existing?.acceptedAt
        ? null
        : now.getTime() - existing.acceptedAt.getTime();
      // A `final` is a turn ending: if a continuation is armed, this settle is
      // `continue`, not a successful completion, and the outbox row becomes
      // drainable. A plain streaming chunk settles nothing.
      const disposition = status === "completed"
        ? await resolveSettleDisposition({ targetKey, status: "complete", now })
        : undefined;
      await db.pmChannelRun.upsert({
        where: { targetKey },
        create: {
          targetKey,
          kind: args.target.kind,
          agentSlug: args.target.agentSlug,
          messageId: args.target.messageId,
          taskId: ids.taskId,
          epicId: ids.epicId,
          status,
          error: null,
          // A final event can be the first emitted token for very short replies;
          // keep first-token latency visible instead of leaving it blank.
          streamingAt: firstTokenAt,
          completedAt: status === "completed" ? now : null,
          failedAt: null,
          leaseExpiresAt,
          heartbeatAt: now,
          finishedAt: status === "completed" ? now : null,
          finishedReason: status === "completed" ? "final" : null,
          lastEventAt: now,
          disposition,
        },
        update: {
          status,
          error: null,
          streamingAt: firstTokenAt,
          completedAt: status === "completed" ? now : undefined,
          failedAt: null,
          leaseExpiresAt,
          heartbeatAt: now,
          finishedAt: status === "completed" ? now : undefined,
          finishedReason: status === "completed" ? "final" : undefined,
          lastEventAt: now,
          disposition,
        },
      });
      if (status === "completed") {
        await settlePmChannelJobsForTargetKey({ targetKey, status: "complete", now });
      }
      const thresholdMs = warningMs(FIRST_STREAM_WARNING_MS, 15_000);
      if (firstStreamMs !== null && firstStreamMs > thresholdMs) {
        const payload = {
          targetKey,
          kind: args.target.kind,
          agentSlug: args.target.agentSlug,
          messageId: args.target.messageId,
          runId: existing?.id ?? null,
          acceptedAt: existing?.acceptedAt?.toISOString() ?? null,
          firstStreamAt: now.toISOString(),
          firstStreamMs,
          thresholdMs,
        };
        console.warn("[pm-channel] slow first stream", payload);
        await db.activityLog.create({
          data: {
            kind: "pm.channel.latency_warning",
            targetAgent: args.target.agentSlug,
            payload: JSON.stringify(payload),
          },
        });
      }
    },
    "stream run state",
  );
}

export async function getPmChannelRunSnapshot(target: PmChannelReplyTarget) {
  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: {
      id: true,
      status: true,
      error: true,
      lastEventAt: true,
      streamSeq: true,
      createdAt: true,
      updatedAt: true,
      acceptedAt: true,
      streamingAt: true,
      completedAt: true,
      failedAt: true,
      leaseExpiresAt: true,
      heartbeatAt: true,
      finishedAt: true,
      finishedReason: true,
      supersededByRunId: true,
    },
  });
  if (!run) return null;

  const now = Date.now();

  // Terminal statuses: return as-is if already settled.
  if (run.status === "completed" || run.status === "cancelled") return run;
  if (run.status === "failed" || run.status === "timed_out" || run.status === "superseded") return run;

  // Lease expiry check: queued/accepted/streaming runs with an expired lease
  // are transitioned to timed_out.
  const leaseExpiresAt = run.leaseExpiresAt?.getTime();
  const lastEventAt = run.lastEventAt?.getTime() ?? run.updatedAt.getTime();

  if (leaseExpiresAt && now > leaseExpiresAt) {
    return timeOutRun(
      target,
      "Agent execution lease expired before a final reply was delivered.",
    );
  }

  // Fallback: if no leaseExpiresAt is set (legacy runs pre-migration), use
  // a conservative lastEventAt heuristic. This covers runs that were queued
  // before the migration and haven't had their lease set yet.
  if (!leaseExpiresAt) {
    const fallbackTimeoutMs = Number.parseInt(
      process.env.PM_OPENCLAW_FALLBACK_TIMEOUT_MS ?? "1800000",
      10,
    );
    const fallback = Number.isFinite(fallbackTimeoutMs) && fallbackTimeoutMs >= 30_000
      ? fallbackTimeoutMs
      : 1_800_000;
    if (now - lastEventAt > fallback) {
      return timeOutRun(
        target,
        "Agent execution timed out (legacy fallback — no lease set).",
      );
    }
  }

  return run;
}