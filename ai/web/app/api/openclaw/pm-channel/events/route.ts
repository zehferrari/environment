import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  parsePmChannelReplyTarget,
  type PmChannelReplyTarget,
} from "@/lib/agents/openclaw-pm-channel";
import {
  createPmChannelEventStream,
  pmChannelStreamKey,
  type PmChannelStreamState,
} from "@/lib/agents/pm-channel-stream";
import { getPmChannelRunSnapshot } from "@/lib/agents/pm-channel-runs";
import { replayPmChannelStreamFrames } from "@/lib/agents/pm-channel-stream-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function targetFromSearch(params: URLSearchParams): PmChannelReplyTarget | null {
  const kind = params.get("kind");
  const agentSlug = params.get("agentSlug") ?? "";
  const messageId = params.get("messageId") ?? "";
  const taskId = params.get("taskId") ?? "";
  const epicId = params.get("epicId") ?? "";
  return parsePmChannelReplyTarget({
    kind,
    agentSlug,
    messageId,
    taskId,
    epicId,
    projectSlug: params.get("projectSlug"),
  });
}

async function targetExists(target: PmChannelReplyTarget) {
  if (target.kind === "direct") {
    const row = await db.directAgentChatMessage.findFirst({
      where: { id: target.messageId, agentSlug: target.agentSlug },
      select: { id: true },
    });
    return Boolean(row);
  }

  if (target.kind === "epic-chat") {
    const row = await db.agentChatMessage.findFirst({
      where: {
        id: target.messageId,
        agentSlug: { in: [target.agentSlug, "room"] },
        epicId: target.epicId,
      },
      select: { id: true },
    });
    return Boolean(row);
  }

  const row = await db.agentChatMessage.findFirst({
    where: {
      id: target.messageId,
      agentSlug: { in: [target.agentSlug, "room"] },
      taskId: target.taskId,
    },
    select: { id: true },
  });
  return Boolean(row);
}

function streamStateFromRun(
  target: PmChannelReplyTarget,
  run: Awaited<ReturnType<typeof getPmChannelRunSnapshot>>,
): PmChannelStreamState | null {
  if (!run) return null;
  const status = run.status === "failed"
    ? "error"
    : run.status === "complete"
      ? "done"
      : "streaming";
  return {
    key: pmChannelStreamKey(target),
    target,
    text: "",
    reasoning: "",
    status,
    runStatus: run.status as PmChannelStreamState["runStatus"],
    error: run.status === "failed" ? run.error ?? "Agent run failed" : null,
    seq: run.streamSeq,
    updatedAt: run.lastEventAt?.getTime() ?? Date.now(),
  };
}

function lastEventSeq(req: Request) {
  const raw = req.headers.get("last-event-id") ?? "";
  const seq = Number.parseInt(raw, 10);
  return Number.isFinite(seq) && seq > 0 ? seq : 0;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });

  const target = targetFromSearch(new URL(req.url).searchParams);
  if (!target) return new Response("Bad request", { status: 400 });
  if (!(await targetExists(target))) return new Response("Not found", { status: 404 });

  const run = await getPmChannelRunSnapshot(target);
  const replayFrames = run?.id
    ? await replayPmChannelStreamFrames({
        runId: run.id,
        target,
        afterSeq: lastEventSeq(req),
      })
    : [];

  return new Response(
    createPmChannelEventStream(
      pmChannelStreamKey(target),
      streamStateFromRun(target, run),
      replayFrames,
    ),
    {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
    },
  );
}
