import { timingSafeEqual } from "crypto";
import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  parsePmChannelReplyTarget,
  resolvePmChannelToken,
  type PmChannelReplyTarget,
} from "@/lib/agents/openclaw-pm-channel";
import { publishPmChannelStreamEvent } from "@/lib/agents/pm-channel-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

function replyBody(payload: Record<string, unknown>) {
  const value = payload.text ?? payload.body;
  return typeof value === "string" ? value.trim() : "";
}

async function activeAgentUser(agentSlug: string) {
  const agent = await db.agent.findUnique({
    where: { slug: agentSlug },
    select: {
      slug: true,
      deactivatedAt: true,
      user: { select: { id: true, status: true } },
    },
  });
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return null;
  }
  return agent.user;
}

async function persistDirectReply(target: Extract<PmChannelReplyTarget, { kind: "direct" }>, body: string) {
  const [original, agentUser] = await Promise.all([
    db.directAgentChatMessage.findUnique({
      where: { id: target.messageId },
      select: { id: true, agentSlug: true, archiveId: true, baseArchiveId: true },
    }),
    activeAgentUser(target.agentSlug),
  ]);

  if (!original || original.agentSlug !== target.agentSlug) {
    return { status: 404, body: { error: "Message not found" } };
  }
  if (!agentUser) {
    return { status: 403, body: { error: "Agent not active" } };
  }

  const reply = await db.$transaction(async (tx) => {
    const created = await tx.directAgentChatMessage.create({
      data: {
        agentSlug: target.agentSlug,
        senderUserId: agentUser.id,
        archiveId: original.archiveId,
        baseArchiveId: original.baseArchiveId,
        body,
      },
      select: { id: true, archiveId: true, createdAt: true },
    });
    if (created.archiveId) {
      await tx.directAgentChatArchive.update({
        where: { id: created.archiveId },
        data: {
          endedAt: created.createdAt,
          messageCount: { increment: 1 },
        },
      });
    }
    await tx.activityLog.create({
      data: {
        userId: agentUser.id,
        kind: "agent.direct_chat.reply",
        targetAgent: target.agentSlug,
        payload: JSON.stringify({
          driver: "openclaw-pm-channel",
          agentSlug: target.agentSlug,
          messageId: created.id,
          inReplyToMessageId: target.messageId,
        }),
      },
    });
    return created;
  });

  revalidatePath(`/agents/${target.agentSlug}/chat`);
  return { status: 200, body: { ok: true, id: reply.id, channel: "direct" } };
}

async function resolveTaskReplyOrigin(args: {
  messageId: string;
  taskId: string;
  agentSlug: string;
  targetKind: "task-chat" | "task-comment";
  originChannel?: string | null;
  originCommentId?: string | null;
}) {
  if (args.targetKind === "task-comment" || args.originChannel === "comment") {
    return { channel: "comment" as const, originCommentId: args.originCommentId ?? null };
  }
  return { channel: "chat" as const, originCommentId: null };
}

async function persistTaskReply(
  target: Extract<PmChannelReplyTarget, { kind: "task-chat" | "task-comment" }>,
  body: string,
) {
  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      id: true,
      projectId: true,
      taskId: true,
      agentSlug: true,
      originChannel: true,
      originCommentId: true,
      project: { select: { slug: true } },
      task: { select: { deletedAt: true } },
    },
  });
  if (!original || original.taskId !== target.taskId || original.task?.deletedAt) {
    return { status: 404, body: { error: "Message not found" } };
  }
  if (original.agentSlug !== target.agentSlug) {
    return { status: 403, body: { error: "Agent mismatch" } };
  }

  const agentUser = await activeAgentUser(target.agentSlug);
  if (!agentUser) {
    return { status: 403, body: { error: "Agent not active" } };
  }

  const origin = await resolveTaskReplyOrigin({
    messageId: target.messageId,
    taskId: target.taskId,
    agentSlug: target.agentSlug,
    targetKind: target.kind,
    originChannel: original.originChannel,
    originCommentId: original.originCommentId,
  });

  const reply = await db.$transaction(async (tx) => {
    if (origin.channel === "comment") {
      const comment = await tx.comment.create({
        data: {
          taskId: target.taskId,
          userId: agentUser.id,
          body,
        },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: original.projectId,
          taskId: target.taskId,
          userId: agentUser.id,
          kind: "task.comment",
          targetAgent: target.agentSlug,
          payload: JSON.stringify({
            driver: "openclaw-pm-channel",
            commentId: comment.id,
            originCommentId: origin.originCommentId,
            inReplyToMessageId: target.messageId,
            agentSlug: target.agentSlug,
          }),
        },
      });
      return { id: comment.id, channel: "comment" as const };
    }

    const created = await tx.agentChatMessage.create({
      data: {
        projectId: original.projectId,
        taskId: target.taskId,
        epicId: null,
        agentSlug: target.agentSlug,
        senderUserId: agentUser.id,
        body,
        allowDescriptionEdit: false,
        originChannel: "chat",
      },
      select: { id: true },
    });
    await tx.activityLog.create({
      data: {
        projectId: original.projectId,
        taskId: target.taskId,
        userId: agentUser.id,
        kind: "task.chat.reply",
        targetAgent: target.agentSlug,
        payload: JSON.stringify({
          driver: "openclaw-pm-channel",
          messageId: created.id,
          inReplyToMessageId: target.messageId,
          agentSlug: target.agentSlug,
        }),
      },
    });
    return { id: created.id, channel: "chat" as const };
  });

  revalidatePath(`/projects/${original.project.slug}/tasks/${target.taskId}`);
  return { status: 200, body: { ok: true, id: reply.id, channel: reply.channel } };
}

export async function POST(req: NextRequest) {
  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const target = parsePmChannelReplyTarget(payload.target);
  const body = replyBody(payload);
  if (!target || !body || body.length > 8000) {
    return NextResponse.json(
      { error: "target and non-empty text/body <= 8000 chars are required" },
      { status: 400 },
    );
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

  const result = target.kind === "direct"
    ? await persistDirectReply(target, body)
    : await persistTaskReply(target, body);

  if (result.status >= 200 && result.status < 300) {
    publishPmChannelStreamEvent({
      target,
      event: "final",
      text: body,
      replace: true,
    });
  }

  return NextResponse.json(result.body, { status: result.status });
}
