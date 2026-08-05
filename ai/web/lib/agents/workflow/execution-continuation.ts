import { db } from "@/lib/db";
import type { PmChannelReplyTarget } from "@/lib/agents/pm-channel/openclaw";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import {
  activeFormalBlockerStatesByTask,
  formalBlockerNeedsExternalInput,
} from "@/lib/tasks/formal-blocker";
import { taskHasPmChannelContinuationForMessage } from "@/lib/agents/pm-channel/continuations";

export async function taskWorkflowReasonForMessage(taskId: string, messageId: string) {
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
 * A visible or silent progress response is not a terminal outcome for an
 * actionable assignee recovery turn. Once the old run is durably settled,
 * enqueue the next turn unless the agent reached Review/finalization or raised
 * a formal blocker that still needs external input. The bounded chain
 * prevents a pathological reply loop while removing monitor dead air.
 */
export async function continueActionableTaskAfterReply(args: {
  target: Extract<PmChannelReplyTarget, { kind: "task-chat" | "task-comment" }>;
  replyId: string | null;
}) {
  try {
    // ENV-118: the continuation outbox is the durable owner of "this episode
    // needs another turn". When a continuation-required workflow action armed
    // a row for this turn, the drain schedules the next turn — running this
    // heuristic as well would put two active runs in one lane (WFI-001).
    if (await taskHasPmChannelContinuationForMessage({
      taskId: args.target.taskId,
      agentSlug: args.target.agentSlug,
      messageId: args.target.messageId,
    })) return;

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
        deletedAt: true,
        repositoryRun: { select: { phase: true } },
      },
    });
    if (
      !task ||
      task.deletedAt ||
      task.status !== "In Progress" ||
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
        kind: {
          in: [
            "task.blocker",
            "task.extra_work.blocker",
            "task.blocker.cleared",
            "task.blocker.permission.granted",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      select: { taskId: true, kind: true, payload: true, createdAt: true },
    });
    const activeBlocker = activeFormalBlockerStatesByTask(lifecycleRows).get(task.id) ?? null;
    if (activeBlocker && formalBlockerNeedsExternalInput(activeBlocker)) return;

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
        `Your preceding execution turn for "${task.title}" ended with a progress response${args.replyId ? ` in comment ${args.replyId}` : ""}, but the task is still In Progress and repository execution remains active.`,
        activeBlocker?.permissionGrant?.authorizationCommentId
          ? `The active permission request is already granted and is agent-actionable now. Use authorization comment ${activeBlocker.permissionGrant.authorizationCommentId} for the exact authorized operation; do not wait for another human response or create a duplicate blocker.`
          : "No formal blocker is waiting on external input.",
        "Continue the remaining implementation and live verification now. Do not stop at another progress/status comment: keep working until ready_for_review succeeds or flag_blocker records one precise human/external dependency.",
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
