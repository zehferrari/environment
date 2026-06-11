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

export interface DeliveryTaskScopeFields {
  kind: string;
  taskId: string;
  taskKey: string;
  projectKey: string;
}

export function isTaskScopedDelivery(row: DeliveryTaskScopeFields): boolean {
  return row.kind !== "openclaw.pm_channel_turn"
    && row.taskId.trim() !== ""
    && row.taskKey.trim() !== ""
    && row.projectKey.trim() !== "";
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
  const existing = await db.pmEventDelivery.findUnique({
    where: { dedupeKey: args.dedupeKey },
    select: { id: true },
  });
  if (existing) return { status: "duplicate" };

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

// Dedupe guard for native `openclaw.pm_channel_turn` envelopes, which are not
// PmEvents (they carry no task) but share the same UNIQUE(dedupeKey) table.
// Without this, a retried bus publish — e.g. a publisher that timed out after
// the consumer had already received and run the line — re-delivers the same
// turn id and the agent runs the turn twice. Placeholder PmEvent columns are
// empty strings; they are plain audit/index fields here, not foreign keys. Any
// task/project delivery-log reporting should filter with isTaskScopedDelivery
// (or the equivalent kind + non-empty task/project predicate) before treating
// those fields as real PM task identifiers.
export async function appendPmChannelTurnDelivery(args: {
  dedupeKey: string;
  id: string;
  actorId: string;
  targetSlug: string | null;
  targetGatewayPort: number | null;
  envelope: unknown;
}): Promise<AppendResult> {
  const existing = await db.pmEventDelivery.findUnique({
    where: { dedupeKey: args.dedupeKey },
    select: { id: true },
  });
  if (existing) return { status: "duplicate" };

  try {
    const row = await db.pmEventDelivery.create({
      data: {
        dedupeKey: args.dedupeKey,
        eventId: args.id,
        kind: "openclaw.pm_channel_turn",
        taskId: "",
        taskKey: "",
        projectKey: "",
        actorId: args.actorId,
        targetAgentSlug: args.targetSlug,
        targetGatewayPort: args.targetGatewayPort,
        envelope: JSON.stringify(args.envelope),
      },
      select: { id: true },
    });
    return { status: "appended", deliveryId: row.id };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "duplicate" };
    throw err;
  }
}

// Drop a delivery slot so a genuinely failed dispatch can be retried instead of
// being suppressed as a duplicate. Only called for turns whose gateway dispatch
// failed (so the agent did not actually run).
export async function releaseDelivery(dedupeKey: string): Promise<void> {
  await db.pmEventDelivery.deleteMany({ where: { dedupeKey } });
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
