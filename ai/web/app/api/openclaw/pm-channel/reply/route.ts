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
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
} from "@/lib/agents/workflow/notifications/task";
import {
  isPmTerminalFailureText,
  isSilentPmReplyText,
  isTransientPmProgressText,
} from "@/lib/agents/ops/pm-silence";
import { notifyHumanOfAgentReply } from "@/lib/push/notify-reply";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import { revalidateEpicReplyScope } from "@/lib/epics/cache";
import { tryCompleteTaskFromReviewerComment } from "@/lib/tasks/review-automation";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { isAuthorizedPmChannelCallbackTarget } from "@/lib/agents/pm-channel/target-authorization";
import { activeFormalBlockerTaskIds } from "@/lib/tasks/formal-blocker";

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
  return { status: 200, body: { ok: true, id: reply.id, channel: "direct" }, streamText: body };
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

async function taskWorkflowReasonForMessage(taskId: string, messageId: string) {
  const row = await db.activityLog.findFirst({
    where: {
      taskId,
      kind: { in: ["task.workflow.notify", "task.comment.dispatch"] },
      payload: { contains: `\"messageId\":\"${messageId}\"` },
    },
    orderBy: { createdAt: "desc" },
    select: { payload: true },
  });
  if (!row?.payload) return null;
  try {
    const payload = JSON.parse(row.payload) as {
      messageId?: unknown;
      reason?: unknown;
      workflowReason?: unknown;
    };
    if (payload.messageId !== messageId) return null;
    if (typeof payload.workflowReason === "string") return payload.workflowReason;
    return typeof payload.reason === "string" ? payload.reason : null;
  } catch {
    return null;
  }
}

const EXECUTION_CONTINUATION_REASONS = new Set([
  "todo_start_required",
  "review_feedback",
  "checkpoint_published",
  "monitor_recovery",
  "blocker_response",
]);
const AUTO_CONTINUATION_WINDOW_MS = 20 * 60 * 1_000;
const AUTO_CONTINUATION_LIMIT = 8;

/**
 * A visible progress comment is not a terminal outcome for an actionable
 * assignee recovery turn. Once the old run is durably settled, enqueue the
 * next turn in the same stable task session unless the agent actually reached
 * Review/finalization or raised a formal blocker. The bounded chain prevents a
 * pathological reply loop while removing the monitor's multi-minute dead air
 * between ordinary partial-progress turns.
 */
async function continueActionableTaskAfterReply(args: {
  target: Extract<PmChannelReplyTarget, { kind: "task-chat" | "task-comment" }>;
  replyId: string | null;
}) {
  try {
    let workflowReason = await taskWorkflowReasonForMessage(args.target.taskId, args.target.messageId);
    if (!workflowReason) {
      // Historical owner-comment dispatch rows predate workflowReason in their
      // payload. An originCommentId still proves this was a trusted directed
      // task-comment turn; In Progress assignee comments use monitor recovery.
      const source = await db.agentChatMessage.findUnique({
        where: { id: args.target.messageId },
        select: { originCommentId: true },
      });
      if (source?.originCommentId) workflowReason = "monitor_recovery";
    }
    if (!workflowReason || !EXECUTION_CONTINUATION_REASONS.has(workflowReason)) return;

    const task = await db.task.findUnique({
      where: { id: args.target.taskId },
      select: {
        id: true,
        title: true,
        status: true,
        projectId: true,
        assigneeId: true,
        alertReporter: true,
        deletedAt: true,
        repositoryRun: { select: { phase: true } },
      },
    });
    if (
      !task ||
      task.deletedAt ||
      task.status !== "In Progress" ||
      task.alertReporter ||
      !task.assigneeId ||
      task.repositoryRun && task.repositoryRun.phase !== "active"
    ) return;

    const agent = await db.agent.findUnique({
      where: { slug: args.target.agentSlug },
      select: { user: { select: { id: true } } },
    });
    if (!agent?.user || agent.user.id !== task.assigneeId) return;

    const lifecycleRows = await db.activityLog.findMany({
      where: {
        taskId: task.id,
        kind: { in: ["task.blocker", "task.extra_work.blocker", "task.blocker.cleared"] },
      },
      orderBy: { createdAt: "desc" },
      select: { taskId: true, kind: true },
    });
    if (activeFormalBlockerTaskIds(lifecycleRows).has(task.id)) return;

    const competingRun = await db.pmChannelRun.findFirst({
      where: {
        taskId: task.id,
        agentSlug: args.target.agentSlug,
        messageId: { not: args.target.messageId },
        status: { in: ["queued", "accepted", "streaming", "retryable"] },
      },
      select: { id: true },
    });
    if (competingRun) return;

    const windowStart = new Date(Date.now() - AUTO_CONTINUATION_WINDOW_MS);
    const recentContinuations = await db.activityLog.count({
      where: {
        taskId: task.id,
        kind: "task.workflow.auto_continue",
        targetAgent: args.target.agentSlug,
        createdAt: { gte: windowStart },
      },
    });
    if (recentContinuations >= AUTO_CONTINUATION_LIMIT) {
      const exhausted = await db.activityLog.findFirst({
        where: {
          taskId: task.id,
          kind: "task.workflow.auto_continue.exhausted",
          targetAgent: args.target.agentSlug,
          createdAt: { gte: windowStart },
        },
        select: { id: true },
      });
      if (!exhausted) {
        await db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: agent.user.id,
            kind: "task.workflow.auto_continue.exhausted",
            targetAgent: args.target.agentSlug,
            payload: JSON.stringify({
              sourceMessageId: args.target.messageId,
              sourceReplyId: args.replyId,
              limit: AUTO_CONTINUATION_LIMIT,
              windowMs: AUTO_CONTINUATION_WINDOW_MS,
            }),
          },
        });
      }
      return;
    }

    const continuation = await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor: { id: agent.user.id, kind: "agent", username: args.target.agentSlug },
      reason: "monitor_recovery",
      body: [
        `Your preceding execution turn for "${task.title}" ended with a progress response${args.replyId ? ` in comment ${args.replyId}` : ""}, but the task is still In Progress, unblocked, and repository execution remains active.`,
        "Continue the remaining implementation and live verification now in this same task session. Do not stop at another progress/status comment: keep working until ready_for_review succeeds or flag_blocker records one precise human/external dependency.",
      ].join("\n"),
    });
    if (!continuation) return;
    await db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: agent.user.id,
        kind: "task.workflow.auto_continue",
        targetAgent: args.target.agentSlug,
        payload: JSON.stringify({
          sourceMessageId: args.target.messageId,
          sourceReplyId: args.replyId,
          sourceReason: workflowReason,
          continuationMessageId: continuation.messageId,
          chainIndex: recentContinuations + 1,
        }),
      },
    });
  } catch (error) {
    console.error("[pm] execution auto-continuation failed", args.target.taskId, args.target.agentSlug, error);
  }
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

  revalidateTaskReplyScope(target.taskId, reply.channel);
  if (reviewAutomation?.completed) {
    revalidateTaskShell(target.taskId);
    for (const next of reviewAutomation.nextTasks ?? []) {
      revalidateTaskShell(next.id);
      revalidatePath(`/projects/${next.projectSlug}/tasks/${next.id}`);
    }
    revalidatePath(`/projects/${reviewAutomation.projectSlug}`);
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

async function persistEpicReply(
  target: Extract<PmChannelReplyTarget, { kind: "epic-chat" }>,
  body: string,
) {
  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      id: true,
      projectId: true,
      epicId: true,
      agentSlug: true,
      archiveId: true,
      baseArchiveId: true,
      originChannel: true,
      epic: { select: { deletedAt: true } },
    },
  });
  if (!original || original.epicId !== target.epicId || original.epic?.deletedAt) {
    return { status: 404, body: { error: "Message not found" } };
  }
  if (original.agentSlug !== "room" && original.agentSlug !== target.agentSlug) {
    return { status: 403, body: { error: "Agent mismatch" } };
  }

  const agentUser = await activeAgentUser(target.agentSlug);
  if (!agentUser) {
    return { status: 403, body: { error: "Agent not active" } };
  }
  const persistedBody = normalizeDiscussionReplySections(body);

  const reply = await db.$transaction(async (tx) => {
    const created = await tx.agentChatMessage.create({
      data: {
        projectId: original.projectId,
        taskId: null,
        epicId: target.epicId,
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
        userId: agentUser.id,
        kind: "epic.chat.reply",
        targetAgent: target.agentSlug,
        payload: JSON.stringify({
          driver: "openclaw-pm-channel",
          messageId: created.id,
          epicId: target.epicId,
          inReplyToMessageId: target.messageId,
          agentSlug: target.agentSlug,
        }),
      },
    });
    return { id: created.id, channel: "chat" as const };
  });

  revalidateEpicReplyScope(target.epicId, "chat");
  return {
    status: 200,
    body: { ok: true, id: reply.id, channel: reply.channel },
    streamText: persistedBody,
  };
}

async function persistSilentReply(target: PmChannelReplyTarget) {
  const agentUser = await activeAgentUser(target.agentSlug);
  if (!agentUser) {
    return { status: 403, body: { error: "Agent not active" } };
  }

  if (target.kind === "direct") {
    const original = await db.directAgentChatMessage.findUnique({
      where: { id: target.messageId },
      select: { id: true, agentSlug: true },
    });
    if (!original || original.agentSlug !== target.agentSlug) {
      return { status: 404, body: { error: "Message not found" } };
    }
    revalidatePath(`/agents/${target.agentSlug}/chat`);
    return { status: 200, body: { ok: true, silent: true, channel: "direct" } };
  }

  if (target.kind === "epic-chat") {
    const original = await db.agentChatMessage.findUnique({
      where: { id: target.messageId },
      select: {
        id: true,
        projectId: true,
        epicId: true,
        agentSlug: true,
        epic: { select: { deletedAt: true } },
      },
    });
    if (!original || original.epicId !== target.epicId || original.epic?.deletedAt) {
      return { status: 404, body: { error: "Message not found" } };
    }
    if (original.agentSlug !== "room" && original.agentSlug !== target.agentSlug) {
      return { status: 403, body: { error: "Agent mismatch" } };
    }
    revalidateEpicReplyScope(target.epicId, "chat");
    return { status: 200, body: { ok: true, silent: true, channel: "epic-chat" } };
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      id: true,
      projectId: true,
      taskId: true,
      agentSlug: true,
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

  revalidatePath(`/projects/${original.project.slug}/tasks/${target.taskId}`);
  return { status: 200, body: { ok: true, silent: true, channel: target.kind } };
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
  if (!authorizePmChannelCallback({
    presented: actualToken,
    expectedShared,
    expectedAgent,
  })) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (await pmChannelTargetIsCanceled(target)) {
    return NextResponse.json({ ok: true, canceled: true, ignored: true });
  }

  if (!(await isAuthorizedPmChannelCallbackTarget(target))) {
    return NextResponse.json({ error: "Reply target is not authorized" }, { status: 403 });
  }

  const rateLimit = checkPmChannelCallbackRateLimit({
    kind: "reply",
    agentSlug: target.agentSlug,
    targetKey: pmChannelRunTargetKey(target),
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "PM channel reply rate limit exceeded" },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  // OpenClaw emits this while it is still working. Persisting it as the
  // agent's durable reply used to complete the PM job before the subsequent
  // tool loop (or compaction recovery) had actually finished.
  if (isTransientPmProgressText(body)) {
    return NextResponse.json({ ok: true, transient: true });
  }

  // OpenClaw can deliver the same terminal auto-compaction failure through
  // both its legacy final-reply callback and the typed stream callback. The
  // reply callback used to win that race by persisting the failure notice as
  // a normal Comment/ChatMessage; the stream error then saw a "durable reply"
  // and incorrectly completed the run. Classify it before the durable-reply
  // gate, persist only an error frame, and drive the shared retry policy.
  if (isPmTerminalFailureText(body)) {
    const eventInput = { target, event: "error" as const, error: body };
    publishPmChannelStreamEvent(eventInput);
    await enqueuePmChannelStreamDurability(eventInput);
    await recordPmChannelRunEvent({ target, event: "error", error: body });
    const run = await db.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      select: { status: true },
    });
    return NextResponse.json({
      ok: true,
      terminalFailure: true,
      persisted: false,
      runStatus: run?.status ?? "failed",
    });
  }

  if (await pmChannelTargetHasDurableReply(target)) {
    publishPmChannelStreamEventDurably({ target, event: "done" }, async () => {
      await recordPmChannelRunEvent({ target, event: "done" });
      await markPmChannelJobCompleteForTarget(target);
    });
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const result = isSilentPmReplyText(body)
    ? await persistSilentReply(target)
    : target.kind === "direct"
    ? await persistDirectReply(target, body)
    : target.kind === "epic-chat"
    ? await persistEpicReply(target, body)
    : await persistTaskReply(target, body);

  if (result.status >= 200 && result.status < 300) {
    const executionContinuation = target.kind === "task-chat" || target.kind === "task-comment"
      ? {
          target,
          replyId: "id" in result.body && typeof result.body.id === "string" ? result.body.id : null,
        }
      : null;
    const eventInput = {
      target,
      event: "final",
      text: (result as { streamText?: string }).streamText ?? "",
      replace: true,
    } as const;
    publishPmChannelStreamEventDurably(eventInput, async () => {
      await recordPmChannelRunEvent({ target, event: "final" });
      await markPmChannelJobCompleteForTarget(target);
      if (executionContinuation) {
        await continueActionableTaskAfterReply(executionContinuation);
      }
    });
    // Closed-app delivery: push the reply to the human's devices so it lands
    // even with no PM tab open. Best-effort and no-op without VAPID config.
    // Silent replies (no-contribution / workflow acks) persist no visible
    // message, so skip the push — otherwise every silent agent fires a content-
    // less "New reply" notification that opens a chat with nothing new in it.
    if (eventInput.text.trim().length > 0) {
      void notifyHumanOfAgentReply(target, eventInput.text);
    }
  } else {
    const error = "error" in result.body && typeof result.body.error === "string"
      ? result.body.error
      : `Reply callback failed with HTTP ${result.status}`;
    publishPmChannelStreamEventDurably({
      target,
      event: "error",
      error,
    }, async () => {
      await recordPmChannelRunEvent({
        target,
        event: "error",
        error,
      });
    });
  }

  return NextResponse.json(result.body, { status: result.status });
}
