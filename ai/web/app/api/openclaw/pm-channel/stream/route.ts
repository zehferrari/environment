import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  parsePmChannelReplyTarget,
  type PmChannelReplyTarget,
  resolvePmChannelToken,
} from "@/lib/agents/openclaw-pm-channel";
import {
  publishPmChannelStreamEvent,
  type PmChannelStreamEventKind,
} from "@/lib/agents/pm-channel-stream";
import {
  pmChannelRunTargetKey,
  pmChannelTargetHasDurableReply,
  recordPmChannelRunEvent,
} from "@/lib/agents/pm-channel-runs";
import { markPmChannelJobCompleteForTarget } from "@/lib/agents/pm-channel-jobs";
import { appendPmChannelStreamEventForTarget } from "@/lib/agents/pm-channel-stream-log";
import { checkPmChannelCallbackRateLimit } from "@/lib/agents/pm-channel-rate-limit";
import { isSilentPmReplyText } from "@/lib/agents/pm-silence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EVENTS = new Set<PmChannelStreamEventKind>([
  "partial",
  "reasoning",
  "final",
  "done",
  "error",
]);

function configuredToken() {
  return process.env.PM_OPENCLAW_CHANNEL_TOKEN
    ?? process.env.PM_OPENCLAW_CHANNEL_CALLBACK_TOKEN
    ?? "";
}

function bearerToken(req: NextRequest) {
  const header = req.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : "";
}

function tokenMatches(actual: string, expected: string) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function stringField(value: unknown, max: number) {
  if (typeof value !== "string") return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

async function recordStreamError(target: PmChannelReplyTarget, error: string | undefined) {
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

export async function POST(req: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = parsePmChannelReplyTarget(payload.target);
  const event = typeof payload.event === "string" && EVENTS.has(payload.event as PmChannelStreamEventKind)
    ? payload.event as PmChannelStreamEventKind
    : null;
  if (!target || !event) {
    return NextResponse.json({ error: "target and supported event are required" }, { status: 400 });
  }

  const actualToken = bearerToken(req);
  const expectedShared = configuredToken();
  const expectedAgent = await resolvePmChannelToken(target.agentSlug);
  if (
    !tokenMatches(actualToken, expectedShared) &&
    !tokenMatches(actualToken, expectedAgent ?? "")
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rateLimit = checkPmChannelCallbackRateLimit({
    kind: "stream",
    agentSlug: target.agentSlug,
    targetKey: pmChannelRunTargetKey(target),
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "PM channel stream rate limit exceeded" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  if (event === "error" && await pmChannelTargetHasDurableReply(target)) {
    const persisted = await appendPmChannelStreamEventForTarget({ target, event: "done" });
    const state = publishPmChannelStreamEvent({ target, event: "done", seq: persisted.seq });
    await recordPmChannelRunEvent({ target, event: "done" });
    await markPmChannelJobCompleteForTarget(target);
    return NextResponse.json({ ok: true, key: state.key, status: state.status });
  }

  const text = stringField(payload.text, 40_000);
  const delta = stringField(payload.delta, 8_000);
  if (
    (event === "partial" || event === "final") &&
    (isSilentPmReplyText(text) || isSilentPmReplyText(delta))
  ) {
    return NextResponse.json({ ok: true, silent: true });
  }

  const eventInput = {
    target,
    event,
    text,
    delta,
    replace: payload.replace === true,
    error: stringField(payload.error, 2_000),
  };
  const persisted = await appendPmChannelStreamEventForTarget(eventInput);
  const state = publishPmChannelStreamEvent({ ...eventInput, seq: persisted.seq });
  await recordPmChannelRunEvent({
    target,
    event,
    error: stringField(payload.error, 2_000),
  });
  if (event === "error") {
    await recordStreamError(target, state.error ?? stringField(payload.error, 2_000));
  }

  return NextResponse.json({ ok: true, key: state.key, status: state.status });
}
