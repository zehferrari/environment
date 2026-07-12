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

export async function hasActiveOwnerOrigin(senderUserId: string): Promise<boolean> {
  return isOwnerUserId(senderUserId);
}
