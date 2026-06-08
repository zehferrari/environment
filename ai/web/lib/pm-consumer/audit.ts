// HOMELAB-51 agent-action audit rows for consumer wakes.
//
// ActivityLog rows persist across pm_events truncation (HOMELAB-51
// acceptance: audit-survives-pm_events-truncation). We always write
// one row per consumer outcome — "delivered", "failed", "unmatched",
// "skipped" — so an operator can reconstruct who-was-woken-when even
// if PmEventDelivery is cleared for retention.

import { db } from "@/lib/db";
import type { PmEvent } from "@/lib/pm-events";

export interface AuditArgs {
  event: PmEvent;
  outcome: "delivered" | "failed" | "unmatched" | "skipped-duplicate";
  targetSlug: string | null;
  targetGatewayPort: number | null;
  error?: string;
  gatewayStatus?: number;
  dedupeKey: string;
}

function auditTaskId(event: PmEvent) {
  if (event.kind === "deployment.approved" && event.payload.scope === "epic") {
    return null;
  }
  return event.task.id;
}

async function resolveAuditRefs(event: PmEvent) {
  const taskId = auditTaskId(event);
  const [task, project, actor] = await Promise.all([
    taskId
      ? db.task.findUnique({
          where: { id: taskId },
          select: { id: true, projectId: true },
        })
      : null,
    db.project
      .findUnique({
        where: { slug: event.task.projectKey },
        select: { id: true },
      })
      .catch(() => null),
    db.user
      .findUnique({
        where: { id: event.actor.id },
        select: { id: true },
      })
      .catch(() => null),
  ]);

  return {
    projectId: task?.projectId ?? project?.id ?? null,
    taskId: task?.id ?? null,
    userId: actor?.id ?? null,
  };
}

export async function writeAuditRow(args: AuditArgs): Promise<void> {
  const payload = {
    eventId: args.event.id,
    kind: args.event.kind,
    outcome: args.outcome,
    dedupeKey: args.dedupeKey,
    targetGatewayPort: args.targetGatewayPort,
    gatewayStatus: args.gatewayStatus,
    error: args.error,
    actorId: args.event.actor.id,
  };
  const refs = await resolveAuditRefs(args.event);
  try {
    await db.activityLog.create({
      data: {
        projectId: refs.projectId,
        taskId: refs.taskId,
        userId: refs.userId,
        kind: `agent.wake.${args.outcome}`,
        payload: JSON.stringify(payload),
        targetAgent: args.targetSlug,
      },
    });
  } catch (err) {
    console.error("[pm-consumer] audit write failed:", err);
  }
}
