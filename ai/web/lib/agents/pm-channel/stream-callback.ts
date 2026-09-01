import { db } from "@/lib/db";
import {
  parsePmChannelReplyTarget,
  type PmChannelReplyTarget,
} from "@/lib/agents/pm-channel/openclaw";
import {
  admitExecutionLaneForRun,
  heartbeatExecutionLane,
  releaseExecutionLane,
} from "@/lib/agents/pm-channel/execution-lane";
import {
  publishPmChannelStreamEvent,
  type PmChannelLifecycleStatus,
  type PmChannelStreamEventKind,
  type PmChannelToolStatus,
} from "@/lib/agents/pm-channel/stream";
import {
  pmChannelRunTargetKey,
  pmChannelTargetIsCanceled,
  pmChannelTargetHasDurableReply,
  recordPmChannelRunEvent,
} from "@/lib/agents/pm-channel/runs";
import { markPmChannelJobCompleteForTarget } from "@/lib/agents/pm-channel/jobs";
import { appendPmChannelStreamEventForTarget } from "@/lib/agents/pm-channel/stream-log";
import { checkPmChannelCallbackRateLimit } from "@/lib/agents/pm-channel/rate-limit";
import {
  isPmTerminalFailureText,
  isSilentPmReplyText,
  isTransientPmProgressText,
} from "@/lib/agents/ops/pm-silence";
import { isAuthorizedPmChannelCallbackTarget } from "@/lib/agents/pm-channel/target-authorization";
import { continueActionableTaskAfterReply } from "@/lib/agents/workflow/execution-continuation";
import {
  episodeToolCycleBudgetForModel,
  recordTaskExecutionToolCycle,
  rollOverTaskExecutionEpisodeForContextPressure,
} from "@/lib/agents/episodes/lifecycle";
import { sealEpisodeRolloverBarrierOnTurnEnd } from "@/lib/agents/episodes/rollover";
import { abortGatewaySession, steerGatewaySession } from "@/lib/agents/pm-channel/supersession";

export type PmChannelStreamTransportMode = "http" | "inproc" | "uds";

export type ApplyPmChannelStreamCallbackResult = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

const EVENTS = new Set<PmChannelStreamEventKind>([
  "status",
  "status:thinking",
  "status:reading",
  "status:working",
  "tool:call",
  "tool:result",
  "tool:start",
  "token",
  "partial",
  "reasoning",
  "final",
  "done",
  "error",
  // ENV-159 canonical provider-neutral gateway protocol events
  "dispatch:delivered",
  "turn:waiting_capacity",
  "turn:admitted",
  "model:selected",
  "context:usage",
  "turn:terminal",
]);

function stringField(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function lifecycleStatusField(value: unknown): PmChannelLifecycleStatus | undefined {
  return value === "thinking" || value === "reading" || value === "working" ? value : undefined;
}

function toolStatusField(value: unknown): PmChannelToolStatus | undefined {
  return value === "call" || value === "result" || value === "start" || value === "update" ? value : undefined;
}

function normalizeTransportMode(mode: string | null | undefined): PmChannelStreamTransportMode {
  if (mode === "inproc" || mode === "uds") return mode;
  return "http";
}

async function recordStreamTransport(
  target: PmChannelReplyTarget,
  transportMode: PmChannelStreamTransportMode,
) {
  try {
    const driver = `openclaw-pm-channel:${transportMode}`;
    // The transport mode is constant for a run, so only the first event needs to
    // write it. Gating on `driver: { not }` makes every later event a no-op
    // match instead of rewriting the same constant on the hot path.
    await db.pmChannelRun.updateMany({
      where: { targetKey: pmChannelRunTargetKey(target), driver: { not: driver } },
      data: { driver },
    });
  } catch (err) {
    console.warn("[pm-channel] failed to record stream transport", err);
  }
}

async function recordStreamError(target: PmChannelReplyTarget, error: string | undefined) {
  const existingRun = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: { status: true },
  });
  if (existingRun?.status === "completed") return;

  const payload = JSON.stringify({
    driver: "openclaw-pm-channel",
    target,
    error: error || "OpenClaw stream failed",
  });

  try {
    if (target.kind === "direct") {
      await db.activityLog.create({
        data: {
          kind: "agent.direct_chat.stream_error",
          targetAgent: target.agentSlug,
          payload,
        },
      });
      return;
    }

    const original = await db.agentChatMessage.findUnique({
      where: { id: target.messageId },
      select: { projectId: true, taskId: true, epicId: true },
    });
    await db.activityLog.create({
      data: {
        projectId: original?.projectId ?? undefined,
        taskId: target.kind === "task-chat" || target.kind === "task-comment"
          ? original?.taskId ?? target.taskId
          : undefined,
        kind: target.kind === "epic-chat" ? "epic.chat.stream_error" : "task.chat.stream_error",
        targetAgent: target.agentSlug,
        payload,
      },
    });
  } catch (err) {
    console.warn("[pm-channel] failed to record stream error", err);
  }
}

/**
 * ENV-121 (review) — spend one tool cycle of the open execution episode.
 *
 * When that exhausts the budget the episode is closed, the successor row is
 * opened and THIS message is fenced (see resolveEpisodeRolloverBarrier): from
 * here on the workflow route accepts only its final checkpoint. Nothing in the
 * stream path can stop the model mid-turn, so the barrier is what makes the
 * boundary real — the turn may keep talking and finish in process, but its
 * actions are fenced and subsequent tool events are ignored by the counter,
 * so it cannot mutate the task or spend episode N+1's budget.
 *
 * ENV-121 (second review) — rollover never schedules an uncheckpointed
 * successor. At a workflow-action boundary the agent can write its own final
 * checkpoint. A tool callback cannot communicate that fence back into an
 * already-running model turn, so PM immediately writes the same deterministic
 * turn-end checkpoint, seals it, and aborts the spent process. Only that
 * successful seal arms N+1; a crash still leaves the ordinary barrier sweeper
 * able to repair the handoff.
 */
// ENV-159: Idempotent tool-call correlation. Each logical tool call gets
// exactly one PmChannelToolCall row per run, keyed by toolCallId. Duplicate
// callbacks/retries find the existing row and do not increment the episode
// count. Returns { created: true } for a new tool call, { created: false } for
// a duplicate, or null if no toolCallId is available (degraded telemetry).
async function recordPmChannelToolCall(args: {
  runId: string;
  toolCallId: string;
  toolName?: string;
  provider?: string | null;
  model?: string | null;
}) {
  try {
    const existing = await db.pmChannelToolCall.findUnique({
      where: { runId_toolCallId: { runId: args.runId, toolCallId: args.toolCallId } },
      select: { id: true },
    });
    if (existing) {
      return { created: false as const, id: existing.id };
    }
    const created = await db.pmChannelToolCall.create({
      data: {
        runId: args.runId,
        toolCallId: args.toolCallId,
        toolName: args.toolName ?? "unknown",
        provider: args.provider ?? null,
        model: args.model ?? null,
        startedAt: new Date(),
      },
    });
    return { created: true as const, id: created.id };
  } catch (err) {
    console.warn("[pm-channel] failed to record tool call", err);
    return null;
  }
}

/**
 * ENV-121: Count a tool cycle against the current execution episode.
 * ENV-159: Now takes toolCallId and toolName for idempotent correlation via
 * PmChannelToolCall. Duplicate callbacks for the same toolCallId do not
 * increment the episode. Only truly new tool calls (created=true) count.
 */
async function countTaskExecutionToolCycle(
  target: Extract<PmChannelReplyTarget, { kind: "task-chat" | "task-comment" }>,
  toolCallId?: string,
  toolName?: string,
) {
  try {
    const selectedRun = await db.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      select: {
        id: true,
        projectId: true,
        gatewayPort: true,
        sessionKey: true,
        provider: true,
        model: true,
      },
    });

    // ENV-159: If we have a toolCallId, use durable idempotent correlation.
    // Only increment the episode for truly new tool calls.
    if (toolCallId && selectedRun) {
      const toolRecord = await recordPmChannelToolCall({
        runId: selectedRun.id,
        toolCallId,
        toolName,
        provider: selectedRun.provider,
        model: selectedRun.model,
      });
      if (!toolRecord || !toolRecord.created) {
        // Duplicate callback or degraded telemetry — do not count.
        return;
      }
    }

    const outcome = await recordTaskExecutionToolCycle({
      taskId: target.taskId,
      agentSlug: target.agentSlug,
      messageId: target.messageId,
      toolCycleBudget: episodeToolCycleBudgetForModel(selectedRun?.provider, selectedRun?.model),
    });
    if (!outcome) return;

    const warningAt = Math.max(8, Math.floor(outcome.episode.toolCycleBudget * 2 / 3));
    if (!outcome.rolledOver && outcome.episode.toolCycleCount === warningAt) {
      const steer = selectedRun?.gatewayPort && selectedRun.sessionKey
        ? await steerGatewaySession({
            agentSlug: target.agentSlug,
            gatewayPort: selectedRun.gatewayPort,
            sessionKey: selectedRun.sessionKey,
            text: [
              `PM execution episode ${outcome.episode.episodeNo} is at ${outcome.episode.toolCycleCount}/${outcome.episode.toolCycleBudget} tool calls.`,
              "Before any more broad investigation, immediately call the task workflow endpoint with action=checkpoint and this turn's existing workflow token.",
              "Record concrete completedWork, evidence, openChecklist, one exact nextAction, and risks. Then continue only from that nextAction.",
              "Do not fetch full task history or repeat repository/browser discovery unless the checkpoint identifies a specific missing fact.",
            ].join(" "),
          })
        : { ok: false as const, error: "run has no gateway session identity" };
      await db.activityLog.create({
        data: {
          projectId: selectedRun?.projectId ?? undefined,
          taskId: target.taskId,
          kind: "task.execution.episode.checkpoint_steer",
          targetAgent: target.agentSlug,
          payload: JSON.stringify({
            runId: selectedRun?.id ?? null,
            messageId: target.messageId,
            episodeNo: outcome.episode.episodeNo,
            toolCycleCount: outcome.episode.toolCycleCount,
            toolCycleBudget: outcome.episode.toolCycleBudget,
            steer,
          }),
        },
      }).catch(() => {});
      return;
    }
    if (!outcome.rolledOver) return;

    // The counter is a safety boundary, not a dashboard decoration. Once the
    // message spends it, settle that transport turn as `continue`, seal the
    // checkpoint deterministically, and abort the OpenClaw process before it
    // can keep growing the same model context. Marking the run complete first
    // makes the abort callback a harmless late anomaly rather than a retry of
    // the poisoned job. The queued episode-rollover continuation is the only
    // owner of the next turn.
    const targetKey = pmChannelRunTargetKey(target);
    const run = await db.pmChannelRun.findUnique({
      where: { targetKey },
      select: {
        id: true,
        projectId: true,
        gatewayPort: true,
        sessionKey: true,
        status: true,
      },
    });
    if (!run) return;
    const now = new Date();
    await db.$transaction([
      db.pmChannelRun.updateMany({
        where: { id: run.id, status: { in: ["queued", "accepted", "streaming"] } },
        data: {
          status: "completed",
          error: null,
          completedAt: now,
          failedAt: null,
          finishedAt: now,
          finishedReason: "episode_tool_budget_exhausted",
          lastEventAt: now,
          disposition: "continue",
        },
      }),
      db.pmChannelJob.updateMany({
        where: { runId: run.id, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
        data: { status: "complete", completedAt: now, lastError: null },
      }),
    ]);
    await sealEpisodeRolloverBarrierOnTurnEnd({
      taskId: target.taskId,
      agentSlug: target.agentSlug,
      messageId: target.messageId,
    });

    let abort: { ok: boolean; error?: string } = { ok: true };
    if (run.gatewayPort && run.sessionKey) {
      abort = await abortGatewaySession({
        agentSlug: target.agentSlug,
        gatewayPort: run.gatewayPort,
        sessionKey: run.sessionKey,
      });
    }
    await db.activityLog.create({
      data: {
        projectId: run.projectId,
        taskId: target.taskId,
        kind: "task.execution.episode.tool_budget_abort",
        targetAgent: target.agentSlug,
        payload: JSON.stringify({
          runId: run.id,
          messageId: target.messageId,
          closedEpisodeNo: outcome.episode.episodeNo,
          successorEpisodeNo: outcome.nextEpisode?.episodeNo ?? null,
          toolCycleBudget: outcome.episode.toolCycleBudget,
          abort,
        }),
      },
    }).catch(() => {});
  } catch (err) {
    // Budget accounting must never break the agent's stream. A lost tool cycle
    // costs accuracy; a thrown error here would cost the turn.
    console.warn("[pm-channel] failed to record execution tool cycle", err);
  }
}

/**
 * The turn is ending. If it exhausted an episode and never wrote its final
 * checkpoint, write the derived one now and release the successor.
 *
 * This runs BEFORE the run settles, so the continuation it arms is still
 * `armed` when `queuePmChannelContinuationsForRun` promotes it to `queued` —
 * the same path every other continuation takes.
 */
async function sealTaskExecutionEpisodeOnTurnEnd(
  target: Extract<PmChannelReplyTarget, { kind: "task-chat" | "task-comment" }>,
) {
  await sealEpisodeRolloverBarrierOnTurnEnd({
    taskId: target.taskId,
    agentSlug: target.agentSlug,
    messageId: target.messageId,
  });
}

export async function applyPmChannelStreamCallback(args: {
  payload: Record<string, unknown>;
  transportMode?: string | null;
  rateLimit?: boolean;
}): Promise<ApplyPmChannelStreamCallbackResult> {
  const target = parsePmChannelReplyTarget(args.payload.target);
  const event = typeof args.payload.event === "string" && EVENTS.has(args.payload.event as PmChannelStreamEventKind)
    ? args.payload.event as PmChannelStreamEventKind
    : null;
  if (!target || !event) {
    return { status: 400, body: { error: "target and supported event are required" } };
  }

  const transportMode = normalizeTransportMode(
    args.transportMode ?? (typeof args.payload.transportMode === "string" ? args.payload.transportMode : null),
  );

  if (await pmChannelTargetIsCanceled(target)) {
    return { status: 200, body: { ok: true, canceled: true, ignored: true } };
  }

  if (!(await isAuthorizedPmChannelCallbackTarget(target))) {
    return { status: 403, body: { error: "Stream target is not authorized" } };
  }

  const text = stringField(args.payload.text, 40_000);
  const delta = stringField(args.payload.delta, 8_000);
  const transientProgress =
    (event === "partial" || event === "token" || event === "final") &&
    (isTransientPmProgressText(text) || isTransientPmProgressText(delta));

  // ENV-121 (second review). Sits ahead of every early return below — a
  // rate-limited, silent or transient terminal event still ends the turn, and a
  // fenced episode that is never sealed is a successor that is never
  // dispatched. Placing it before the settle also keeps the continuation on the
  // normal armed → queued path.
  // ENV-159: turn:terminal is the canonical equivalent of done.
  if (
    (event === "done" || event === "error" || event === "final" || event === "turn:terminal") &&
    (target.kind === "task-chat" || target.kind === "task-comment")
  ) {
    await sealTaskExecutionEpisodeOnTurnEnd(target);
  }

  // A terminal callback owns an exact authorized target. Release the durable
  // lane by the run's primary key before any rate-limit/silence early return;
  // targetKey is not a lease runId and previously made this a permanent no-op.
  if (
    !transientProgress &&
    (event === "done" || event === "error" || event === "final" || event === "turn:terminal")
  ) {
    const settled = await db.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      select: { id: true, status: true },
    });
    if (settled) await releaseExecutionLane({ runId: settled.id });
    if (
      (event === "done" || event === "turn:terminal") &&
      (settled?.status === "failed" || settled?.status === "timed_out")
    ) {
      return { status: 200, body: { ok: true, ignored: true, status: settled.status } };
    }
  }

  if (args.rateLimit !== false) {
    const rateLimit = checkPmChannelCallbackRateLimit({
      kind: "stream",
      agentSlug: target.agentSlug,
      targetKey: pmChannelRunTargetKey(target),
    });
    if (!rateLimit.allowed) {
      return {
        status: 429,
        body: { error: "PM channel stream rate limit exceeded" },
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      };
    }
  }

  // ENV-159: Canonical lifecycle events are persisted as stream events but
  // do not go through the legacy text/error/final pipeline. They carry
  // metadata about the execution lifecycle, not agent-visible content.
  if (event === "dispatch:delivered" || event === "turn:waiting_capacity" || event === "turn:admitted" || event === "context:usage") {
    const usage = event === "context:usage" && typeof args.payload.usage === "object" && args.payload.usage ? args.payload.usage as Record<string, unknown> : null;
    const persisted = await appendPmChannelStreamEventForTarget({ target, event });
    const state = publishPmChannelStreamEvent({ target, event, seq: persisted.seq });
    await recordStreamTransport(target, transportMode);
    // ENV-159 Step 5: context:usage carries token/window usage. When context
    // pressure is high (usage approaching window limit), trigger episode
    // rollover with context_pressure_recovery as the primary signal.
    if (event === "context:usage" && usage && (target.kind === "task-chat" || target.kind === "task-comment")) {
      const promptTokens = typeof usage.promptTokens === "number" ? usage.promptTokens : null;
      const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : null;
      const contextLimit = typeof usage.contextLimit === "number" ? usage.contextLimit : null;
      // Context pressure is the primary rollover signal when token/window data is available.
      // If prompt tokens exceed 80% of context limit, trigger rollover.
      if (promptTokens && contextLimit && promptTokens > contextLimit * 0.8) {
        try {
          const selectedRun = await db.pmChannelRun.findUnique({
            where: { targetKey: pmChannelRunTargetKey(target) },
            select: { id: true, taskId: true, projectId: true, agentSlug: true },
          });
          if (selectedRun?.taskId) {
            await db.$transaction(async (tx) => {
              const rollover = await rollOverTaskExecutionEpisodeForContextPressure(tx, {
                taskId: selectedRun.taskId!,
                projectId: selectedRun.projectId,
                agentSlug: selectedRun.agentSlug,
              });
              if (rollover) {
                console.warn(`[pm-channel] ENV-159 context pressure rollover triggered: ${promptTokens}/${contextLimit} tokens`);
              }
            });
          }
        } catch (err) {
          console.warn("[pm-channel] failed to trigger context pressure rollover", err);
        }
      }
    }
    if (event === "turn:admitted" || event === "dispatch:delivered") {
      const lifecycleProvider = typeof args.payload.provider === "string" ? args.payload.provider : null;
      const lifecycleModel = typeof args.payload.model === "string" ? args.payload.model : null;
      const lifecycleGatewayDispatchId = typeof args.payload.gatewayDispatchId === "string"
        ? args.payload.gatewayDispatchId
        : null;
      if (lifecycleProvider || lifecycleModel || lifecycleGatewayDispatchId) {
        try {
          await db.pmChannelRun.update({
            where: { targetKey: pmChannelRunTargetKey(target) },
            data: {
              ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
              ...(lifecycleModel ? { model: lifecycleModel } : {}),
              ...(lifecycleGatewayDispatchId ? { gatewayDispatchId: lifecycleGatewayDispatchId } : {}),
            },
          });
        } catch (err) {
          console.warn("[pm-channel] failed to persist run provenance from lifecycle event", err);
        }
      }
    }
    // ENV-159: turn:waiting_capacity records capacity-blocked metadata.
    // Capacity waiting does not consume retry attempts and is not recovered by
    // blindly redispatching the same message.
    if (event === "turn:waiting_capacity") {
      const now = new Date();
      const blockedByRunId = typeof args.payload.blockedByRunId === "string" ? args.payload.blockedByRunId : null;
      const blockedByTaskId = typeof args.payload.blockedByTaskId === "string" ? args.payload.blockedByTaskId : null;
      const gatewayDispatchId = typeof args.payload.gatewayDispatchId === "string" ? args.payload.gatewayDispatchId : null;
      try {
        await db.pmChannelRun.update({
          where: { targetKey: pmChannelRunTargetKey(target) },
          data: {
            status: "waiting_capacity",
            blockedReason: "agent_capacity",
            ...(blockedByRunId ? { blockedByRunId } : {}),
            ...(blockedByTaskId ? { blockedByTaskId } : {}),
            capacityBlockedAt: now,
            ...(gatewayDispatchId ? { gatewayDispatchId } : {}),
            lastEventAt: now,
          },
        });
      } catch (err) {
        console.warn("[pm-channel] failed to record capacity-blocked metadata", err);
      }
    }
    // ENV-159: turn:admitted transitions the run from delivered/waiting_capacity
    // to admitted, which starts the lease and represents actual model execution.
    if (event === "turn:admitted") {
      const now = new Date();
      const gatewayDispatchId = typeof args.payload.gatewayDispatchId === "string"
        ? args.payload.gatewayDispatchId
        : null;
      const leaseMs = Number.parseInt(process.env.PM_OPENCLAW_LEASE_MS ?? "120000", 10);
      const leaseExpiresAt = new Date(now.getTime() + (Number.isFinite(leaseMs) && leaseMs >= 30_000 ? leaseMs : 120_000));
      try {
        const run = await db.pmChannelRun.update({
          where: { targetKey: pmChannelRunTargetKey(target) },
          data: {
            status: "admitted",
            admittedAt: now,
            leaseExpiresAt,
            heartbeatAt: now,
            lastEventAt: now,
            ...(gatewayDispatchId ? { gatewayDispatchId } : {}),
          },
          select: { id: true },
        });
        await admitExecutionLaneForRun({ runId: run.id });
      } catch (err) {
        console.warn("[pm-channel] failed to transition run to admitted", err);
      }
    }
    if (event === "context:usage") {
      const run = await db.pmChannelRun.findUnique({
        where: { targetKey: pmChannelRunTargetKey(target) },
        select: { id: true },
      });
      if (run) await heartbeatExecutionLane({ runId: run.id });
    }
    return { status: 200, body: { ok: true, key: state.key, status: state.status } };
  }

  // ENV-159: model:selected is a metadata event — persist it and update run
  // provenance, then return without going through the text pipeline.
  if (event === "model:selected") {
    const selectedProvider = typeof args.payload.provider === "string" ? args.payload.provider : null;
    const selectedModel = typeof args.payload.model === "string" ? args.payload.model : null;
    const persisted = await appendPmChannelStreamEventForTarget({ target, event });
    const state = publishPmChannelStreamEvent({
      target,
      event,
      ...(selectedProvider ? { provider: selectedProvider } : {}),
      ...(selectedModel ? { model: selectedModel } : {}),
      seq: persisted.seq,
    });
    if (selectedProvider || selectedModel) {
      try {
        await db.pmChannelRun.update({
          where: { targetKey: pmChannelRunTargetKey(target) },
          data: {
            ...(selectedProvider ? { provider: selectedProvider } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
          },
        });
      } catch (err) {
        console.warn("[pm-channel] failed to persist run provenance from model:selected", err);
      }
    }
    await recordStreamTransport(target, transportMode);
    return { status: 200, body: { ok: true, key: state.key, status: state.status } };
  }

  if (event === "error" && await pmChannelTargetHasDurableReply(target)) {
    const persisted = await appendPmChannelStreamEventForTarget({ target, event: "done" });
    const state = publishPmChannelStreamEvent({ target, event: "done", seq: persisted.seq });
    // The durable reply makes this a legitimate settle for the UI, but the
    // error text must survive the done-conversion so the run can record it as
    // a completion anomaly instead of silently discarding it (PH-124).
    await recordPmChannelRunEvent({
      target,
      event: "done",
      error: stringField(args.payload.error, 2_000),
    });
    await recordStreamTransport(target, transportMode);
    await markPmChannelJobCompleteForTarget(target);
    return { status: 200, body: { ok: true, key: state.key, status: state.status } };
  }

  if (transientProgress) {
    // OpenClaw may label a compaction notice `final` even though the same turn
    // continues. Treat it as live progress for run/lane heartbeats without
    // persisting the internal text or settling the turn.
    await recordPmChannelRunEvent({ target, event: event === "final" ? "partial" : event });
    await recordStreamTransport(target, transportMode);
    return { status: 200, body: { ok: true, transient: true } };
  }
  if (event === "final" && isPmTerminalFailureText(text)) {
    const error = text || "OpenClaw terminal context recovery failure";
    const eventInput = { target, event: "error" as const, error };
    const persisted = await appendPmChannelStreamEventForTarget(eventInput);
    const state = publishPmChannelStreamEvent({ ...eventInput, seq: persisted.seq });
    await recordPmChannelRunEvent({ target, event: "error", error });
    await recordStreamTransport(target, transportMode);
    await recordStreamError(target, error);
    return { status: 200, body: { ok: true, key: state.key, status: state.status } };
  }
  if (
    (event === "partial" || event === "token" || event === "final") &&
    (isSilentPmReplyText(text) || isSilentPmReplyText(delta))
  ) {
    await recordPmChannelRunEvent({ target, event });
    await recordStreamTransport(target, transportMode);
    return { status: 200, body: { ok: true, silent: true } };
  }

  // ENV-122 / ENV-159: Extract provider/model from the stream payload's
  // agentMeta OR from the canonical model:selected event's top-level fields.
  // The final event carries the completed turn's metadata from OpenClaw;
  // earlier events may also include it. The canonical model:selected event
  // carries provider/model at the top level for all backends.
  const streamMeta = (args.payload.meta ?? args.payload.result) as Record<string, unknown> | undefined;
  const streamAgentMeta = streamMeta?.agentMeta as Record<string, unknown> | undefined;
  const canonicalProvider = typeof args.payload.provider === "string" ? args.payload.provider : null;
  const canonicalModel = typeof args.payload.model === "string" ? args.payload.model : null;
  const streamProvider = canonicalProvider ?? (typeof streamAgentMeta?.provider === "string" ? streamAgentMeta.provider : null);
  const streamModel = canonicalModel ?? (typeof streamAgentMeta?.model === "string" ? streamAgentMeta.model : null);
  if (streamProvider || streamModel) {
    try {
      await db.pmChannelRun.update({
        where: { targetKey: pmChannelRunTargetKey(target) },
        data: {
          ...(streamProvider ? { provider: streamProvider } : {}),
          ...(streamModel ? { model: streamModel } : {}),
        },
      });
    } catch (err) {
      console.warn("[pm-channel] failed to persist run provenance from stream", err);
    }
  }

  const toolCallId = stringField(args.payload.toolCallId, 200);
  const eventInput = {
    target,
    event,
    text,
    delta,
    replace: args.payload.replace === true,
    error: stringField(args.payload.error, 2_000),
    statusKind: lifecycleStatusField(args.payload.statusKind ?? args.payload.status),
    toolStatus: toolStatusField(args.payload.toolStatus),
    toolName: stringField(args.payload.toolName, 200),
    ...(toolCallId ? { toolCallId } : {}),
  };
  const persisted = await appendPmChannelStreamEventForTarget(eventInput);
  const state = publishPmChannelStreamEvent({ ...eventInput, seq: persisted.seq });
  await recordPmChannelRunEvent({
    target,
    event,
    error: stringField(args.payload.error, 2_000),
  });
  await recordStreamTransport(target, transportMode);
  if (event === "error") {
    await recordStreamError(target, state.error ?? stringField(args.payload.error, 2_000));
  }
  if ((event === "tool:call" || event === "tool:start") && (target.kind === "task-chat" || target.kind === "task-comment")) {
    // ENV-121 (review) / ENV-159: Count on the canonical tool:start event
    // (or legacy tool:call) — the finest unit of agent work PM can actually
    // observe. This is what stops "one browser-heavy turn" from being
    // unbounded while its workflow-action count sits at two. The canonical
    // tool:start fires for ALL backends (OpenAI, Ollama, Claude CLI, fallback),
    // while legacy tool:call only fires for OpenAI — so tool:start is the
    // provider-neutral trigger that closes the Ollama zero-count gap.
    // ENV-159: Pass toolCallId and toolName for idempotent correlation.
    await countTaskExecutionToolCycle(target, toolCallId || undefined, eventInput.toolName || undefined);
  }
  // ENV-159: Record tool:result completion to close the tool-call lifecycle.
  if (event === "tool:result" && toolCallId && (target.kind === "task-chat" || target.kind === "task-comment")) {
    try {
      const run = await db.pmChannelRun.findUnique({
        where: { targetKey: pmChannelRunTargetKey(target) },
        select: { id: true },
      });
      if (run) {
        await db.pmChannelToolCall.updateMany({
          where: { runId: run.id, toolCallId, completedAt: null },
          data: { completedAt: new Date() },
        });
      }
    } catch (err) {
      console.warn("[pm-channel] failed to record tool result completion", err);
    }
  }
  if (event === "final" && (target.kind === "task-chat" || target.kind === "task-comment")) {
    // Some OpenClaw turns emit PM_SILENT as a transient partial and then an
    // empty final, so the legacy reply route never runs. Apply the same
    // actionable-task continuation at the typed stream boundary; the helper's
    // competing-run and bounded-chain guards make this idempotent with a
    // parallel durable reply callback.
    await continueActionableTaskAfterReply({ target, replyId: null });
  }

  return { status: 200, body: { ok: true, key: state.key, status: state.status } };
}
