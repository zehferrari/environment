import { db } from "@/lib/db";
import {
  parsePmChannelReplyTarget,
  type PmChannelReplyTarget,
} from "@/lib/agents/pm-channel/openclaw";
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
import { recordTaskExecutionToolCycle } from "@/lib/agents/episodes/lifecycle";
import { armPmChannelContinuations } from "@/lib/agents/pm-channel/continuations";

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
  "token",
  "partial",
  "reasoning",
  "final",
  "done",
  "error",
]);

function stringField(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

function lifecycleStatusField(value: unknown): PmChannelLifecycleStatus | undefined {
  return value === "thinking" || value === "reading" || value === "working" ? value : undefined;
}

function toolStatusField(value: unknown): PmChannelToolStatus | undefined {
  return value === "call" || value === "result" ? value : undefined;
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
 * When that exhausts the budget the episode is closed, the successor is opened
 * and THIS message is fenced (see resolveEpisodeRolloverBarrier): from here on
 * the workflow route accepts only its final checkpoint. Nothing in the stream
 * path can stop the model mid-turn, so the barrier is what makes the boundary
 * real — the turn may keep talking, but it can no longer mutate the task or
 * bank work against episode N+1.
 *
 * The rollover also arms a continuation, because unlike a workflow-action
 * rollover there is no action here to arm one. Without it the successor
 * episode would sit open with nobody scheduled to run it.
 */
async function countTaskExecutionToolCycle(
  target: Extract<PmChannelReplyTarget, { kind: "task-chat" | "task-comment" }>,
) {
  try {
    const outcome = await recordTaskExecutionToolCycle({
      taskId: target.taskId,
      agentSlug: target.agentSlug,
      messageId: target.messageId,
    });
    if (!outcome?.rolledOver) return;

    const run = await db.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      select: { id: true, projectId: true, taskId: true, epicId: true },
    });
    if (!run?.taskId) return;
    await db.$transaction((tx) =>
      armPmChannelContinuations(tx, {
        runs: [run],
        agentSlug: target.agentSlug,
        messageId: target.messageId,
        action: "episode_tool_budget_rollover",
        now: new Date(),
      }),
    );
  } catch (err) {
    // Budget accounting must never break the agent's stream. A lost tool cycle
    // costs accuracy; a thrown error here would cost the turn.
    console.warn("[pm-channel] failed to record execution tool cycle", err);
  }
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

  if (event === "done") {
    const settled = await db.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      select: { status: true },
    });
    if (settled?.status === "failed" || settled?.status === "timed_out") {
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

  const text = stringField(args.payload.text, 40_000);
  const delta = stringField(args.payload.delta, 8_000);
  if (
    (event === "partial" || event === "token" || event === "final") &&
    (isTransientPmProgressText(text) || isTransientPmProgressText(delta))
  ) {
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
    return { status: 200, body: { ok: true, silent: true } };
  }

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
  if (event === "tool:call" && (target.kind === "task-chat" || target.kind === "task-comment")) {
    // ENV-121 (review). This is the finest unit of agent work PM can actually
    // observe, and it is the one that grows a turn's context. Counting it here
    // is what stops "one browser-heavy turn" from being unbounded while its
    // workflow-action count sits at two.
    await countTaskExecutionToolCycle(target);
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
