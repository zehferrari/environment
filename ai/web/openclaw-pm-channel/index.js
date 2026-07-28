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

function createPmStreamPublisher({ account, target, logger }) {
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
      final: async () => {},
      done: async () => {},
      error: async () => {},
    };
  }

  let queued = null;
  let timer = null;
  let chain = Promise.resolve();
  let lastReasoningText = "";

  const post = (body) => {
    const payload = {
      version: 1,
      channel: CHANNEL_ID,
      target,
      transportMode: streamTransport,
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

  const flush = async () => {
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
    await chain;
  };

  return {
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
      await post({ event: "done" });
    },
    error: async (err) => {
      await flush();
      await post({ event: "error", error: err instanceof Error ? err.message : String(err) });
    },
  };
}

async function sendPmText({ cfg, accountId, to, text, replyToId, threadId }) {
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
  const stream = createPmStreamPublisher({ account, target, logger });
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

  try {
    await inbound.dispatchReply({
      cfg,
      channel: CHANNEL_ID,
      accountId: account.accountId,
      agentId,
      routeSessionKey: sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: runtime.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
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
        sourceReplyDeliveryMode: "automatic",
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
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

async function abortActiveTurn(sessionKey) {
  const active = activeTurns.get(sessionKey);
  if (!active) return { aborted: false, reason: "not_active" };
  try {
    const harness = await import("openclaw/plugin-sdk/agent-harness");
    const embeddedSessionId =
      typeof harness.resolveActiveEmbeddedRunSessionId === "function"
        ? await harness.resolveActiveEmbeddedRunSessionId(sessionKey)
        : sessionKey;
    if (typeof harness.abortAgentHarnessRun === "function") {
      // Mark BEFORE aborting and keep the entry: runPmTurn reads abortedAt to
      // report "gateway aborted turn" instead of "agent chose silence", then
      // its finally block cleans the map (keyed on acceptedId).
      active.abortedAt = Date.now();
      await harness.abortAgentHarnessRun(embeddedSessionId);
      return { aborted: true };
    }
    return { aborted: false, reason: "abort_unavailable" };
  } catch (err) {
    return { aborted: false, reason: String(err?.message ?? err) };
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

  const acceptedId = randomUUID();
  // Register the turn so the cancel endpoint can find and abort it (the map
  // was previously never populated, making /pm-channel/cancel dead code).
  // runPmTurn's finally removes the entry once this acceptedId settles.
  activeTurns.set(payload.sessionKey.trim(), { acceptedId, abortedAt: null });
  setImmediate(() => {
    runPmTurn({ cfg, payload, accountId, logger, acceptedId }).catch((err) => {
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

  const result = await abortActiveTurn(sessionKey);
  writeJson(res, 200, { ok: true, ...result });
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
  },
});
