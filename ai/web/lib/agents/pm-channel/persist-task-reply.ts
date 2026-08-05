// ENV-119: Extracted persistTaskReply service so tests can import and
// exercise the real production entry point without going through the
// Next.js route handler.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { PmChannelReplyTarget } from "@/lib/agents/pm-channel/openclaw";
import { pmChannelRunTargetKey } from "@/lib/agents/pm-channel/bus";
import { normalizeDiscussionReplySections } from "@/lib/agents/chat/discussion-reply-format";
import {
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
} from "@/lib/agents/workflow/notifications/task";
import { notifyHumanOfAgentReply } from "@/lib/push/notify-reply";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import { tryCompleteTaskFromReviewerComment } from "@/lib/tasks/review-automation";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import {
  taskWorkflowReasonForMessage,
} from "@/lib/agents/workflow/execution-continuation";
import {
  validateActionPlanInput,
  persistActionPlan,
  persistActionPlanFromMarkdown,
  type ActionPlanInput,
  type ActionPlanValidationError,
} from "@/lib/tasks/action-plan-store";

export async function activeAgentUser(agentSlug: string) {
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

  // ENV-122: Look up the active PmChannelRun to wire runId provenance.
  const runId = await db.pmChannelRun.findUnique({
    where: { targetKey: pmChannelRunTargetKey(target) },
    select: { id: true },
  }).then((r) => r?.id ?? null);

  const reply = await db.$transaction(async (tx) => {
    if (origin.channel === "comment") {
      const comment = await tx.comment.create({
        data: {
          taskId: target.taskId,
          userId: agentUser.id,
          body: persistedBody,
          authorAgentSlug: target.agentSlug,
          commentKind: "agent_reply",
          isGenerated: false,
          runId,
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
    await sendTaskCommentNotifications({
      taskId: target.taskId,
      commentId: reply.id,
      body: persistedBody,
      actor: {
        id: agentUser.id,
        kind: "agent",
        username: target.agentSlug,
      },
      excludeAgentSlugs: [target.agentSlug],
    });

    // A decision-owner response to a formal blocker is a trusted workflow
    // continuation, not an ordinary peer-authored mention. Close the loop
    // immediately by waking the visible assignee in the stable execution
    // session; otherwise the corrective comment is stored but the paused
    // assignee does not see it until a later monitor sweep.
    if (originWorkflowReason === "blocker") {
      const blockedTask = await db.task.findUnique({
        where: { id: target.taskId },
        select: { assigneeId: true },
      });
      if (blockedTask?.assigneeId && blockedTask.assigneeId !== agentUser.id) {
        await sendTaskWorkflowNotification({
          taskId: target.taskId,
          targetUserId: blockedTask.assigneeId,
          actor: { id: agentUser.id, kind: "agent", username: target.agentSlug },
          reason: "blocker_response",
          body: [
            `Decision owner @${target.agentSlug} responded to your active blocker in task comment ${reply.id}.`,
            "Read that response now. If it resolves the dependency, call action=clear_blocker with the evidence and resume implementation immediately; otherwise keep the blocker active and add only material new evidence.",
          ].join("\n"),
        });
      }
    }
  }

  // Cache revalidation may fail outside Next.js request context (e.g. standalone
  // test scripts). The database transaction has already committed at this point;
  // a cache miss is a stale-UI concern, not a data-integrity issue.
  try {
    revalidateTaskReplyScope(target.taskId, reply.channel);
    if (reviewAutomation?.completed) {
      revalidateTaskShell(target.taskId);
      for (const next of reviewAutomation.nextTasks ?? []) {
        revalidateTaskShell(next.id);
        revalidatePath(`/projects/${next.projectSlug}/tasks/${next.id}`);
      }
      revalidatePath(`/projects/${reviewAutomation.projectSlug}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/static generation store missing/i.test(message)) throw error;
  }
  return {
    status: 200,
    body: {
      ok: true,
      id: reply.id,
      channel: reply.channel,
      reviewAutomation,
    },
    streamText: persistedBody,
  };
}