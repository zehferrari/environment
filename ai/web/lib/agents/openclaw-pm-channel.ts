import { readFile } from "fs/promises";
import {
  recordPmChannelRunDispatch,
  recordPmChannelRunQueued,
} from "@/lib/agents/pm-channel-runs";

export type PmChannelReplyTarget =
  | {
      kind: "direct";
      agentSlug: string;
      messageId: string;
    }
  | {
      kind: "task-chat" | "task-comment";
      agentSlug: string;
      taskId: string;
      messageId: string;
      projectSlug?: string | null;
    }
  | {
      kind: "epic-chat";
      agentSlug: string;
      epicId: string;
      messageId: string;
      projectSlug?: string | null;
    };

export type PmChannelTurnKind = "direct" | "task-chat" | "task-comment" | "epic-chat";

export interface SendPmChannelTurnArgs {
  gatewayPort: number | null;
  agentSlug: string;
  sessionKey: string;
  kind: PmChannelTurnKind;
  text: string;
  contextText?: string | null;
  systemPrompt?: string | null;
  actor: {
    id: string;
    username?: string | null;
    kind: "human" | "agent";
  };
  replyTarget: PmChannelReplyTarget;
  projectId?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type PmChannelTransportMode = "http" | "inproc" | "uds";

export interface SendPmChannelTurnResult {
  ok: boolean;
  status?: number;
  error?: string;
  driver: "openclaw-pm-channel";
  transportMode?: PmChannelTransportMode;
}

export function buildPmTurnSessionKey(baseSessionKey: string, messageId: string): string {
  const base = baseSessionKey.trim();
  const safeMessageId = messageId.trim().replace(/[^A-Za-z0-9_.:-]/g, "_");
  return `${base}:turn:${safeMessageId}`;
}

export function parsePmChannelReplyTarget(value: unknown): PmChannelReplyTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  const kind = target.kind;
  const agentSlug = typeof target.agentSlug === "string" ? target.agentSlug : "";
  const messageId = typeof target.messageId === "string" ? target.messageId : "";
  if (!agentSlug || !messageId) return null;

  if (kind === "direct") {
    return { kind, agentSlug, messageId };
  }

  if (kind === "task-chat" || kind === "task-comment") {
    const taskId = typeof target.taskId === "string" ? target.taskId : "";
    if (!taskId) return null;
    return {
      kind,
      agentSlug,
      taskId,
      messageId,
      projectSlug: typeof target.projectSlug === "string" ? target.projectSlug : null,
    };
  }

  if (kind === "epic-chat") {
    const epicId = typeof target.epicId === "string" ? target.epicId : "";
    if (!epicId) return null;
    return {
      kind,
      agentSlug,
      epicId,
      messageId,
      projectSlug: typeof target.projectSlug === "string" ? target.projectSlug : null,
    };
  }

  return null;
}

const DEFAULT_TOKEN_FILE =
  process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE ??
  "/etc/openclaw/pm-channel-tokens.json";

let tokenCache: { at: number; tokens: Record<string, string> } | null = null;
const TOKEN_CACHE_MS = 10_000;

function envTokenKey(slug: string) {
  return `PM_OPENCLAW_CHANNEL_TOKEN_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

async function loadTokenMap(path: string): Promise<Record<string, string>> {
  const now = Date.now();
  if (tokenCache && now - tokenCache.at < TOKEN_CACHE_MS) {
    return tokenCache.tokens;
  }

  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    tokenCache = { at: now, tokens: parsed };
    return parsed;
  } catch {
    tokenCache = { at: now, tokens: {} };
    return {};
  }
}

export function __resetPmChannelTokenCacheForTests(): void {
  tokenCache = null;
}

export async function resolvePmChannelToken(agentSlug: string): Promise<string | null> {
  const perAgent = process.env[envTokenKey(agentSlug)];
  if (perAgent) return perAgent;

  const file = process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  const map = await loadTokenMap(file);
  if (map[agentSlug]) return map[agentSlug];

  const shared = process.env.PM_OPENCLAW_CHANNEL_TOKEN;
  if (shared) return shared;

  return map.default ?? null;
}

function channelPath() {
  return process.env.PM_OPENCLAW_CHANNEL_INGRESS_PATH ?? "/pm-channel/ingest";
}

function callbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

function defaultTimeoutMs() {
  const raw = Number(process.env.PM_OPENCLAW_CHANNEL_TIMEOUT_MS ?? 5000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5000;
}

export function resolvePmChannelTransportMode(): PmChannelTransportMode {
  const raw = (process.env.PM_PM_CHANNEL_TRANSPORT ?? process.env.PM_OPENCLAW_CHANNEL_TRANSPORT ?? "http")
    .trim()
    .toLowerCase();
  return raw === "inproc" || raw === "uds" ? raw : "http";
}

function pmChannelStreamUrl(transportMode: PmChannelTransportMode) {
  if (transportMode !== "http") return undefined;
  return new URL(
    "/api/openclaw/pm-channel/stream",
    callbackBaseUrl(),
  ).toString();
}

export function buildPmChannelIngressPayload(
  args: SendPmChannelTurnArgs,
  transportMode: PmChannelTransportMode = resolvePmChannelTransportMode(),
) {
  return {
    version: 1,
    kind: args.kind,
    agentSlug: args.agentSlug,
    sessionKey: args.sessionKey,
    text: args.text,
    contextText: args.contextText ?? null,
    systemPrompt: args.systemPrompt ?? null,
    actor: args.actor,
    replyTarget: args.replyTarget,
    callbackUrl: new URL(
      "/api/openclaw/pm-channel/reply",
      callbackBaseUrl(),
    ).toString(),
    streamTransport: transportMode,
    streamUrl: pmChannelStreamUrl(transportMode),
  };
}

export async function sendOpenClawPmChannelTurn(
  args: SendPmChannelTurnArgs,
): Promise<SendPmChannelTurnResult> {
  await recordPmChannelRunQueued({
    target: args.replyTarget,
    kind: args.kind,
    projectId: args.projectId ?? null,
    gatewayPort: args.gatewayPort,
    sessionKey: args.sessionKey,
  });
  return dispatchOpenClawPmChannelTurn(args);
}

export async function dispatchOpenClawPmChannelTurn(
  args: SendPmChannelTurnArgs,
): Promise<SendPmChannelTurnResult> {
  if (!args.gatewayPort) {
    const result: SendPmChannelTurnResult = {
      ok: false,
      driver: "openclaw-pm-channel",
      error: `agent "${args.agentSlug}" has no gateway port`,
    };
    await recordPmChannelRunDispatch({ target: args.replyTarget, result });
    return result;
  }

  const token = await resolvePmChannelToken(args.agentSlug);
  if (!token) {
    const result: SendPmChannelTurnResult = {
      ok: false,
      driver: "openclaw-pm-channel",
      error: `missing PM OpenClaw channel token for agent "${args.agentSlug}"`,
    };
    await recordPmChannelRunDispatch({ target: args.replyTarget, result });
    return result;
  }

  const url = new URL(channelPath(), `http://127.0.0.1:${args.gatewayPort}`);
  const transportMode = resolvePmChannelTransportMode();
  const timeoutMs = args.timeoutMs ?? defaultTimeoutMs();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const f = args.fetchImpl ?? fetch;

  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildPmChannelIngressPayload(args, transportMode)),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const result: SendPmChannelTurnResult = {
        ok: false,
        status: res.status,
        driver: "openclaw-pm-channel",
        transportMode: resolvePmChannelTransportMode(),
        error: body.trim() || `HTTP ${res.status}`,
      };
      await recordPmChannelRunDispatch({ target: args.replyTarget, result });
      return result;
    }

    const result: SendPmChannelTurnResult = {
      ok: true,
      status: res.status,
      driver: "openclaw-pm-channel",
      transportMode,
    };
    await recordPmChannelRunDispatch({ target: args.replyTarget, result });
    return result;
  } catch (err) {
    const result: SendPmChannelTurnResult = {
      ok: false,
      driver: "openclaw-pm-channel",
      transportMode,
      error: err instanceof Error ? err.message : String(err),
    };
    await recordPmChannelRunDispatch({ target: args.replyTarget, result });
    return result;
  } finally {
    clearTimeout(timer);
  }
}
