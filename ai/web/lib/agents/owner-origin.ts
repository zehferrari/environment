import { db } from "@/lib/db";
import { isOwnerUserId } from "@/lib/auth/permissions";

type Sender = {
  kind: string;
  status: string;
} | null | undefined;

/**
 * A human-originated grant remains valid only while its sender is the active
 * Mission Control owner. Agent workflow notifications are the narrow internal
 * exception for task callbacks and must have a matching durable audit row.
 */
export async function hasAuthorizedTaskAgentOrigin(args: {
  taskId: string;
  messageId: string;
  targetAgentSlug: string;
  senderUserId: string;
  sender: Sender;
}): Promise<boolean> {
  if (await isOwnerUserId(args.senderUserId)) return true;
  if (args.sender?.kind !== "agent" || args.sender.status !== "active") return false;

  const workflowNotification = await db.activityLog.findFirst({
    where: {
      taskId: args.taskId,
      userId: args.senderUserId,
      kind: "task.workflow.notify",
      targetAgent: args.targetAgentSlug,
      payload: { contains: args.messageId },
    },
    select: { id: true },
  });
  return Boolean(workflowNotification);
}

/**
 * Epic-side twin of hasAuthorizedTaskAgentOrigin: an epic workflow grant is
 * valid when its sender is the active owner, OR when it is a PM-generated
 * agent notification with a durable `epic.workflow.notify` audit row (the
 * monitor/engine waking the acting manager). Without this exception the
 * acting manager could only act after the human spoke in epic chat.
 */
export async function hasAuthorizedEpicAgentOrigin(args: {
  epicId: string;
  messageId: string;
  targetAgentSlug: string;
  senderUserId: string;
  sender: Sender;
}): Promise<boolean> {
  if (await isOwnerUserId(args.senderUserId)) return true;
  if (args.sender?.kind !== "agent" || args.sender.status !== "active") return false;

  const workflowNotification = await db.activityLog.findFirst({
    where: {
      userId: args.senderUserId,
      kind: "epic.workflow.notify",
      targetAgent: args.targetAgentSlug,
      payload: { contains: args.messageId },
    },
    select: { payload: true },
  });
  if (!workflowNotification?.payload) return false;
  try {
    const payload = JSON.parse(workflowNotification.payload) as { epicId?: unknown };
    return payload.epicId === args.epicId;
  } catch {
    return false;
  }
}

export async function hasActiveOwnerOrigin(senderUserId: string): Promise<boolean> {
  return isOwnerUserId(senderUserId);
}
