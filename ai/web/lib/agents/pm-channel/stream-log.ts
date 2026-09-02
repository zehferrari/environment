import { db } from "@/lib/db";
import type { PmChannelReplyTarget } from "@/lib/agents/pm-channel/openclaw";
import {
  acknowledgePmChannelStreamSeq,
  applyPmChannelStreamInput,
  emptyPmChannelStreamState,
  publishPmChannelStreamEvent,
  pmChannelStreamKey,
  type PmChannelReplayFrame,
  type PmChannelStreamEventKind,
  type PmChannelStreamInput,
  type PmChannelStreamState,
} from "@/lib/agents/pm-channel/stream";
import {
  pmChannelRunTargetKey,
  recordPmChannelRunQueued,
} from "@/lib/agents/pm-channel/runs";

export type PersistedStreamInput = Omit<PmChannelStreamInput, "target" | "provider" | "model" | "degradedTelemetry">;

const STREAM_DURABILITY_RETRY_BASE_MS = 250;
const STREAM_DURABILITY_RETRY_MAX_MS = 5_000;

type DurabilitySuccess = (
  persisted: Awaited<ReturnType<typeof appendPmChannelStreamEventForTarget>>,
) => void | Promise<void>;

const durabilityChains = new Map<string, Promise<void>>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function durabilityInput(input: PmChannelStreamInput): PersistedStreamInput {
  return {
    event: input.event,
    text: input.text,
    delta: input.delta,
    replace: input.replace,
    error: input.error,
    runStatus: input.runStatus,
    statusKind: input.statusKind,
    toolStatus: input.toolStatus,
    toolName: input.toolName,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
  };
}

async function persistWithRetry(input: PmChannelStreamInput, onPersisted?: DurabilitySuccess) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const persisted = await appendPmChannelStreamEventForTarget({
        target: input.target,
        ...durabilityInput(input),
      });
      acknowledgePmChannelStreamSeq(input.target, persisted.seq);
      if (onPersisted) {
        Promise.resolve(onPersisted(persisted)).catch((err) => {
          console.warn("[pm-channel] failed to run stream durability callback", {
            key: pmChannelStreamKey(input.target),
            event: input.event,
            error: err,
          });
        });
      }
      return;
    } catch (err) {
      console.warn("[pm-channel] failed to persist stream event; retrying", {
        key: pmChannelStreamKey(input.target),
        event: input.event,
        attempt,
        error: err,
      });
      await sleep(Math.min(
        STREAM_DURABILITY_RETRY_MAX_MS,
        STREAM_DURABILITY_RETRY_BASE_MS * 2 ** Math.min(8, attempt - 1),
      ));
    }
  }
}

export function enqueuePmChannelStreamDurability(
  input: PmChannelStreamInput,
  onPersisted?: DurabilitySuccess,
) {
  const key = pmChannelStreamKey(input.target);
  const previous = durabilityChains.get(key) ?? Promise.resolve();
  const next = previous
    .catch((err) => {
      console.warn("[pm-channel] stream durability queue recovered after failure", { key, error: err });
    })
    .then(() => persistWithRetry(input, onPersisted));

  durabilityChains.set(key, next);
  next.finally(() => {
    if (durabilityChains.get(key) === next) durabilityChains.delete(key);
  });
  return next;
}

export function publishPmChannelStreamEventDurably(
  input: PmChannelStreamInput,
  onPersisted?: DurabilitySuccess,
) {
  const state = publishPmChannelStreamEvent(input);
  enqueuePmChannelStreamDurability(input, onPersisted);
  return state;
}

function targetKind(target: PmChannelReplyTarget) {
  return target.kind;
}

function targetProjectSlug(target: PmChannelReplyTarget) {
  return "projectSlug" in target ? target.projectSlug ?? null : null;
}

function eventName(kind: PmChannelStreamEventKind) {
  return kind === "error" ? "stream-error" : kind;
}

function parsePayload(payload: string): PersistedStreamInput | null {
  try {
    return JSON.parse(payload) as PersistedStreamInput;
  } catch {
    return null;
  }
}

export async function ensurePmChannelRunForTarget(target: PmChannelReplyTarget) {
  const existing = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: { id: true, streamSeq: true },
  });
  if (existing) return existing;

  const created = await recordPmChannelRunQueued({
    target,
    kind: targetKind(target),
    projectId: null,
    gatewayPort: null,
    sessionKey: null,
  });
  if (!created) {
    throw new Error(`Unable to create PM channel run for ${pmChannelRunTargetKey(target)}`);
  }
  return { id: created.id, streamSeq: created.streamSeq };
}

export async function appendPmChannelStreamEvent(args: {
  runId: string;
  event: PmChannelStreamEventKind;
  input: PersistedStreamInput;
}) {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const run = await tx.pmChannelRun.update({
      where: { id: args.runId },
      data: {
        streamSeq: { increment: 1 },
        lastEventAt: now,
      },
      select: { streamSeq: true },
    });
    const created = await tx.pmChannelStreamEvent.create({
      data: {
        runId: args.runId,
        seq: run.streamSeq,
        kind: args.event,
        payload: JSON.stringify({
          ...args.input,
          event: args.event,
          seq: run.streamSeq,
        }),
      },
      select: { id: true, runId: true, seq: true, kind: true, payload: true, createdAt: true },
    });
    // Billing reuses the PM-channel transport but owns its presentation. Copy
    // every visible frame to the Billing generation before the generic replay
    // ledger compacts token partials on final, so leaving and returning to the
    // tab restores the complete emitted progress and response.
    const pmRun = await tx.pmChannelRun.findUnique({
      where: { id: args.runId },
      select: { kind: true, messageId: true },
    });
    if (pmRun?.kind === "direct") {
      const message = await tx.directAgentChatMessage.findUnique({
        where: { id: pmRun.messageId },
        select: { billingRunId: true },
      });
      if (message?.billingRunId) {
        await tx.billingRunEvent.upsert({
          where: { runId_seq: { runId: message.billingRunId, seq: run.streamSeq } },
          create: {
            runId: message.billingRunId,
            seq: run.streamSeq,
            kind: args.event,
            payload: created.payload,
          },
          update: { kind: args.event, payload: created.payload },
        });
      }
    }
    // A `final` carrying replace+full-text is a self-contained terminal frame:
    // replay can reconstruct the complete reply from it alone. Drop the now-
    // redundant per-token/partial rows so this append-only ledger doesn't grow
    // without bound (a long streamed reply is otherwise hundreds of rows that
    // every reconnect re-reads). Finals without replace text are left intact so
    // delta-accumulated replies still replay correctly.
    if (args.event === "final" && args.input.replace && args.input.text) {
      await tx.pmChannelStreamEvent.deleteMany({
        where: { runId: args.runId, seq: { lt: run.streamSeq } },
      });
    }
    return created;
  });
}

export async function appendPmChannelStreamEventForTarget(args: {
  target: PmChannelReplyTarget;
  event: PmChannelStreamEventKind;
  text?: string;
  delta?: string;
  replace?: boolean;
  error?: string;
  runStatus?: PmChannelStreamState["runStatus"];
  statusKind?: PersistedStreamInput["statusKind"];
  toolStatus?: PersistedStreamInput["toolStatus"];
  toolName?: string;
  toolCallId?: string;
}) {
  const run = await ensurePmChannelRunForTarget(args.target);
  return appendPmChannelStreamEvent({
    runId: run.id,
    event: args.event,
    input: {
      event: args.event,
      text: args.text,
      delta: args.delta,
      replace: args.replace,
      error: args.error,
      runStatus: args.runStatus,
      statusKind: args.statusKind,
      toolStatus: args.toolStatus,
      toolName: args.toolName,
      ...(args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    },
  });
}

export async function replayPmChannelStreamFrames(args: {
  runId: string;
  target: PmChannelReplyTarget;
  afterSeq: number;
}) {
  const rows = await db.pmChannelStreamEvent.findMany({
    where: { runId: args.runId },
    orderBy: { seq: "asc" },
    select: { seq: true, kind: true, payload: true },
  });

  let state = emptyPmChannelStreamState(args.target);
  const frames: PmChannelReplayFrame[] = [];
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    if (!payload) continue;
    state = applyPmChannelStreamInput(state, {
      target: args.target,
      event: row.kind as PmChannelStreamEventKind,
      text: payload.text,
      delta: payload.delta,
      replace: payload.replace,
      error: payload.error,
      runStatus: payload.runStatus,
      statusKind: payload.statusKind,
      toolStatus: payload.toolStatus,
      toolName: payload.toolName,
      ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
      seq: row.seq,
    });
    if (row.seq > args.afterSeq) {
      frames.push({ event: eventName(row.kind as PmChannelStreamEventKind), state: { ...state } });
    }
  }
  return frames;
}

export function buildContextBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

export function targetLabelForLog(target: PmChannelReplyTarget) {
  return {
    targetKey: pmChannelRunTargetKey(target),
    kind: target.kind,
    agentSlug: target.agentSlug,
    projectSlug: targetProjectSlug(target),
  };
}
