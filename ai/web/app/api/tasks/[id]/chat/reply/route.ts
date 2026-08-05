import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { pmChannelRunTargetKey } from "@/lib/agents/pm-channel/bus";
import { verifyTaskChatReplyToken } from "@/lib/agents/workflow/chat/task/token";
import { sendTaskCommentNotifications } from "@/lib/agents/workflow/notifications/task";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import { tryCompleteTaskFromReviewerComment } from "@/lib/tasks/review-automation";
import { hasAuthorizedTaskAgentOrigin } from "@/lib/agents/owner-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReplyOrigin = "chat" | "comment";

async function resolveReplyOrigin(args: {
  messageId: string;
  taskId: string;
  agentSlug: string;
  originChannel?: string | null;
  originCommentId?: string | null;
}): Promise<{ channel: ReplyOrigin; originCommentId: string | null }> {
  if (args.originChannel === "comment") {
    return { channel: "comment", originCommentId: args.originCommentId ?? null };
  }

  // Backward compatibility for messages created before originChannel
  // existed. Mirrored task comments were recorded in the activity log
  // with mirroredFromCommentId.
  const sendLog = await db.activityLog.findFirst({
    where: {
      taskId: args.taskId,
      kind: "task.chat.send",
      targetAgent: args.agentSlug,
      payload: { contains: args.messageId },
    },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  if (sendLog?.payload) {
    try {
      const payload = JSON.parse(sendLog.payload) as {
        messageId?: unknown;
        mirroredFromCommentId?: unknown;
      };
      if (
        payload.messageId === args.messageId &&
        typeof payload.mirroredFromCommentId === "string"
      ) {
        return {
          channel: "comment",
          originCommentId: payload.mirroredFromCommentId,
        };
      }
    } catch {
      // Ignore malformed historical payloads and keep the default chat origin.
    }
  }

  return { channel: "chat", originCommentId: null };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: taskId } = await ctx.params;
  let payload: { messageId?: unknown; token?: unknown; body?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!messageId || !token || !body || body.length > 8000) {
    return NextResponse.json(
      { error: "messageId, token, and non-empty body <= 8000 chars are required" },
      { status: 400 },
    );
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      projectId: true,
      taskId: true,
      agentSlug: true,
      archiveId: true,
      baseArchiveId: true,
      originChannel: true,
      originCommentId: true,
      senderUserId: true,
      sender: { select: { kind: true, status: true } },
      project: { select: { slug: true } },
      task: {
        select: {
          deletedAt: true,
          private: true,
          epic: { select: { private: true } },
          parent: { select: { private: true, epic: { select: { private: true } } } },
        },
      },
    },
  });
  if (
    !original ||
    original.taskId !== taskId ||
    original.task?.deletedAt ||
    original.task?.private ||
    original.task?.epic?.private ||
    original.task?.parent?.private ||
    original.task?.parent?.epic?.private
  ) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }

  let agentSlug = original.agentSlug;
  let verified = false;

  if (original.agentSlug === "room") {
    const activeAgents = await db.agent.findMany({
      where: { deactivatedAt: null },
      select: { slug: true },
    });
    for (const a of activeAgents) {
      if (verifyTaskChatReplyToken(messageId, taskId, a.slug, token)) {
        agentSlug = a.slug;
        verified = true;
        break;
      }
    }
  } else {
    verified = verifyTaskChatReplyToken(messageId, taskId, original.agentSlug, token);
  }

  if (!verified) {
    return NextResponse.json({ error: "Invalid reply token" }, { status: 403 });
  }

  if (!(await hasAuthorizedTaskAgentOrigin({
    taskId,
    messageId,
    targetAgentSlug: agentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  }))) {
    return NextResponse.json({ error: "Reply grant is no longer authorized" }, { status: 403 });
  }

  const agent = await db.agent.findUnique({
    where: { slug: agentSlug },
    select: {
      slug: true,
      deactivatedAt: true,
      user: { select: { id: true, status: true } },
    },
  });
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }

  const origin = await resolveReplyOrigin({
    messageId,
    taskId,
    agentSlug: original.agentSlug,
    originChannel: original.originChannel,
    originCommentId: original.originCommentId,
  });

  // ENV-122: Look up the active PmChannelRun to wire runId provenance.
  const runId = await db.pmChannelRun.findFirst({
    where: { messageId, agentSlug, status: { in: ["queued", "accepted", "streaming", "completed"] } },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  }).then((r) => r?.id ?? null);

  const reply = await db.$transaction(async (tx) => {
    if (origin.channel === "comment") {
      const comment = await tx.comment.create({
        data: {
          taskId,
          userId: agent.user!.id,
          body,
          authorAgentSlug: original.agentSlug,
          commentKind: "agent_reply",
          isGenerated: false,
          runId,
        },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: original.projectId,
          taskId,
          userId: agent.user!.id,
          kind: "task.comment",
          targetAgent: original.agentSlug,
          payload: JSON.stringify({
            commentId: comment.id,
            originCommentId: origin.originCommentId,
            inReplyToMessageId: messageId,
            agentSlug: original.agentSlug,
          }),
        },
      });
      return { id: comment.id, channel: "comment" as const };
    }

    const created = await tx.agentChatMessage.create({
      data: {
        projectId: original.projectId,
        taskId,
        epicId: null,
        agentSlug: original.agentSlug,
        archiveId: original.archiveId,
        baseArchiveId: original.baseArchiveId,
        senderUserId: agent.user!.id,
        body,
        allowDescriptionEdit: false,
        originChannel: "chat",
      },
      select: { id: true, archiveId: true, createdAt: true },
    });
    if (created.archiveId) {
      await tx.agentChatRoomArchive.update({
        where: { id: created.archiveId },
        data: {
          endedAt: created.createdAt,
          messageCount: { increment: 1 },
        },
      });
    }
    await tx.activityLog.create({
      data: {
        projectId: original.projectId,
        taskId,
        userId: agent.user!.id,
        kind: "task.chat.reply",
        targetAgent: original.agentSlug,
        payload: JSON.stringify({
          messageId: created.id,
          inReplyToMessageId: messageId,
          agentSlug: original.agentSlug,
        }),
      },
    });
    return { id: created.id, channel: "chat" as const };
  });

  const reviewAutomation = reply.channel === "comment"
    ? await tryCompleteTaskFromReviewerComment({
        taskId,
        commentId: reply.id,
        body,
        agentUserId: agent.user.id,
        agentSlug,
      })
    : null;

  if (reply.channel === "comment" && !reviewAutomation?.completed) {
    await sendTaskCommentNotifications({
      taskId,
      commentId: reply.id,
      body,
      actor: {
        id: agent.user.id,
        kind: "agent",
        username: agent.slug,
      },
      excludeAgentSlugs: [agent.slug],
    });
  }

  revalidateTaskReplyScope(taskId, reply.channel);
  if (reviewAutomation?.completed) {
    revalidateTaskShell(taskId);
    for (const next of reviewAutomation.nextTasks ?? []) {
      revalidateTaskShell(next.id);
      revalidatePath(`/projects/${next.projectSlug}/tasks/${next.id}`);
    }
    revalidatePath(`/projects/${reviewAutomation.projectSlug}`);
  }
  return NextResponse.json({
    ok: true,
    id: reply.id,
    channel: reply.channel,
    reviewAutomation,
  });
}
