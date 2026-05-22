// Consumer pipeline: validate → dedupe → resolve target → wake →
// audit. Each listener (socket / file-drop / http) calls handleEvent
// with a parsed JSON value; the handler never throws — outcomes are
// observable via the returned HandleOutcome and the audit row.
//
// HOMELAB-46 acceptance:
//   - typed envelope validation (parsePmEvent)
//   - UNIQUE(dedupe_key) replay test → exactly one wake
// HOMELAB-51 acceptance:
//   - one ActivityLog row per outcome; survives PmEventDelivery
//     truncation because the two tables are separate.

import { parsePmEvent, type PmEvent } from "@/lib/pm-events";
import { dedupeKeyFor } from "./dedupe-key";
import { createTargetResolver, type TargetResolver } from "./target";
import {
  appendDelivery,
  markDelivered,
} from "./delivery-log";
import { writeAuditRow } from "./audit";
import { wakeAgent } from "./gateway-client";

export type HandleOutcome =
  | { kind: "delivered"; dedupeKey: string; targetSlug: string }
  | { kind: "skipped-duplicate"; dedupeKey: string }
  | { kind: "unmatched"; dedupeKey: string }
  | { kind: "failed"; dedupeKey: string; error: string }
  | { kind: "rejected"; error: string };

export interface HandlerOptions {
  resolver?: TargetResolver;
  // Replay-test seam — defaults to live wakeAgent.
  wake?: typeof wakeAgent;
}

export function createHandler(opts: HandlerOptions = {}) {
  const resolver = opts.resolver ?? createTargetResolver();
  const wake = opts.wake ?? wakeAgent;

  async function handle(raw: unknown): Promise<HandleOutcome> {
    let event: PmEvent;
    try {
      event = parsePmEvent(raw);
    } catch (err) {
      return {
        kind: "rejected",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const dedupeKey = dedupeKeyFor(event);
    const target = await resolver.resolve(event);

    const append = await appendDelivery({
      event,
      dedupeKey,
      targetSlug: target?.slug ?? null,
      targetGatewayPort: target?.gatewayPort ?? null,
    });
    if (append.status === "duplicate") {
      await writeAuditRow({
        event,
        outcome: "skipped-duplicate",
        targetSlug: target?.slug ?? null,
        targetGatewayPort: target?.gatewayPort ?? null,
        dedupeKey,
      });
      return { kind: "skipped-duplicate", dedupeKey };
    }
    const deliveryId = append.deliveryId!;

    if (!target) {
      await markDelivered({ deliveryId, status: "unmatched" });
      await writeAuditRow({
        event,
        outcome: "unmatched",
        targetSlug: null,
        targetGatewayPort: null,
        dedupeKey,
      });
      return { kind: "unmatched", dedupeKey };
    }

    const wakeRes = await wake({
      gatewayPort: target.gatewayPort,
      slug: target.slug,
      text: wakeText(event),
      mode: "now",
    });
    if (!wakeRes.ok) {
      await markDelivered({
        deliveryId,
        status: "failed",
        error: wakeRes.error,
        gatewayStatus: wakeRes.status,
      });
      await writeAuditRow({
        event,
        outcome: "failed",
        targetSlug: target.slug,
        targetGatewayPort: target.gatewayPort,
        error: wakeRes.error,
        gatewayStatus: wakeRes.status,
        dedupeKey,
      });
      return { kind: "failed", dedupeKey, error: wakeRes.error ?? "unknown" };
    }

    await markDelivered({
      deliveryId,
      status: "delivered",
      gatewayStatus: wakeRes.status,
    });
    await writeAuditRow({
      event,
      outcome: "delivered",
      targetSlug: target.slug,
      targetGatewayPort: target.gatewayPort,
      gatewayStatus: wakeRes.status,
      dedupeKey,
    });
    return { kind: "delivered", dedupeKey, targetSlug: target.slug };
  }

  return { handle };
}

function wakeText(event: PmEvent): string {
  const taskKey = event.task.key || event.task.id;
  switch (event.kind) {
    case "task.assigned":
      return `PM: task ${taskKey} assigned to you (${event.task.title})`;
    case "task.mentioned":
      return `PM: you were mentioned on ${taskKey} (${event.task.title})`;
    case "task.commented":
      return `PM: new comment on ${taskKey} (${event.task.title})`;
    case "task.ack_ready":
      return `PM: ${taskKey} ready for ack (${event.task.title})`;
  }
}

export type ConsumerHandler = ReturnType<typeof createHandler>;
