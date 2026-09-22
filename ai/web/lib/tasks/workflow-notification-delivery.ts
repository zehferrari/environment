import { db } from "@/lib/db";
import { canAccessTask, getViewerByUserId, isOwnerUserId } from "@/lib/auth/permissions";
import { resolveAgentTaskAccess } from "@/lib/agents/private-task-access";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { sendWebPushToUser } from "@/lib/push/web-push";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { writeDeduplicatedActivity } from "@/lib/tasks/orchestrator/activity-dedup";

import { obsoleteTaskNotificationReason, agentDeliveryOutcome, type NotificationOutcome } from "./notification-policy";

// Outbox delivery has different semantics from a direct agent wake: humans
// use PM activity + optional Web Push, and deliberate no-ops never retry.
export async function deliverTaskWorkflowNotification(
  args: Parameters<typeof sendTaskWorkflowNotification>[0] & { dedupeKey: string; workflowCycleId?: string | null },
): Promise<NotificationOutcome> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: { status: true, deletedAt: true, activeWorkflowCycleId: true, projectId: true, project: { select: { slug: true } } },
  });
  if (!task || task.deletedAt) return { status: "skipped", reason: "task_removed" };
  const obsolete = obsoleteTaskNotificationReason(args.reason, task.status, args.workflowCycleId, task.activeWorkflowCycleId);
  if (obsolete) return { status: "skipped", reason: obsolete };
  const target = await db.user.findUnique({
    where: { id: args.targetUserId },
    select: { kind: true, status: true, agent: { select: { deactivatedAt: true } } },
  });
  if (!target || target.status !== "active" || (target.kind === "agent" && (!target.agent || target.agent.deactivatedAt))) {
    return { status: "permanent_failure", error: "Notification recipient is missing or inactive." };
  }
  if (target.kind === "human") {
    const viewer = await getViewerByUserId(args.targetUserId);
    if (!viewer || !await canAccessTask(viewer, args.taskId)) {
      return { status: "permanent_failure", error: "Notification recipient no longer has task access." };
    }
    await writeDeduplicatedActivity({
      taskId: args.taskId, projectId: task.projectId, userId: args.actor.id,
      kind: "task.workflow.human_notification",
      dedupeKey: `human-notification:${args.dedupeKey}`,
      payload: { targetUserId: args.targetUserId, reason: args.reason, channel: "pm", outcome: "delivered" },
    });
    publishBoardTouch(task.projectId);
    // The durable PM activity is the delivery. Device push is best-effort,
    // uses a stable replacement tag and does not require a subscription.
    await sendWebPushToUser(args.targetUserId, {
      title: "Mission Control",
      body: "A task workflow update is available.",
      url: `/projects/${task.project.slug}/tasks/${args.taskId}`,
      tag: `workflow:${args.dedupeKey}`,
    }).catch(() => undefined);
    return { status: "delivered", channel: "human" };
  }
  if (args.actor.kind === "human" && !await isOwnerUserId(args.actor.id)) {
    return { status: "permanent_failure", error: "Agent wake requires an authorized owner or agent workflow actor." };
  }
  if (!(await resolveAgentTaskAccess({ taskId: args.taskId, agentUserId: args.targetUserId })).allowed) {
    return { status: "permanent_failure", error: "Agent notification recipient no longer has task access." };
  }
  const result = await sendTaskWorkflowNotification(args);
  if (!result) return { status: "skipped", reason: "agent_notification_not_applicable" };
  return agentDeliveryOutcome(result.delivery);
}
