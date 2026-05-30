import { db } from "@/lib/db";
import type { PmChannelReplyTarget } from "@/lib/agents/openclaw-pm-channel";
import {
  applyPmChannelStreamInput,
  emptyPmChannelStreamState,
  type PmChannelReplayFrame,
  type PmChannelStreamEventKind,
  type PmChannelStreamInput,
  type PmChannelStreamState,
} from "@/lib/agents/pm-channel-stream";
import {
  pmChannelRunTargetKey,
  recordPmChannelRunQueued,
} from "@/lib/agents/pm-channel-runs";

export type PersistedStreamInput = Omit<PmChannelStreamInput, "target">;

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
    return tx.pmChannelStreamEvent.create({
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
