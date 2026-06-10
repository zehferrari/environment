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
import { handleDeploymentApproved } from "@/lib/deploy/monitor";
import { PM_CHANNEL_BUS_SCHEMA_VERSION } from "@/lib/agents/pm-channel-bus";
import {
  dispatchOpenClawPmChannelTurnViaHttp,
  parsePmChannelReplyTarget,
  type SendPmChannelTurnArgs,
} from "@/lib/agents/openclaw-pm-channel";
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
  pmChannelDispatch?: typeof dispatchOpenClawPmChannelTurnViaHttp;
}

export function createHandler(opts: HandlerOptions = {}) {
  const resolver = opts.resolver ?? createTargetResolver();
  const wake = opts.wake ?? wakeAgent;
  const pmChannelDispatch = opts.pmChannelDispatch ?? dispatchOpenClawPmChannelTurnViaHttp;

  async function handle(raw: unknown): Promise<HandleOutcome> {
    const pmChannelTurn = parsePmChannelBusTurn(raw);
    if (pmChannelTurn.ok) {
      const result = await pmChannelDispatch(pmChannelTurn.args);
      const dedupeKey = `openclaw.pm_channel_turn:${pmChannelTurn.id}`;
      if (!result.ok) {
        return {
          kind: "failed",
          dedupeKey,
          error: result.error ?? `PM channel ingress failed${result.status ? ` (${result.status})` : ""}`,
        };
      }
      return {
        kind: "delivered",
        dedupeKey,
        targetSlug: pmChannelTurn.args.agentSlug,
      };
    }
    if (pmChannelTurn.error) {
      return { kind: "rejected", error: pmChannelTurn.error };
    }

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

    if (event.kind === "deployment.approved") {
      const append = await appendDelivery({
        event,
        dedupeKey,
        targetSlug: "monitor",
        targetGatewayPort: null,
      });
      if (append.status === "duplicate") {
        await writeAuditRow({
          event,
          outcome: "skipped-duplicate",
          targetSlug: "monitor",
          targetGatewayPort: null,
          dedupeKey,
        });
        return { kind: "skipped-duplicate", dedupeKey };
      }
      const deliveryId = append.deliveryId!;
      try {
        await handleDeploymentApproved({
          scope: event.payload.scope,
          scopeId: event.payload.scopeId,
        });
        await markDelivered({ deliveryId, status: "delivered" });
        await writeAuditRow({
          event,
          outcome: "delivered",
          targetSlug: "monitor",
          targetGatewayPort: null,
          dedupeKey,
        });
        return { kind: "delivered", dedupeKey, targetSlug: "monitor" };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await markDelivered({ deliveryId, status: "failed", error });
        await writeAuditRow({
          event,
          outcome: "failed",
          targetSlug: "monitor",
          targetGatewayPort: null,
          error,
          dedupeKey,
        });
        return { kind: "failed", dedupeKey, error };
      }
    }

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
      sessionKey: event.kind === "task.agent_chat"
        ? event.payload.openclawSessionKey ?? null
        : null,
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

type ParsedPmChannelBusTurn =
  | { ok: true; id: string; args: SendPmChannelTurnArgs }
  | { ok: false; error?: string };

function parsePmChannelBusTurn(raw: unknown): ParsedPmChannelBusTurn {
  if (!raw || typeof raw !== "object") return { ok: false };
  const event = raw as Record<string, unknown>;
  if (event.kind !== "openclaw.pm_channel_turn") return { ok: false };
  if (event.schema !== PM_CHANNEL_BUS_SCHEMA_VERSION) {
    return { ok: false, error: "PM channel bus: unsupported schema" };
  }
  const id = typeof event.id === "string" && event.id.trim() ? event.id.trim() : "";
  if (!id) return { ok: false, error: "PM channel bus: missing id" };
  if (!event.payload || typeof event.payload !== "object") {
    return { ok: false, error: "PM channel bus: missing payload" };
  }
  const payload = event.payload as Record<string, unknown>;
  const agentSlug = typeof payload.agentSlug === "string" ? payload.agentSlug.trim() : "";
  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const kind = payload.kind;
  const gatewayPort = typeof payload.gatewayPort === "number" && Number.isFinite(payload.gatewayPort)
    ? payload.gatewayPort
    : null;
  const target = parsePmChannelReplyTarget(payload.replyTarget);
  const actorRaw = payload.actor && typeof payload.actor === "object"
    ? payload.actor as Record<string, unknown>
    : {};
  const actorKind = actorRaw.kind === "agent" ? "agent" : "human";
  const actorId = typeof actorRaw.id === "string" && actorRaw.id.trim()
    ? actorRaw.id.trim()
    : "pm-channel-bus";

  if (!agentSlug) return { ok: false, error: "PM channel bus: missing agentSlug" };
  if (!sessionKey) return { ok: false, error: "PM channel bus: missing sessionKey" };
  if (!target) return { ok: false, error: "PM channel bus: invalid replyTarget" };
  if (kind !== "direct" && kind !== "task-chat" && kind !== "task-comment" && kind !== "epic-chat") {
    return { ok: false, error: "PM channel bus: invalid turn kind" };
  }

  return {
    ok: true,
    id,
    args: {
      gatewayPort,
      agentSlug,
      sessionKey,
      kind,
      text,
      contextText: typeof payload.contextText === "string" ? payload.contextText : null,
      systemPrompt: typeof payload.systemPrompt === "string" ? payload.systemPrompt : null,
      actor: {
        id: actorId,
        username: typeof actorRaw.username === "string" ? actorRaw.username : null,
        kind: actorKind,
      },
      replyTarget: target,
      projectId: typeof payload.projectId === "string" ? payload.projectId : null,
      timeoutMs: typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
        ? payload.timeoutMs
        : undefined,
    },
  };
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
    case "deployment.approved":
      return `PM: deployment approved for ${taskKey} (${event.task.title})`;
    case "task.agent_chat": {
      const grant = event.payload.allowDescriptionEdit
        ? " [edit_grant]"
        : "";
      const lines = [
        `PM: chat for ${taskKey} (${event.task.title})${grant}`,
        event.payload.openclawSessionKey
          ? `OpenClaw session key: ${event.payload.openclawSessionKey}`
          : "OpenClaw session key: (not provided)",
        "",
        "SYSTEM INSTRUCTIONS:",
        event.payload.systemPrompt,
        "",
        "CALLBACK CONTRACT:",
        "A final reply inside this private OpenClaw session is not visible in PM.",
        "Use the callback endpoint(s) below to write visible PM results.",
        "",
        "USER MESSAGE AND TASK CONTEXT:",
        event.payload.userMessage,
      ];
      if (event.payload.chatReplyEndpoint) {
        lines.push(
          "",
          "Required visible reply: POST JSON to the origin-channel callback:",
          absoluteCallbackUrl(event.payload.chatReplyEndpoint.path),
          "",
          "Body shape:",
          JSON.stringify(event.payload.chatReplyEndpoint.bodyShape),
        );
      }
      if (event.payload.replyEndpoint) {
        lines.push(
          "",
          "Description edit grant: POST JSON to:",
          absoluteCallbackUrl(event.payload.replyEndpoint.path),
          "",
          "Body shape:",
          JSON.stringify(event.payload.replyEndpoint.bodyShape),
        );
      }
      return lines.join("\n");
    }
  }
}

export type ConsumerHandler = ReturnType<typeof createHandler>;

function callbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

function absoluteCallbackUrl(path: string) {
  return new URL(path, callbackBaseUrl()).toString();
}
