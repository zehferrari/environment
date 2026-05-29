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
  await db.activityLog.create({
    data: {
      taskId: args.event.task.id,
      userId: args.event.actor.id,
      kind: `agent.wake.${args.outcome}`,
      payload: JSON.stringify(payload),
      targetAgent: args.targetSlug,
    },
  });
}
