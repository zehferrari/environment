import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { canDeliverTaskReply, isDeliberateSilentDispatch, isGatewayFailureReply, isProtocolSilentReply } from "../openclaw-pm-channel/turn-completion.js";
import { resolvePmInboundRuntime } from "../openclaw-pm-channel/runtime-compat.js";
import { createPmTaskTelemetry, latestContextSnapshot } from "../openclaw-pm-channel/task-telemetry.js";
import { createToolLiveness } from "../openclaw-pm-channel/tool-liveness.js";

// The installed channel dispatcher, with a deterministic reply resolver; no
// model, credentials, gateway, agent workspace, or live database is touched.
const isolated = await mkdtemp("/tmp/pm-runtime-reliability-");
process.env.OPENCLAW_STATE_DIR = isolated;
process.env.OPENCLAW_CONFIG_PATH = path.join(isolated, "openclaw.json");
await writeFile(process.env.OPENCLAW_CONFIG_PATH, "{}");
try {
  const dist = process.env.OPENCLAW_DIST ?? "/usr/local/lib/node_modules/openclaw/dist";
  const { dispatchChannelInboundReply } = await import(pathToFileURL(path.join(dist, "plugin-sdk/channel-inbound.js")));
  const { dispatchReplyWithBufferedBlockDispatcher } = await import(pathToFileURL(path.join(dist, "plugin-sdk/reply-runtime.js")));
  const sdkFixtures = new Map();
  for (const mode of ["silent", "empty", "visible"]) {
    const delivered = [];
    let overwrittenCallback = false;
    const result = await dispatchChannelInboundReply({
      cfg: { agents: { defaults: { workspace: isolated } }, session: { store: path.join(isolated, "sessions.json") } },
      channel: "pm", accountId: "test", agentId: "main",
      routeSessionKey: `agent:main:pm:test-${mode}`,
      storePath: path.join(isolated, "sessions.json"),
      ctxPayload: { SessionKey: `agent:main:pm:test-${mode}`, Body: "test", BodyForAgent: "test", RawBody: "test", From: "pm:test", To: "pm:worker", Provider: "pm", Surface: "pm", ChatType: "direct", MessageSid: mode, CommandAuthorized: true },
      recordInboundSession: async () => {},
      dispatchReplyWithBufferedBlockDispatcher,
      delivery: { deliver: async (payload) => { delivered.push(payload); return { visibleReplySent: true }; } },
      replyPipeline: {},
      replyOptions: { onDeliberateSilentTerminalReply: () => { overwrittenCallback = true; } },
      replyResolver: async (_ctx, options) => {
        if (mode === "silent") options.onDeliberateSilentTerminalReply();
        return mode === "visible" ? { text: "Verified." } : undefined;
      },
    });
    assert.equal(isDeliberateSilentDispatch(result), mode === "silent", "only the installed SDK's explicit terminal evidence authorizes silence");
    assert.equal(overwrittenCallback, false, "core owns this internal callback; plugin must use the result");
    assert.equal(delivered.filter((payload) => !isGatewayFailureReply(payload.text)).length, mode === "visible" ? 1 : 0);
    if (mode === "empty") assert.equal(result.dispatchResult.noVisibleReplyFallbackDelivered, true, "core fallback is failure evidence, not an agent contribution");
    sdkFixtures.set(mode, { result, delivered });
  }
  console.log("PASS installed OpenClaw dispatcher: deliberate silence, empty failure evidence, visible reply");

  // Feed the actual installed dispatch result through the plugin's complete
  // runPmTurn function. Inject I/O boundaries only; exercise its real terminal
  // decision, delivery fence, silent final and error path.
  const pluginSource = await readFile(new URL("../openclaw-pm-channel/index.js", import.meta.url), "utf8");
  const runSource = pluginSource.slice(pluginSource.indexOf("async function runPmTurn("), pluginSource.indexOf("\nasync function abortActiveTurn("));
  for (const mode of ["silent", "empty", "visible", "aborted"]) {
    const posted = [];
    const frames = [];
    const generation = { acceptedId: "generation" };
    const activeTurns = new Map([["pm:test", generation]]);
    const sdk = sdkFixtures.get(mode === "aborted" ? "visible" : mode);
    const stream = { final: async (text) => frames.push(["final", text]), done: async () => frames.push(["done"]), error: async (error) => frames.push(["error", error.message]), dispose: () => {}, turnAdmitted: async () => {}, toolStart: async () => {}, itemEvent: async () => {}, modelSelected: () => {}, partial: () => {}, reasoning: () => {}, agentMeta: () => ({}) };
    const runtime = { channel: { inbound: {
      buildContext: async (args) => args,
      dispatchReply: async (args) => {
        if (mode === "aborted") generation.abortedAt = Date.now();
        for (const payload of sdk.delivered) await args.delivery.deliver(payload);
        return sdk.result;
      },
    }, session: { resolveStorePath: () => "isolated", readSessionUpdatedAt: () => undefined, recordInboundSession: async () => {} }, reply: { formatAgentEnvelope: ({ body }) => body, resolveEnvelopeFormatOptions: () => ({}) } } };
    const run = runInNewContext(`(${runSource})`, {
      CHANNEL_ID: "pm", activeTurns, getPmRuntime: () => runtime, resolvePmInboundRuntime,
      resolvePmAccount: () => ({ enabled: true, configured: true, accountId: "test", agentId: "main" }),
      encodeTarget: JSON.stringify, canonicalizePmStoreSessionKey: () => "agent:main:pm:test", validateTaskRuntime: () => null,
      isDirectTarget: () => false, targetConversationId: () => "task", targetConversationLabel: () => "Task", actorLabel: () => "Owner", buildAgentBody: () => "Test",
      createPmStreamPublisher: () => stream, resolvePmTurnEffort: async () => ({}), withPmHighDefault: (cfg) => cfg,
      canDeliverTaskReply, isDeliberateSilentDispatch, isGatewayFailureReply, isProtocolSilentReply,
      payloadText: (payload) => payload.text ?? "", sendPmText: async (payload) => { posted.push(payload); return { messageId: "reply" }; }, createReceipt: () => ({}),
    });
    await run({ cfg: {}, payload: { replyTarget: { kind: "task-comment", taskId: "task", messageId: "message", agentSlug: "worker" }, sessionKey: "pm:test", text: "Test" }, accountId: "test", logger: { warn: () => {} }, acceptedId: "generation" });
    assert.equal(posted.length, mode === "visible" ? 1 : 0, `${mode}: operational text cannot become a comment`);
    if (mode === "silent") assert.deepEqual(frames, [["final", "NO_REPLY"], ["done"]]);
    if (mode === "empty") assert.deepEqual(frames, [["error", "Agent finished without posting a reply."]]);
    assert.equal(activeTurns.size, 0);
  }
  console.log("PASS plugin terminal handling consumes real SDK results and fences aborted delivery");

  const target = { kind: "task-comment", taskId: "task", messageId: "message", agentSlug: "worker" };
  for (const transport of ["native-tools", "scoped-http"]) {
    const rows = [];
    let limit;
    const turn = { replyTarget: target, ...(transport === "native-tools" ? { taskRuntime: {} } : {}), stream: { contextUsage: async (row) => rows.push(row), modelContext: (n) => { limit = n; } } };
    const telemetry = createPmTaskTelemetry({ findTurn: () => turn });
    const event = { runId: transport, provider: transport === "native-tools" ? "openai" : "claude-cli", contextTokenBudget: 100_000,
      usage: { input: 900_000, cacheRead: 1_000_000, output: 5_000, total: 1_905_000 },
      lastAssistant: { api: transport === "native-tools" ? "responses" : "cli", usage: { input: 10_000, cacheRead: 20_000, cacheWrite: 5_000, output: 200 } }, prompt: "secret prompt", assistantTexts: ["secret reply"] };
    telemetry.input(event, { sessionKey: "test" });
    await telemetry.output(event, { sessionKey: "test" });
    await telemetry.output(event, { sessionKey: "test" });
    assert.equal(limit, 100_000);
    assert.equal(rows.length, 1, "usage hook replay cannot double count either transport");
    assert.equal(rows[0].inputTokens, 900_000, "billing remains aggregate");
    assert.equal(rows[0].contextSnapshot.state, transport === "native-tools" ? "available" : "unavailable");
    if (transport === "native-tools") assert.equal(rows[0].contextSnapshot.promptTokens, 35_000, "only latest call incl. cache writes is occupancy");
    assert.ok(!JSON.stringify(rows).includes("secret"));
  }
  assert.equal(latestContextSnapshot({ usage: { input: 999_999 }, contextTokenBudget: 100_000 }).state, "unavailable");
  const cliContext = latestContextSnapshot({ provider: "claude-cli", lastAssistant: { api: "cli", usage: { input: 900_000, contextUsage: { state: "available", promptTokens: 45_000, totalTokens: 45_200 } } }, contextTokenBudget: 100_000 });
  assert.equal(cliContext.promptTokens, 45_000);
  const turn = {};
  assert.equal(canDeliverTaskReply(turn, turn), true);
  assert.equal(canDeliverTaskReply(turn, {}), false);
  turn.abortedAt = 1;
  assert.equal(canDeliverTaskReply(turn, turn), false);
  console.log("PASS native/CLI telemetry scope, aggregate separation, cache writes, unknown occupancy and cancellation fencing");

  let now = 0;
  let active = true;
  let heartbeats = 0;
  let stops = 0;
  const heartbeat = createToolLiveness({ heartbeat: async () => { heartbeats++; }, isActive: () => active, now: () => now, maximumSilentMs: 180_000, schedule: () => 1, cancel: () => { stops++; } });
  heartbeat.start("long-test");
  now = 130_000; await heartbeat.tick();
  assert.equal(heartbeats, 1, "known silent tool remains leased beyond the two-minute lease");
  heartbeat.finish("long-test"); await heartbeat.tick();
  assert.equal(heartbeats, 1, "completed tool stops heartbeats");
  heartbeat.start("canceled"); active = false; await heartbeat.tick();
  assert.equal(heartbeats, 1, "cancellation stops heartbeats");
  active = true; heartbeat.start("wedged"); now += 180_001; await heartbeat.tick();
  assert.equal(heartbeats, 1, "finite silence ceiling does not immortalize a wedged tool");
  assert.ok(stops >= 3);
  heartbeat.dispose();
  console.log("PASS tool heartbeat lifecycle and bounded silence");
} finally {
  await rm(isolated, { recursive: true, force: true });
}
