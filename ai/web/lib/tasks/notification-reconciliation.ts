import type { Prisma } from "@prisma/client";
import { obsoleteTaskNotificationReason } from "./notification-policy";

// Preserve the original failure record and annotate its resolution. Do not
// retry a notification whose stage/cycle has already passed.
export async function supersedeObsoleteTaskNotifications(tx: Prisma.TransactionClient, taskId: string) {
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, projectId: true, activeWorkflowCycleId: true } });
  const rows = await tx.workflowOutbox.findMany({
    where: { taskId, effectType: "task_notification", status: { in: ["queued", "failed"] } },
  });
  const now = new Date();
  let count = 0;
  const failures = rows.length ? await tx.activityLog.findMany({ where: { taskId, kind: "task.workflow.effect_failed" } }) : [];
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    if (!payload || typeof payload.reason !== "string") continue;
    const reason = obsoleteTaskNotificationReason(payload.reason, task.status, row.workflowCycleId, task.activeWorkflowCycleId);
    if (!reason) continue;
    const changed = await tx.workflowOutbox.updateMany({
      where: { id: row.id, status: row.status },
      data: { status: "superseded", completedAt: now, leaseOwner: null, leaseExpiresAt: null },
    });
    if (!changed.count) continue;
    count++;
    for (const failure of failures) {
      let details: Record<string, unknown>;
      try { details = JSON.parse(failure.payload ?? "null"); } catch { continue; }
      if (!details || details.outboxId !== row.id) continue;
      await tx.activityLog.update({ where: { id: failure.id }, data: {
        payload: JSON.stringify({ ...details, resolution: { status: "superseded", reason, at: now.toISOString() } }),
      } });
    }
    await tx.activityLog.create({ data: {
      taskId, projectId: task.projectId, kind: "task.workflow.notification_superseded",
      dedupeKey: `notification-superseded:${row.id}`,
      payload: JSON.stringify({ outboxId: row.id, reason, previousStatus: row.status }),
    } });
  }
  return count;
}

export async function settleDoneTaskExecution(tx: Prisma.TransactionClient, taskId: string, projectId: string, at = new Date()) {
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true } });
  if (task.status !== "Done") return;
  await tx.task.update({ where: { id: taskId }, data: { alertReporter: false } });
  const data = {
    projectId, state: "idle", reasonCode: "task_done", reasonDetail: "the task is Done; nothing is scheduled",
    lastDurableAction: "accept_review", lastDurableActionAt: at,
    recoveryAction: null, recoveryAt: null, detectorId: null, escalatedAt: null,
    breakerOpenUntil: null, recoveryCount: 0, recoveryWindowAt: null,
  };
  await tx.taskExecutionState.upsert({ where: { taskId }, create: { taskId, ...data }, update: data });
}
