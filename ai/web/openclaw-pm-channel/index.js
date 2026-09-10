import { resolvePmTurnEffort, withPmHighDefault } from "./turn-effort.js";
import { createPmTaskTelemetry } from "./task-telemetry.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  defineChannelPluginEntry,
} from "openclaw/plugin-sdk/channel-core";
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-message";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { resolvePmInboundRuntime } from "./runtime-compat.js";
import { canonicalizePmStoreSessionKey } from "./session-key.js";

import { createTaskTools, PM_TASK_TOOL_NAMES, taskToolCapabilities, validateTaskRuntime } from "./task-tools.js";

const CHANNEL_ID = "pm";
const DEFAULT_ACCOUNT_ID = "default";
const DEFAULT_CALLBACK_URL = "http://127.0.0.1:3000/api/openclaw/pm-channel/reply";

const pmChannelConfigJsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    enabled: { type: "boolean" },
    token: { type: "string" },
    callbackToken: { type: "string" },
    callbackUrl: { type: "string" },
    agentId: { type: "string" },
    defaultTo: { type: "string" },
    defaultAccount: { type: "string" },
    accounts: { type: "object" },
  },
};

const pmChannelConfigSchema = buildJsonChannelConfigSchema(pmChannelConfigJsonSchema, {
  cacheKey: "mission-control-pm-channel",
  uiHints: {
    token: { label: "Ingress token", sensitive: true },
    callbackToken: { label: "PM callback token", sensitive: true },
    callbackUrl: { label: "PM callback URL" },
    agentId: { label: "OpenClaw agent id" },
  },
});

const { setRuntime: setPmRuntime, getRuntime: getPmRuntime } = createPluginRuntimeStore({
  pluginId: CHANNEL_ID,
  errorMessage: "PM channel runtime not initialized",
});

const activeTurns = new Map();

function normalizeAccountId(accountId) {
  const value = typeof accountId === "string" && accountId.trim()
    ? accountId.trim()
    : DEFAULT_ACCOUNT_ID;
  return value;
}

function resolveSecret(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("env:")) {
    return process.env[trimmed.slice(4)] ?? "";
  }
  if (trimmed.startsWith("file:")) {
    try {
      return readFileSync(trimmed.slice(5), "utf8").trim();
    } catch {
      return "";
    }
  }
  return trimmed;
}

function resolvePmAccount({ cfg, accountId }) {
  const root = cfg.channels?.pm ?? {};
  const id = normalizeAccountId(accountId ?? root.defaultAccount);
  const accountConfig = id === DEFAULT_ACCOUNT_ID ? {} : root.accounts?.[id] ?? {};
  const merged = { ...root, ...accountConfig };
  const token = resolveSecret(merged.token ?? process.env.PM_OPENCLAW_CHANNEL_TOKEN ?? "");
  const callbackToken = resolveSecret(
    merged.callbackToken ?? merged.token ?? process.env.PM_OPENCLAW_CHANNEL_TOKEN ?? "",
  );
  const callbackUrl = typeof merged.callbackUrl === "string" && merged.callbackUrl.trim()
    ? merged.callbackUrl.trim()
    : DEFAULT_CALLBACK_URL;

  return {
    accountId: id,
    enabled: root.enabled !== false && merged.enabled !== false,
    configured: Boolean(token && callbackToken && callbackUrl),
    token,
    callbackToken,
    callbackUrl,
    agentId: typeof merged.agentId === "string" && merged.agentId.trim()
      ? merged.agentId.trim()
      : "main",
    defaultTo: typeof merged.defaultTo === "string" && merged.defaultTo.trim()
      ? merged.defaultTo.trim()
      : "pm:direct",
  };
}

function listPmAccountIds(cfg) {
  const root = cfg.channels?.pm ?? {};
  const ids = new Set([DEFAULT_ACCOUNT_ID]);
  for (const key of Object.keys(root.accounts ?? {})) ids.add(normalizeAccountId(key));
  return [...ids];
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function encodeTarget(target) {
  return `pm:${Buffer.from(JSON.stringify(target), "utf8").toString("base64url")}`;
}

function decodeTarget(raw) {
  const value = String(raw ?? "").trim();
  if (!value.startsWith("pm:")) throw new Error(`Invalid PM target: ${value}`);
  const parsed = safeJsonParse(Buffer.from(value.slice(3), "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid PM target payload");
  return parsed;
}

function createReceipt(messageId, threadId, replyToId) {
  return createMessageReceiptFromOutboundResults({
    results: [{ channel: CHANNEL_ID, messageId }],
    kind: "text",
    threadId,
    replyToId,
  });
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  const parsed = text ? safeJsonParse(text) : null;
  if (!res.ok) {
    throw new Error(parsed?.error || text || `HTTP ${res.status}`);
  }
  return parsed ?? {};
}

function resolveStreamUrl(target) {
  return typeof target.streamUrl === "string" && target.streamUrl.trim()
    ? target.streamUrl.trim()
    : "";
}

function streamPayloadText(payload) {
  return payload && typeof payload === "object" && typeof payload.text === "string"
    ? payload.text
    : "";
}

function streamPayloadDelta(payload) {
  return payload && typeof payload === "object" && typeof payload.delta === "string"
    ? payload.delta
    : "";
}

function sendJsonLineToUnixSocket(path, body) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const line = `${JSON.stringify(body)}\n`;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(5000);
    socket.once("connect", () => socket.end(line));
    socket.once("error", finish);
    socket.once("timeout", () => finish(new Error("PM channel stream UDS timeout")));
    socket.once("close", (hadError) => {
      if (!hadError) finish();
    });
  });
}

function createPmStreamPublisher({ account, target, logger, gatewayDispatchId }) {
  const streamUrl = resolveStreamUrl(target);
  const streamTransport = typeof target.streamTransport === "string" ? target.streamTransport : "http";
  const streamSocketPath = typeof target.streamSocketPath === "string" && target.streamSocketPath.trim()
    ? target.streamSocketPath.trim()
    : "";
  const inprocCallback = typeof globalThis.__missionControlPmChannelStreamCallback === "function"
    ? globalThis.__missionControlPmChannelStreamCallback
    : null;
  if (!streamUrl && !(streamTransport === "uds" && streamSocketPath) && !(streamTransport === "inproc" && inprocCallback)) {
    if (streamTransport !== "http") {
      logger.warn?.(`[pm-channel] ${streamTransport} stream transport unavailable; stream updates disabled`);
    }
    return {
      partial: () => {},
      reasoning: () => {},
      modelSelected: () => {},
      agentMeta: () => null,
      toolStart: async () => {},
      final: async () => {},
      done: async () => {},
      error: async () => {},
      dispatchDelivered: async () => {},
      turnWaitingCapacity: async () => {},
      turnAdmitted: async () => {},
      contextUsage: async () => {},
      turnTerminal: async () => {},
    };
  }

  let queued = null;
  let timer = null;
  let chain = Promise.resolve();
  let lastReasoningText = "";
  let selectedAgentMeta = null;
  const observedToolCalls = new Set();
  let anonymousToolCallNo = 0;
  let modelSelectedEmitted = false;

  const post = (body) => {
    const payload = {
      version: 1,
      channel: CHANNEL_ID,
      target,
      transportMode: streamTransport,
      ...(gatewayDispatchId ? { gatewayDispatchId } : {}),
      ...(selectedAgentMeta ? { meta: { agentMeta: selectedAgentMeta } } : {}),
      ...body,
    };
    if (streamTransport === "inproc" && inprocCallback) {
      return inprocCallback(payload);
    }
    if (streamTransport === "uds" && streamSocketPath) {
      return sendJsonLineToUnixSocket(streamSocketPath, payload);
    }
    return postJson(streamUrl, account.callbackToken, payload);
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const body = queued;
      queued = null;
      if (!body) return;
      chain = chain
        .then(() => post(body))
        .catch((err) => logger.warn?.(`[pm-channel] stream event failed: ${String(err)}`));
    }, 80);
  };

  const queue = (body) => {
    if ((body.event === "partial" || body.event === "reasoning") &&
        queued?.event === body.event &&
        !body.replace && !queued.replace) {
      queued = {
        ...body,
        delta: `${queued.delta ?? ""}${body.delta ?? ""}`,
        text: body.text ?? queued.text,
      };
    } else {
      queued = body;
    }
    schedule();
  };

  const drainQueued = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const body = queued;
    queued = null;
    if (body) {
      chain = chain
        .then(() => post(body))
        .catch((err) => logger.warn?.(`[pm-channel] stream event failed: ${String(err)}`));
    }
  };

  const flush = async () => {
    drainQueued();
    await chain;
  };

  return {
    modelSelected: (selection) => {
      if (!selection || typeof selection !== "object") return;
      const provider = typeof selection.provider === "string" ? selection.provider.trim() : "";
      const model = typeof selection.model === "string" ? selection.model.trim() : "";
      if (!provider && !model) return;
      selectedAgentMeta = {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(typeof selection.thinkLevel === "string" ? { thinkLevel: selection.thinkLevel } : {}),
      };
      // ENV-159: Emit canonical model:selected event exactly once.
      if (!modelSelectedEmitted) {
        modelSelectedEmitted = true;
        // Move any coalesced text onto the existing chain before appending the
        // model event. Calling flush() from inside chain.then() deadlocks: the
        // flush awaits the same promise whose callback is currently running,
        // preventing every later tool/stream event from reaching PM.
        drainQueued();
        chain = chain
          .then(() => post({
            event: "model:selected",
            provider,
            model,
            ...(typeof selection.thinkLevel === "string" ? { thinkLevel: selection.thinkLevel } : {}),
            ...(selection.fallback ? { fallback: true } : {}),
          }))
          .catch((err) => logger.warn?.(`[pm-channel] model:selected event failed: ${String(err)}`));
      }
    },
    agentMeta: () => selectedAgentMeta,
    toolStart: async (payload) => {
      if (!payload || typeof payload !== "object") return;
      const phase = typeof payload.phase === "string" ? payload.phase : "start";
      if (phase !== "start" && phase !== "update") return;
      const stableId = typeof payload.toolCallId === "string" && payload.toolCallId
        ? `call:${payload.toolCallId}`
        : typeof payload.itemId === "string" && payload.itemId
          ? `item:${payload.itemId}`
          : phase === "start"
            ? `anonymous:${++anonymousToolCallNo}`
            : null;
      if (!stableId || observedToolCalls.has(stableId)) return;
      observedToolCalls.add(stableId);

      // Preserve event order: reasoning emitted before the tool call must land
      // before the tool boundary that PM uses for episode accounting.
      await flush();
      // ENV-159: Emit canonical tool:start with toolCallId for all backends.
      await post({
        event: "tool:start",
        toolStatus: "start",
        toolName: typeof payload.name === "string" && payload.name.trim()
          ? payload.name.trim()
          : "tool",
        toolCallId: typeof payload.toolCallId === "string" ? payload.toolCallId : undefined,
        ...(selectedAgentMeta?.provider ? { provider: selectedAgentMeta.provider } : {}),
        ...(selectedAgentMeta?.model ? { model: selectedAgentMeta.model } : {}),
      });
    },
    partial: (payload) => {
      const delta = streamPayloadDelta(payload);
      const text = streamPayloadText(payload);
      if (!delta && !text) return;
      queue({
        event: "partial",
        delta: delta || undefined,
        text: delta ? undefined : text,
        replace: payload?.replace === true || (!delta && Boolean(text)),
      });
    },
    reasoning: (payload) => {
      const deltaVal = streamPayloadDelta(payload);
      const textVal = streamPayloadText(payload);
      if (!deltaVal && !textVal) return;

      let delta = "";
      if (deltaVal) {
        delta = deltaVal;
        lastReasoningText = lastReasoningText + deltaVal;
      } else {
        if (textVal.startsWith(lastReasoningText)) {
          delta = textVal.slice(lastReasoningText.length);
          lastReasoningText = textVal;
        } else {
          delta = textVal;
          lastReasoningText = lastReasoningText + textVal;
        }
      }

      if (!delta) return;

      queue({
        event: "reasoning",
        delta: delta,
        text: undefined,
        replace: false,
      });
    },
    final: async (text) => {
      await flush();
      if (text) await post({ event: "final", text, replace: true });
    },
    done: async () => {
      await flush();
      // ENV-159: Emit canonical turn:terminal before legacy done.
      await post({ event: "turn:terminal" });
      await post({ event: "done" });
    },
    error: async (err) => {
      await flush();
      await post({ event: "error", error: err instanceof Error ? err.message : String(err) });
    },
    // ENV-159 canonical lifecycle events
    dispatchDelivered: async () => {
      await post({ event: "dispatch:delivered" });
    },
    turnWaitingCapacity: async (info) => {
      await post({
        event: "turn:waiting_capacity",
        ...(info && typeof info === "object" ? {
          blockedByRunId: info.blockedByRunId,
          blockedByTaskId: info.blockedByTaskId,
        } : {}),
      });
    },
    turnAdmitted: async () => {
      await post({ event: "turn:admitted" });
    },
    contextUsage: async (usage) => {
      if (!usage || typeof usage !== "object") return;
      await post({ event: "context:usage", usage });
    },
    turnTerminal: async () => {
      await post({ event: "turn:terminal" });
    },
  };
}

async function sendPmText({ cfg, accountId, to, text, replyToId, threadId, agentMeta }) {
  const target = decodeTarget(to);
  const account = resolvePmAccount({ cfg, accountId });
  const callbackUrl = typeof target.callbackUrl === "string" && target.callbackUrl.trim()
    ? target.callbackUrl.trim()
    : account.callbackUrl;
  const response = await postJson(callbackUrl, account.callbackToken, {
    version: 1,
    channel: CHANNEL_ID,
    target,
    text,
    ...(agentMeta ? { meta: { agentMeta } } : {}),
    receipt: {
      replyToId: replyToId ?? null,
      threadId: threadId ?? null,
    },
  });
  return {
    to,
    messageId: typeof response.id === "string" ? response.id : randomUUID(),
  };
}

const pmMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const result = await sendPmText({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        replyToId: ctx.replyToId,
        threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
      });
      const replyToId = ctx.replyToId ?? undefined;
      const threadId = ctx.threadId == null ? undefined : String(ctx.threadId);
      return {
        messageId: result.messageId,
        receipt: createReceipt(result.messageId, threadId, replyToId),
      };
    },
  },
});

function payloadText(payload) {
  if (payload && typeof payload === "object" && typeof payload.text === "string") {
    return payload.text.trim();
  }
  return "";
}

function actorLabel(actor) {
  const username = typeof actor?.username === "string" && actor.username.trim()
    ? `@${actor.username.trim()}`
    : "PM user";
  return actor?.kind === "agent" ? `${username} (agent)` : username;
}

function buildAgentBody(payload) {
  const hasContext = typeof payload.contextText === "string" && payload.contextText.trim();
  return [
    typeof payload.systemPrompt === "string" && payload.systemPrompt.trim()
      ? payload.systemPrompt.trim()
      : "Reply to this PM message.",
    "",
    hasContext
      ? "The live PM context packet is attached to this turn as supplemental context."
      : "",
    "",
    "CURRENT MESSAGE:",
    typeof payload.text === "string" ? payload.text : "",
  ].filter((part) => part !== "").join("\n");
}

function targetConversationId(target) {
  if (target.kind === "direct") return `direct:${target.agentSlug}`;
  if (target.kind === "task-chat" || target.kind === "task-comment") return `task:${target.taskId}`;
  if (target.kind === "epic-chat") return `epic:${target.epicId}`;
  return "pm";
}

function targetConversationLabel(target) {
  if (target.kind === "direct") return `PM direct chat with @${target.agentSlug}`;
  if (target.kind === "task-comment") return `PM task comment ${target.taskId}`;
  if (target.kind === "task-chat") return `PM task chat ${target.taskId}`;
  if (target.kind === "epic-chat") return `PM epic chat ${target.epicId}`;
  return "PM";
}

function isDirectTarget(target) {
  return target.kind === "direct";
}

function normalizeInboundPayload(payload) {
  if (!payload || typeof payload !== "object") throw new Error("JSON object required");
  if (payload.version !== 1) throw new Error("Unsupported PM channel payload version");
  if (typeof payload.agentSlug !== "string" || !payload.agentSlug.trim()) {
    throw new Error("agentSlug is required");
  }
  if (typeof payload.sessionKey !== "string" || !payload.sessionKey.trim()) {
    throw new Error("sessionKey is required");
  }
  if (typeof payload.text !== "string" || !payload.text.trim()) {
    throw new Error("text is required");
  }
  if (!payload.replyTarget || typeof payload.replyTarget !== "object") {
    throw new Error("replyTarget is required");
  }
  return payload;
}

function authHeader(req) {
  const raw = req.headers.authorization ?? "";
  return raw.startsWith("Bearer ") ? raw.slice("Bearer ".length).trim() : "";
}

function tokensEqual(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(text));
  res.end(text);
}

async function runPmTurn({ cfg, payload, accountId, logger, acceptedId }) {
  const runtime = getPmRuntime();
  const inbound = resolvePmInboundRuntime(runtime);
  const account = resolvePmAccount({ cfg, accountId });
  if (!account.enabled || !account.configured) {
    throw new Error(`PM channel account "${account.accountId}" is not configured`);
  }

  const target = {
    ...payload.replyTarget,
    callbackUrl: typeof payload.callbackUrl === "string" ? payload.callbackUrl : account.callbackUrl,
    streamUrl: typeof payload.streamUrl === "string" ? payload.streamUrl : undefined,
    streamTransport: typeof payload.streamTransport === "string" ? payload.streamTransport : "http",
    streamSocketPath: typeof payload.streamSocketPath === "string" ? payload.streamSocketPath : undefined,
  };
  const encodedTarget = encodeTarget(target);
  const agentId = account.agentId;
  // Correlation id used to abort the active turn (the cancel endpoint looks
  // this up by the raw key the web app sends).
  const rawSessionKey = payload.sessionKey.trim();
  // Canonical agent-scoped key for session persistence, routing, and dispatch
  // so PM sessions land under `agent:<agentId>:pm:*`.
  const sessionKey = canonicalizePmStoreSessionKey({ agentId, requestKey: rawSessionKey });
  const registeredTurn = activeTurns.get(rawSessionKey);
  if (!registeredTurn || registeredTurn.acceptedId !== acceptedId) {
    // Another ingress generation displaced this callback before it even
    // finished assembling context. Never let an orphaned setImmediate launch
    // a model behind the replacement run's cancellation fence.
    logger.warn?.("[pm-channel] discarded displaced turn before context assembly");
    return;
  }
  // The PM run stores/sends the raw correlation key, while OpenClaw indexes
  // the embedded run by this canonical agent-scoped key. Cancellation must
  // retain both identities or it can acknowledge a no-op abort while the
  // superseded model keeps running.
  registeredTurn.canonicalSessionKey = sessionKey;
  registeredTurn.replyTarget = payload.replyTarget;
  registeredTurn.taskRuntime = validateTaskRuntime(payload.taskRuntime, payload.replyTarget);
  if (payload.taskRuntime && !registeredTurn.taskRuntime) throw new Error("Invalid PM task tool runtime");
  const messageId = typeof payload.messageId === "string" && payload.messageId
    ? payload.messageId
    : payload.replyTarget.messageId ?? randomUUID();
  const isDirect = isDirectTarget(target);
  const conversationId = targetConversationId(target);
  const conversationLabel = targetConversationLabel(target);
  const fromLabel = actorLabel(payload.actor);
  const bodyForAgent = buildAgentBody(payload);
  const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId });
  const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey,
  });
  const body = runtime.channel.reply.formatAgentEnvelope({
    channel: "PM",
    from: fromLabel,
    timestamp: new Date(),
    previousTimestamp,
    envelope: runtime.channel.reply.resolveEnvelopeFormatOptions(cfg),
    body: bodyForAgent,
  });
  const stream = createPmStreamPublisher({ account, target, logger, gatewayDispatchId: acceptedId });
  registeredTurn.stream = stream;
  let visibleReplySent = false;

  const ctxPayload = await inbound.buildContext({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    messageId,
    messageIdFull: messageId,
    timestamp: Date.now(),
    from: `pm:${fromLabel}`,
    sender: {
      id: typeof payload.actor?.id === "string" ? payload.actor.id : fromLabel,
      name: fromLabel,
      username: typeof payload.actor?.username === "string" ? payload.actor.username : undefined,
      displayLabel: fromLabel,
    },
    conversation: {
      kind: isDirect ? "direct" : "group",
      id: conversationId,
      label: conversationLabel,
      routePeer: {
        kind: isDirect ? "direct" : "group",
        id: conversationId,
      },
    },
    route: {
      agentId,
      accountId: account.accountId,
      routeSessionKey: sessionKey,
      createIfMissing: true,
    },
    reply: {
      to: encodedTarget,
      originatingTo: encodedTarget,
      replyToId: messageId,
      replyToIdFull: messageId,
    },
    message: {
      body,
      bodyForAgent,
      rawBody: payload.text,
      commandBody: payload.text,
      envelopeFrom: fromLabel,
    },
    supplemental: {
      untrustedContext: typeof payload.contextText === "string" && payload.contextText.trim()
        ? [{
            label: "PM context packet",
            source: "mission-control-pm",
            type: payload.kind,
            payload: payload.contextText,
          }]
        : undefined,
    },
    extra: {
      ChatType: isDirect ? "direct" : "group",
      ConversationLabel: conversationLabel,
      Provider: CHANNEL_ID,
      Surface: CHANNEL_ID,
      OriginatingChannel: CHANNEL_ID,
      OriginatingTo: encodedTarget,
      CommandAuthorized: true,
      WasMentioned: true,
    },
  });

  // A replacement can fence this turn after ingress accepts it but before the
  // embedded runner is registered. Honour that cancellation at the last
  // possible point before dispatch instead of starting a process which PM has
  // already superseded.
  const beforeDispatch = activeTurns.get(rawSessionKey);
  if (!beforeDispatch || beforeDispatch.acceptedId !== acceptedId) {
    logger.warn?.("[pm-channel] discarded displaced turn before embedded dispatch");
    return;
  }
  if (beforeDispatch.abortedAt) {
    activeTurns.delete(rawSessionKey);
    logger.warn?.("[pm-channel] canceled turn before embedded dispatch");
    return;
  }

  const { cliEffort, ...effortOptions } = await resolvePmTurnEffort({ runtime, cfg, agentId, sessionKey, policy: payload.effortPolicy, logger });
  // Capability lookup awaits I/O: recheck cancellation before starting a run.
  const afterEffortLookup = activeTurns.get(rawSessionKey);
  if (!afterEffortLookup || afterEffortLookup.acceptedId !== acceptedId) return;
  if (afterEffortLookup.abortedAt) { activeTurns.delete(rawSessionKey); return; }
  try {
    await inbound.dispatchReply({
      cfg: withPmHighDefault(cfg, agentId, cliEffort),
      channel: CHANNEL_ID,
      accountId: account.accountId,
      agentId,
      routeSessionKey: sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: runtime.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      // OpenClaw fires this only after the turn owns the reply lane and its
      // restart-recovery context has been persisted. This is the canonical
      // execution-admission boundary, not the earlier HTTP/bus handoff.
      onTurnAdopted: () => stream.turnAdmitted(),
      delivery: {
        deliver: async (replyPayload) => {
          const text = payloadText(replyPayload);
          if (!text) return;
          const result = await sendPmText({
            cfg,
            accountId: account.accountId,
            to: encodedTarget,
            text,
            replyToId: messageId,
            agentMeta: stream.agentMeta(),
          });
          await stream.final(text);
          visibleReplySent = true;
          return {
            messageIds: [result.messageId],
            receipt: createReceipt(result.messageId, undefined, messageId),
            visibleReplySent: true,
          };
        },
        onError: (err, info) => {
          logger.warn?.(`[pm-channel] ${info.kind} reply failed: ${String(err)}`);
        },
      },
      replyPipeline: {},
      replyOptions: {
        ...effortOptions,
        sourceReplyDeliveryMode: "automatic",
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        // PM's bounded execution episodes count these events. Without this
        // callback a browser-heavy turn can make hundreds of model/tool loops
        // while its durable tool-cycle counter remains zero.
        allowToolLifecycleWhenProgressHidden: true,
        onToolStart: (toolPayload) => stream.toolStart(toolPayload),
        // This is the actual selected model, including fallback changes. It is
        // attached to stream and durable reply callbacks for provenance.
        onModelSelected: (selection) => stream.modelSelected(selection),
        onPartialReply: (replyPayload) => stream.partial(replyPayload),
        onReasoningStream: (replyPayload) => stream.reasoning(replyPayload),
      },
      record: {
        createIfMissing: true,
        onRecordError: (err) => {
          logger.warn?.(`[pm-channel] session record failed: ${String(err)}`);
        },
      },
      messageId,
    });
    if (visibleReplySent) {
      await stream.done();
    } else {
      // Distinguish "gateway aborted this turn" (cancel endpoint) from "agent
      // chose silence" so the web run row records the real cause.
      const active = activeTurns.get(rawSessionKey);
      if (active?.abortedAt && active.acceptedId === acceptedId) {
        logger.warn?.("[pm-channel] turn aborted by gateway before a visible reply");
        await stream.error(new Error("gateway aborted turn (cancel endpoint)"));
      } else {
        logger.warn?.("[pm-channel] turn ended without a visible reply");
        await stream.error(new Error("Agent finished without posting a reply."));
      }
    }
  } catch (err) {
    const message = String(err?.message ?? err);
    if (err?.name === "AbortError" || /abort/i.test(message)) {
      await stream.error(new Error(`gateway aborted turn: ${message}`));
    } else {
      await stream.error(err);
    }
    throw err;
  } finally {
    const active = activeTurns.get(rawSessionKey);
    if (!active || active.acceptedId === acceptedId) {
      activeTurns.delete(rawSessionKey);
    }
  }
}

async function abortActiveTurn(sessionKey, expectedDispatchId = null) {
  const active = activeTurns.get(sessionKey);
  if (
    active &&
    expectedDispatchId &&
    active.acceptedId !== expectedDispatchId
  ) {
    return { aborted: false, reason: "dispatch_mismatch", activeDispatchId: active.acceptedId };
  }
  try {
    const harness = await import("openclaw/plugin-sdk/agent-harness");
    if (
      typeof harness.resolveActiveEmbeddedRunSessionId !== "function"
      || typeof harness.abortAndDrainAgentHarnessRun !== "function"
    ) return { aborted: false, reason: "abort_unavailable" };

    const drainResolvedRun = async (embeddedSessionId, resolvedSessionKey) => {
      const drained = await harness.abortAndDrainAgentHarnessRun({
        sessionId: embeddedSessionId,
        sessionKey: resolvedSessionKey,
        settleMs: 10_000,
        forceClear: true,
        reason: "PM channel cancellation",
      });
      return drained.drained || drained.forceCleared
        ? { aborted: true, reason: drained.forceCleared ? "force_cleared" : "drained" }
        : { aborted: false, reason: "active_run_not_drained" };
    };

    const releaseCanceledGeneration = (acceptedId) => {
      const current = activeTurns.get(sessionKey);
      if (current?.acceptedId === acceptedId) activeTurns.delete(sessionKey);
    };

    // The gateway can recover an interrupted PM session after restart before
    // this plugin has rebuilt its process-local activeTurns map. Resolve that
    // durable session key directly so recovered runs remain cancellable and do
    // not occupy the lane forever while /cancel incorrectly says not_active.
    if (!active) {
      const recoveredSessionId = await harness.resolveActiveEmbeddedRunSessionId(sessionKey);
      if (!recoveredSessionId) return { aborted: false, reason: "not_active" };
      return drainResolvedRun(recoveredSessionId, sessionKey);
    }

    // Mark BEFORE resolving the embedded run. runPmTurn checks this flag just
    // before dispatch, covering cancellation during inbound context assembly.
    active.abortedAt = Date.now();
    const lookupKey = active.canonicalSessionKey || sessionKey;

    // The cancel request can race the embedded runner's registration by a few
    // event-loop turns. Wait briefly for the canonical key to resolve; do not
    // claim success merely because abortAgentHarnessRun(undefined) returned.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = activeTurns.get(sessionKey);
      if (!current || current.acceptedId !== active.acceptedId) {
        return { aborted: true, reason: "turn_replaced_before_dispatch" };
      }
      const embeddedSessionId = await harness.resolveActiveEmbeddedRunSessionId(
        current.canonicalSessionKey || lookupKey,
      );
      if (embeddedSessionId) {
        const result = await drainResolvedRun(
          embeddedSessionId,
          current.canonicalSessionKey || lookupKey,
        );
        // abortAndDrainAgentHarnessRun is the process-level fence. Once it has
        // drained (or force-cleared) this exact generation, release the
        // plugin's ingress slot before acknowledging /cancel. Otherwise PM can
        // receive the acknowledgement, immediately post the replacement, and
        // still lose it to session_busy while runPmTurn's finally is flushing
        // the canceled generation's terminal callback.
        if (result.aborted) releaseCanceledGeneration(active.acceptedId);
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // No embedded run appeared during the grace window. The pre-dispatch
    // cancellation flag remains authoritative, but report the distinct state
    // instead of pretending an OpenClaw process was aborted.
    releaseCanceledGeneration(active.acceptedId);
    return { aborted: true, reason: "canceled_before_dispatch" };
  } catch (err) {
    return { aborted: false, reason: String(err?.message ?? err) };
  }
}

async function steerActiveTurn(sessionKey, text) {
  const active = activeTurns.get(sessionKey);
  if (!active) return { queued: false, reason: "not_active" };
  try {
    const harness = await import("openclaw/plugin-sdk/agent-harness");
    if (
      typeof harness.resolveActiveEmbeddedRunSessionId !== "function"
      || typeof harness.queueAgentHarnessMessage !== "function"
    ) return { queued: false, reason: "steer_unavailable" };

    const embeddedSessionId = await harness.resolveActiveEmbeddedRunSessionId(
      active.canonicalSessionKey || sessionKey,
    );
    if (!embeddedSessionId) return { queued: false, reason: "active_run_not_resolved" };
    const queued = harness.queueAgentHarnessMessage(embeddedSessionId, text);
    return queued
      ? { queued: true }
      : { queued: false, reason: "active_run_not_queueable" };
  } catch (err) {
    return { queued: false, reason: String(err?.message ?? err) };
  }
}

async function handleIngress({ cfg, logger, req, res }) {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  let payload;
  try {
    payload = normalizeInboundPayload(safeJsonParse(await readRequestBody(req)));
  } catch (err) {
    writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  const accountId = normalizeAccountId(payload.accountId);
  const account = resolvePmAccount({ cfg, accountId });
  if (!tokensEqual(authHeader(req), account.token)) {
    writeJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  if (payload.taskRuntime && !validateTaskRuntime(payload.taskRuntime, payload.replyTarget)) {
    writeJson(res, 400, { error: "Invalid PM task tool runtime" });
    return true;
  }

  const rawSessionKey = payload.sessionKey.trim();
  if (activeTurns.has(rawSessionKey)) {
    // Multiple episode notifications can race on the same durable session
    // key. Replacing this map entry used to make /cancel target the newcomer
    // while the displaced setImmediate launched later as an invisible second
    // writer. Keep the first generation authoritative; PM treats this 409 as
    // retryable and dispatches the replacement after cancellation drains it.
    writeJson(res, 409, {
      error: "PM session already has an accepted turn",
      reason: "session_busy",
      sessionKey: rawSessionKey,
    });
    return true;
  }

  const acceptedId = randomUUID();
  // Register the turn so the cancel endpoint can find and abort it (the map
  // was previously never populated, making /pm-channel/cancel dead code).
  // runPmTurn's finally removes the entry once this acceptedId settles.
  activeTurns.set(rawSessionKey, { acceptedId, abortedAt: null });
  setImmediate(() => {
    runPmTurn({ cfg, payload, accountId, logger, acceptedId }).catch((err) => {
      if (activeTurns.get(rawSessionKey)?.acceptedId === acceptedId) activeTurns.delete(rawSessionKey);
      logger.error?.(`[pm-channel] turn ${acceptedId} failed: ${String(err)}`);
    });
  });

  writeJson(res, 202, {
    ok: true,
    id: acceptedId,
    channel: CHANNEL_ID,
    sessionKey: payload.sessionKey,
  });
  return true;
}

async function handleCancel({ cfg, req, res }) {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  let payload;
  try {
    payload = safeJsonParse(await readRequestBody(req));
  } catch (err) {
    writeJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  const accountId = normalizeAccountId(payload.accountId);
  const account = resolvePmAccount({ cfg, accountId });
  if (!tokensEqual(authHeader(req), account.token)) {
    writeJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
  if (!sessionKey) {
    writeJson(res, 400, { error: "sessionKey is required" });
    return true;
  }

  const expectedDispatchId = typeof payload.gatewayDispatchId === "string"
    ? payload.gatewayDispatchId.trim()
    : null;
  const result = await abortActiveTurn(sessionKey, expectedDispatchId);
  writeJson(res, 200, { ok: true, ...result });
  return true;
}

async function handleSteer({ cfg, req, res }) {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return true;
  }

  const payload = safeJsonParse(await readRequestBody(req));
  const accountId = normalizeAccountId(payload?.accountId);
  const account = resolvePmAccount({ cfg, accountId });
  if (!tokensEqual(authHeader(req), account.token)) {
    writeJson(res, 401, { error: "Unauthorized" });
    return true;
  }

  const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey.trim() : "";
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!sessionKey || !text) {
    writeJson(res, 400, { error: "sessionKey and text are required" });
    return true;
  }

  const result = await steerActiveTurn(sessionKey, text.slice(0, 4_000));
  writeJson(res, result.queued ? 200 : 409, { ok: result.queued, ...result });
  return true;
}

const pmPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "PM",
      selectionLabel: "PM",
      docsPath: "/plugins/pm-channel",
      docsLabel: "PM Channel",
      blurb: "Local Mission Control chat and task-comment channel.",
      markdownCapable: true,
      showInSetup: false,
      exposure: {
        configured: true,
        setup: false,
        docs: false,
      },
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      reply: true,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.pm"] },
    configSchema: pmChannelConfigSchema,
    config: {
      listAccountIds: (cfg) => listPmAccountIds(cfg),
      resolveAccount: (cfg, accountId) => resolvePmAccount({ cfg, accountId }),
      defaultAccountId: (cfg) => normalizeAccountId(cfg.channels?.pm?.defaultAccount),
      isEnabled: (account) => account.enabled,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running: account.enabled && account.configured,
        connected: account.enabled && account.configured,
      }),
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolvePmAccount({ cfg, accountId }).defaultTo,
    },
    messaging: {
      targetPrefixes: ["pm"],
      normalizeTarget: (raw) => raw.startsWith("pm:") ? raw : `pm:${raw}`,
      parseExplicitTarget: ({ raw }) => ({
        to: raw.startsWith("pm:") ? raw : `pm:${raw}`,
        chatType: "direct",
      }),
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw) => String(raw ?? "").startsWith("pm:"),
        hint: "pm:<target>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) =>
        buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: {
            kind: "direct",
            id: target,
          },
          chatType: "direct",
          from: `pm:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: target,
        }),
    },
    status: {
      buildAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        running: account.enabled && account.configured,
        connected: account.enabled && account.configured,
        healthState: account.configured ? "ok" : "missing_config",
      }),
    },
    gateway: {
      // The PM channel is HTTP-ingress-only (no long-running transport), but
      // without a gateway.startAccount the channel manager returns before ever
      // marking the account running, so the in-gateway health monitor
      // "restarts" pm:default as a no-op every cooldown (~4/hr per agent,
      // fleet-wide log spam). A start task that resolves ONLY on the abort
      // signal keeps runtime.running true for the account's whole lifetime;
      // resolving earlier would log "channel exited without an error".
      startAccount: async ({ abortSignal }) => {
        if (abortSignal?.aborted) return;
        await new Promise((resolve) => {
          abortSignal.addEventListener("abort", resolve, { once: true });
        });
      },
    },
    message: pmMessageAdapter,
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) =>
        await sendPmText({ cfg, to, text, accountId, replyToId, threadId }),
    },
  },
});

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "PM Channel",
  description: "Native local PM chat and task-comment channel for OpenClaw.",
  plugin: pmPlugin,
  configSchema: {
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  setRuntime: setPmRuntime,
  registerFull(api) {
    const toolManifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
    const telemetry = createPmTaskTelemetry({
      findTurn: (key) => [...activeTurns.values()].find((turn) => turn.canonicalSessionKey === key),
    });
    api.on("llm_input", telemetry.input);
    api.on("llm_output", telemetry.output);
    api.registerTool((context) => createTaskTools({
      context,
      findTurn: (key) => [...activeTurns.values()].find((turn) => turn.canonicalSessionKey === key),
    }), { names: PM_TASK_TOOL_NAMES });
    api.registerHttpRoute({
      path: "/pm-channel/capabilities",
      auth: "plugin",
      match: "exact",
      handler: (req, res) => {
        const account = resolvePmAccount({ cfg: api.config, accountId: "default" });
        if (!tokensEqual(authHeader(req), account.token)) writeJson(res, 401, { error: "Unauthorized" });
        else if (req.method !== "GET") writeJson(res, 405, { error: "Method not allowed" });
        else writeJson(res, 200, taskToolCapabilities(toolManifest, api.config, account.agentId));
        return true;
      },
    });
    api.registerHttpRoute({
      path: "/pm-channel/ingest",
      auth: "plugin",
      match: "exact",
      handler: (req, res) => handleIngress({
        cfg: api.config,
        logger: api.logger,
        req,
        res,
      }),
    });
    api.registerHttpRoute({
      path: "/pm-channel/cancel",
      auth: "plugin",
      match: "exact",
      handler: (req, res) => handleCancel({
        cfg: api.config,
        req,
        res,
      }),
    });
    api.registerHttpRoute({
      path: "/pm-channel/steer",
      auth: "plugin",
      match: "exact",
      handler: (req, res) => handleSteer({
        cfg: api.config,
        req,
        res,
      }),
    });
  },
});
