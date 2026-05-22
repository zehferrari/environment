// Idempotency log backed by the PmEventDelivery table.
//
// UNIQUE(dedupeKey) is the contract that makes the HOMELAB-46
// replay test deterministic: insert-once semantics mean the second
// fire of the same envelope hits a unique constraint violation and
// the handler shortcuts before any downstream wake is issued. We
// catch the unique-violation explicitly so a separate insert error
// (disk full, schema drift) still surfaces as a hard failure.

import { db } from "@/lib/db";
import type { PmEvent } from "@/lib/pm-events";

export interface AppendArgs {
  event: PmEvent;
  dedupeKey: string;
  targetSlug: string | null;
  targetGatewayPort: number | null;
}

export interface AppendResult {
  status: "appended" | "duplicate";
  deliveryId?: string;
}

const UNIQUE_VIOLATION_HINTS = [
  "Unique constraint failed",
  "UNIQUE constraint failed",
  "PrismaClientKnownRequestError",
];

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2002") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return UNIQUE_VIOLATION_HINTS.some((h) => msg.includes(h));
}

export async function appendDelivery(args: AppendArgs): Promise<AppendResult> {
  try {
    const row = await db.pmEventDelivery.create({
      data: {
        dedupeKey: args.dedupeKey,
        eventId: args.event.id,
        kind: args.event.kind,
        taskId: args.event.task.id,
        taskKey: args.event.task.key,
        projectKey: args.event.task.projectKey,
        actorId: args.event.actor.id,
        targetAgentSlug: args.targetSlug,
        targetGatewayPort: args.targetGatewayPort,
        envelope: JSON.stringify(args.event),
      },
      select: { id: true },
    });
    return { status: "appended", deliveryId: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "duplicate" };
    throw err;
  }
}

export async function markDelivered(args: {
  deliveryId: string;
  status: "delivered" | "failed" | "unmatched" | "skipped";
  error?: string;
  gatewayStatus?: number;
}): Promise<void> {
  await db.pmEventDelivery.update({
    where: { id: args.deliveryId },
    data: {
      deliveredAt: args.status === "delivered" ? new Date() : null,
      deliveryStatus: args.status,
      error: args.error ?? null,
      gatewayStatus: args.gatewayStatus ?? null,
    },
  });
}
