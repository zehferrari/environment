import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import {
  parsePmChannelReplyTarget,
  resolvePmChannelToken,
  type PmChannelReplyTarget,
} from "@/lib/agents/pm-channel/openclaw";
import { db } from "@/lib/db";
import { cancelPmChannelRunForTarget, pmChannelRunTargetKey } from "@/lib/agents/pm-channel/runs";
import { publishPmChannelStreamEvent } from "@/lib/agents/pm-channel/stream";
import { enqueuePmChannelStreamDurability } from "@/lib/agents/pm-channel/stream-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function targetPath(target: PmChannelReplyTarget) {
  if (target.kind === "direct") return `/agents/${target.agentSlug}/chat`;
  if (target.kind === "epic-chat") return target.projectSlug
    ? `/projects/${target.projectSlug}/epics/${target.epicId}`
    : null;
  return target.projectSlug
    ? `/projects/${target.projectSlug}/tasks/${target.taskId}`
    : null;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id || session.user.kind === "agent") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = parsePmChannelReplyTarget(payload.target);
  if (!target) {
    return NextResponse.json({ error: "Valid target is required" }, { status: 400 });
  }

  const run = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: { gatewayPort: true, sessionKey: true, agentSlug: true },
  });

  const result = await cancelPmChannelRunForTarget({
    target,
    actorUserId: session.user.id,
  });
  let abortResult: Record<string, unknown> | null = null;
  if (run?.gatewayPort && run.sessionKey) {
    try {
      const token = await resolvePmChannelToken(run.agentSlug);
      const res = await fetch(`http://127.0.0.1:${run.gatewayPort}/pm-channel/cancel`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sessionKey: run.sessionKey }),
      });
      abortResult = await res.json().catch(() => ({ ok: res.ok, status: res.status }));
    } catch (error) {
      abortResult = { ok: false, error: error instanceof Error ? error.message : "Gateway cancel failed" };
    }
  }
  if (result.canceled) {
    const canceledEvent = {
      target,
      event: "status",
      runStatus: "canceled",
    } as const;
    publishPmChannelStreamEvent(canceledEvent);
    await enqueuePmChannelStreamDurability(canceledEvent);
  }

  return NextResponse.json({
    ok: true,
    canceled: result.canceled,
    reason: result.canceled ? null : result.reason,
    abort: abortResult,
    path: targetPath(target),
  });
}
