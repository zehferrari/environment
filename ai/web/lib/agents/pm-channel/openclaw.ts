import { readFile } from "fs/promises";
import {
  recordPmChannelRunDispatch,
  recordPmChannelRunQueued,
} from "@/lib/agents/pm-channel/runs";
import {
  pmChannelHttpFallbackEnabled,
  publishPmChannelTurnToBus,
} from "@/lib/agents/pm-channel/bus";

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

export interface PmChannelDispatchMetrics {
  surface: PmChannelTurnKind;
  sizes: {
    systemPromptChars: number;
    contextTextChars: number | null;
    textChars: number;
    transcriptMessageCount: number | null;
  };
}

export type PmChannelTransportMode = "http" | "inproc" | "uds";

export interface SendPmChannelTurnResult {
  ok: boolean;
  status?: number;
  error?: string;
  driver: "openclaw-pm-channel";
  transportMode?: PmChannelTransportMode;
  // ENV-122: LLM provenance captured from the OpenClaw gateway dispatch
  // response so comment metadata can copy provider/model from the run.
  provider?: string | null;
  model?: string | null;
  /** Exact gateway generation returned by /pm-channel/ingest. */
  gatewayDispatchId?: string | null;
}

export function buildPmTurnSessionKey(baseSessionKey: string, messageId: string): string {
  const base = baseSessionKey.trim();
  const safeMessageId = messageId.trim().replace(/[^A-Za-z0-9_.:-]/g, "_");
  return `${base}:turn:${safeMessageId}`;
}

export function buildPmChannelDispatchMetrics(
  args: SendPmChannelTurnArgs,
  transcriptMessageCount: number | null = null,
): PmChannelDispatchMetrics {
  return {
    surface: args.kind,
    sizes: {
      systemPromptChars: args.systemPrompt?.length ?? 0,
      contextTextChars: args.contextText == null ? null : args.contextText.length,
      textChars: args.text.length,
      transcriptMessageCount,
    },
  };
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

function pmChannelStreamSocketPath(transportMode: PmChannelTransportMode) {
  if (transportMode !== "uds") return undefined;
  return process.env.PM_PM_CHANNEL_STREAM_SOCKET
    ?? process.env.PM_OPENCLAW_CHANNEL_STREAM_SOCKET
    ?? process.env.PM_CHANNEL_STREAM_SOCKET
    ?? undefined;
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
    streamSocketPath: pmChannelStreamSocketPath(transportMode),
  };
}

export async function sendOpenClawPmChannelTurn(
  args: SendPmChannelTurnArgs,
): Promise<SendPmChannelTurnResult> {
  const run = await recordPmChannelRunQueued({
    target: args.replyTarget,
    kind: args.kind,
    projectId: args.projectId ?? null,
    gatewayPort: args.gatewayPort,
    sessionKey: args.sessionKey,
  });
  if (!run) {
    return { ok: false, driver: "openclaw-pm-channel", error: "failed to reserve PM execution lane" };
  }
  const { fenceSupersededPmChannelRuns } = await import("@/lib/agents/pm-channel/supersession");
  const fence = await fenceSupersededPmChannelRuns({
    replacementRunId: run.id,
    fetchImpl: args.fetchImpl,
  });
  if (!fence.ok) {
    const result: SendPmChannelTurnResult = {
      ok: false,
      driver: "openclaw-pm-channel",
      error: `replacement dispatch fenced: ${fence.error}`,
    };
    await recordPmChannelRunDispatch({ target: args.replyTarget, result });
    return result;
  }
  return dispatchOpenClawPmChannelTurn(args);
}

export async function dispatchOpenClawPmChannelTurn(
  args: SendPmChannelTurnArgs,
): Promise<SendPmChannelTurnResult> {
  const transportMode = resolvePmChannelTransportMode();
  const bus = await publishPmChannelTurnToBus(args);
  if (bus.ok) {
    const result: SendPmChannelTurnResult = {
      ok: true,
      status: bus.status ?? 202,
      driver: "openclaw-pm-channel",
      transportMode,
    };
    await recordPmChannelRunDispatch({ target: args.replyTarget, result });
    return result;
  }

  // Auto-fall back to the direct gateway when the bus is entirely unconfigured
  // (no PM_CHANNEL_BUS_* env at all — e.g. local dev, or a restart that lost the
  // bus env), so turns still deliver instead of hard-failing with "PM channel
  // bus disabled". A configured-but-failing bus only falls back when
  // PM_OPENCLAW_CHANNEL_HTTP_FALLBACK is set, to avoid double-delivery on a
  // transient bus error where the consumer may already have received the line.
  const busUnconfigured = bus.skipped === "disabled";
  if (!busUnconfigured && !pmChannelHttpFallbackEnabled()) {
    const result: SendPmChannelTurnResult = {
      ok: false,
      status: bus.status,
      driver: "openclaw-pm-channel",
      transportMode,
      error: bus.error ?? "PM channel bus publish failed",
    };
    await recordPmChannelRunDispatch({ target: args.replyTarget, result });
    return result;
  }

  return dispatchOpenClawPmChannelTurnViaHttp(args);
}

export async function dispatchOpenClawPmChannelTurnViaHttp(
  args: SendPmChannelTurnArgs,
): Promise<SendPmChannelTurnResult> {
  if (!args.gatewayPort) {
    const result: SendPmChannelTurnResult = {
      ok: false,
      driver: "openclaw-pm-channel",
      transportMode: resolvePmChannelTransportMode(),
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
      transportMode: resolvePmChannelTransportMode(),
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
        transportMode,
        error: body.trim() || `HTTP ${res.status}`,
      };
      await recordPmChannelRunDispatch({ target: args.replyTarget, result });
      return result;
    }

    // ENV-122: Parse provider/model from the OpenClaw gateway dispatch
    // response so they can be persisted on the PmChannelRun and copied
    // into comment metadata at all comment creation sites.
    let provider: string | null = null;
    let model: string | null = null;
    let gatewayDispatchId: string | null = null;
    try {
      const body = await res.json().catch(() => null);
      provider = typeof body?.provider === "string" ? body.provider : null;
      model = typeof body?.model === "string" ? body.model : null;
      gatewayDispatchId = typeof body?.id === "string" ? body.id : null;
    } catch {
      // Non-JSON response — leave provider/model null.
    }
    const result: SendPmChannelTurnResult = {
      ok: true,
      status: res.status,
      driver: "openclaw-pm-channel",
      transportMode,
      provider,
      model,
      gatewayDispatchId,
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
