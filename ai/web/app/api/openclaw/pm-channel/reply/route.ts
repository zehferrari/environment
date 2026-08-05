import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  parsePmChannelReplyTarget,
  resolvePmChannelToken,
  type PmChannelReplyTarget,
} from "@/lib/agents/pm-channel/openclaw";
import { authorizePmChannelCallback } from "@/lib/agents/pm-channel/callback-auth";

import {
  pmChannelRunTargetKey,
  pmChannelTargetIsCanceled,
  pmChannelTargetHasDurableReply,
  recordPmChannelRunEvent,
} from "@/lib/agents/pm-channel/runs";
import { markPmChannelJobCompleteForTarget } from "@/lib/agents/pm-channel/jobs";
import {
  enqueuePmChannelStreamDurability,
  publishPmChannelStreamEventDurably,
} from "@/lib/agents/pm-channel/stream-log";
import { publishPmChannelStreamEvent } from "@/lib/agents/pm-channel/stream";
import { checkPmChannelCallbackRateLimit } from "@/lib/agents/pm-channel/rate-limit";
import { normalizeDiscussionReplySections } from "@/lib/agents/chat/discussion-reply-format";
import {
  isPmTerminalFailureText,
  isSilentPmReplyText,
  isTransientPmProgressText,
} from "@/lib/agents/ops/pm-silence";
import { notifyHumanOfAgentReply } from "@/lib/push/notify-reply";
import { revalidateEpicReplyScope } from "@/lib/epics/cache";
import { isAuthorizedPmChannelCallbackTarget } from "@/lib/agents/pm-channel/target-authorization";
import { continueActionableTaskAfterReply } from "@/lib/agents/workflow/execution-continuation";
import {
  persistTaskReply,
  activeAgentUser,
} from "@/lib/agents/pm-channel/persist-task-reply";

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

function replyBody(payload: Record<string, unknown>) {
  const value = payload.text ?? payload.body;
  return typeof value === "string" ? value.trim() : "";
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
  return { status: 200, body: { ok: true, id: reply.id, channel: "direct" }, streamText: body };
}

export async function persistTaskReply(
  target: Extract<PmChannelReplyTarget, { kind: "task-chat" | "task-comment" }>,
  body: string,
  actionPlanPayload?: unknown,
) {
  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      id: true,
      projectId: true,
      taskId: true,
      agentSlug: true,
      archiveId: true,
      baseArchiveId: true,
      originChannel: true,
      originCommentId: true,
      project: { select: { slug: true } },
      task: { select: { deletedAt: true } },
    },
  });
  if (!original || original.taskId !== target.taskId || original.task?.deletedAt) {
    return { status: 404, body: { error: "Message not found" } };
  }
  if (original.agentSlug !== "room" && original.agentSlug !== target.agentSlug) {
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
  const originWorkflowReason = origin.channel === "comment"
    ? await taskWorkflowReasonForMessage(target.taskId, target.messageId)
    : null;
  const persistedBody = origin.channel === "chat"
    ? normalizeDiscussionReplySections(body)
    : body;

  // ENV-119: Validate action plan payload BEFORE persisting the chat reply
  // to enforce the no-partial-write contract. If validation fails, return 400
  // without persisting anything. If validation passes, persist the chat reply
  // and the structured action plan atomically in the same transaction.
  let validatedActionPlan: ActionPlanInput | null = null;
  let actionPlanValidationErrors: ActionPlanValidationError[] | null = null;
  if (origin.channel === "chat" && actionPlanPayload) {
    const validated = validateActionPlanInput(actionPlanPayload);
    if ("errors" in validated) {
      actionPlanValidationErrors = validated.errors;
    } else {
      validatedActionPlan = validated;
    }
  }
  if (actionPlanValidationErrors) {
    return {
      status: 400,
      body: { error: "Invalid action plan", details: actionPlanValidationErrors },
    };
  }

  // Fetch task approvedOn state before the transaction (needed for action plan persistence decision)
  const taskForActionPlan = validatedActionPlan || (origin.channel === "chat" && !actionPlanPayload)
    ? await db.task.findUnique({
        where: { id: target.taskId },
        select: { approvedOn: true },
      })
    : null;

  const reply = await db.$transaction(async (tx) => {
    if (origin.channel === "comment") {
      const comment = await tx.comment.create({
        data: {
          taskId: target.taskId,
          userId: agentUser.id,
          body: persistedBody,
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
        agentSlug: original.agentSlug,
        archiveId: original.archiveId,
        baseArchiveId: original.baseArchiveId,
        senderUserId: agentUser.id,
        body: persistedBody,
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

    // ENV-119: Persist structured action plan inside the same transaction
    // for true atomicity. If plan persistence fails, the entire reply
    // (chat message + activity log + archive update) rolls back.
    if (validatedActionPlan && taskForActionPlan && !taskForActionPlan.approvedOn) {
      await persistActionPlan({
        taskId: target.taskId,
        input: validatedActionPlan,
        client: tx,
      });
    } else if (!actionPlanPayload && taskForActionPlan && !taskForActionPlan.approvedOn) {
      // Legacy Markdown fallback bridge — best-effort, don't fail the reply
      // if Markdown parsing finds nothing or errors.
      await persistActionPlanFromMarkdown({
        taskId: target.taskId,
        body: persistedBody,
        client: tx,
      }).catch(() => null);
    }

    return { id: created.id, channel: "chat" as const };
  });

  const reviewAutomation = reply.channel === "comment"
    ? await tryCompleteTaskFromReviewerComment({
        taskId: target.taskId,
        commentId: reply.id,
        body: persistedBody,
        agentUserId: agentUser.id,
        agentSlug: target.agentSlug,
      })
    : null;

  if (reply.channel === "chat") {
    const task = await db.task.findUnique({
      where: { id: target.taskId },
      select: {
        id: true,
        title: true,
        status: true,
        assigneeId: true,
        actingManagerId: true,
        reporterId: true,
        approvedOn: true,
        epic: { select: { status: true, actingManagerId: true } },
      },
    });
    const reviewerId = task ? resolveReviewOwnerId(task) : null;
    if (
      task &&
      !task.approvedOn &&
      task.assigneeId === agentUser.id &&
      (task.status === "Backlog" || task.status === "To Do") &&
      reviewerId &&
      reviewerId !== agentUser.id
    ) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: reviewerId,
        actor: { id: agentUser.id, kind: "agent", username: target.agentSlug },
        reason: "action_plan_review_requested",
        body: [
          `@${target.agentSlug} posted an Action Plan for "${task.title}".`,
          "Review the plan in Action Plan. If it is acceptable, call the workflow endpoint with action=approve_plan. If it needs changes, reply in Action Plan with concise feedback.",
        ].join("\n"),
      });
    }
  }

  if (reply.channel === "comment" && !reviewAutomation?.completed) {
