import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolvePmInboundRuntime } from "../openclaw-pm-channel/runtime-compat.js";

function surface(api, dispatchMethod) {
  return {
    api,
    buildContext(payload) {
      return { api: this.api, payload };
    },
    [dispatchMethod](payload) {
      return { api: this.api, payload };
    },
  };
}

const current = resolvePmInboundRuntime({
  channel: {
    inbound: surface("current", "dispatchReply"),
    turn: surface("legacy-ignored", "runAssembled"),
  },
});
assert.equal(current.api, "channel.inbound");
assert.deepEqual(current.buildContext({ id: 1 }), {
  api: "current",
  payload: { id: 1 },
});
assert.deepEqual(current.dispatchReply({ id: 2 }), {
  api: "current",
  payload: { id: 2 },
});

const rollback = resolvePmInboundRuntime({
  channel: {
    turn: surface("rollback", "runAssembled"),
  },
});
assert.equal(rollback.api, "channel.turn");
assert.deepEqual(rollback.buildContext({ id: 3 }), {
  api: "rollback",
  payload: { id: 3 },
});
assert.deepEqual(rollback.dispatchReply({ id: 4 }), {
  api: "rollback",
  payload: { id: 4 },
});

assert.throws(
  () => resolvePmInboundRuntime({ channel: {} }),
  /requires OpenClaw channel\.inbound/,
);

const installerSource = readFileSync(
  new URL("../deploy/install-openclaw-pm-channel.mjs", import.meta.url),
  "utf8",
);
assert.match(installerSource, /async function reconcileAgentConfigCopy/);
assert.match(installerSource, /await reconcileAgentConfigCopy\(/);
assert.match(installerSource, /async function copyCanonicalConfigToHome/);

const pluginSource = readFileSync(
  new URL("../openclaw-pm-channel/index.js", import.meta.url),
  "utf8",
);
assert.match(
  pluginSource,
  /onToolStart: \(toolPayload\) => stream\.toolStart\(toolPayload\)/,
  "the native PM plugin must forward real OpenClaw tool calls to PM episode accounting",
);
assert.match(
  pluginSource,
  /allowToolLifecycleWhenProgressHidden: true/,
  "tool accounting must remain observable even when visible tool summaries are disabled",
);
assert.match(
  pluginSource,
  /onModelSelected: \(selection\) => stream\.modelSelected\(selection\)/,
  "the native PM plugin must report the actual selected/fallback model",
);
assert.match(
  pluginSource,
  /onTurnAdopted: \(\) => stream\.turnAdmitted\(\)/,
  "the native PM plugin must report admission only after OpenClaw adopts the turn",
);
assert.doesNotMatch(
  pluginSource,
  /\.then\(\(\) => flush\(\)\)/,
  "model selection must not deadlock the stream chain by awaiting itself",
);
assert.match(
  pluginSource,
  /drainQueued\(\);\s*chain = chain\s*\.then\(\(\) => post\(\{/,
  "model selection must append its event after draining coalesced stream output",
);
assert.match(
  pluginSource,
  /meta: \{ agentMeta: selectedAgentMeta \}/,
  "stream callbacks must carry model provenance to Mission Control",
);
assert.match(
  pluginSource,
  /registeredTurn\.canonicalSessionKey = sessionKey/,
  "gateway cancellation must retain the canonical OpenClaw session key",
);
assert.match(
  pluginSource,
  /if \(!registeredTurn \|\| registeredTurn\.acceptedId !== acceptedId\)/,
  "a displaced ingress callback must not survive long enough to launch a stale model turn",
);
assert.match(
  pluginSource,
  /if \(!beforeDispatch \|\| beforeDispatch\.acceptedId !== acceptedId\)/,
  "the final pre-dispatch fence must reject a generation displaced during context assembly",
);
assert.match(
  pluginSource,
  /if \(activeTurns\.has\(rawSessionKey\)\)[\s\S]*reason: "session_busy"/,
  "ingress must not overwrite the cancellation identity for a live session generation",
);
assert.match(
  pluginSource,
  /gatewayDispatchId: acceptedId/,
  "every lifecycle callback must carry the exact accepted gateway generation",
);
assert.match(
  pluginSource,
  /active\.acceptedId !== expectedDispatchId[\s\S]*reason: "dispatch_mismatch"/,
  "cancellation must refuse to abort a different live gateway generation",
);
assert.match(
  pluginSource,
  /current\.canonicalSessionKey \|\| lookupKey/,
  "gateway cancellation must resolve the canonical key rather than the raw PM key",
);
assert.match(
  pluginSource,
  /await harness\.abortAndDrainAgentHarnessRun\(\{/,
  "gateway cancellation must drain the OpenClaw session lane after abort",
);
assert.match(
  pluginSource,
  /if \(!active\) \{[\s\S]*resolveActiveEmbeddedRunSessionId\(sessionKey\)[\s\S]*drainResolvedRun\(recoveredSessionId, sessionKey\)/,
  "restart-recovered PM runs must remain cancellable after the process-local active-turn map is lost",
);
assert.match(
  pluginSource,
  /forceClear: true/,
  "gateway cancellation must force-clear an undrained session lock after its settle window",
);
assert.match(
  pluginSource,
  /aborted: false, reason: "active_run_not_drained"/,
  "gateway cancellation must reject a process fence that did not drain",
);
assert.match(
  pluginSource,
  /if \(result\.aborted\) releaseCanceledGeneration\(active\.acceptedId\)/,
  "a drained gateway generation must release its ingress slot before cancellation is acknowledged",
);
assert.match(
  pluginSource,
  /current\?\.acceptedId === acceptedId\) activeTurns\.delete\(sessionKey\)/,
  "cancellation must only release the exact gateway generation it fenced",
);
assert.match(
  pluginSource,
  /path: "\/pm-channel\/steer"/,
  "the native PM plugin must expose authenticated mid-turn checkpoint steering",
);
assert.match(
  pluginSource,
  /harness\.queueAgentHarnessMessage\(embeddedSessionId, text\)/,
  "checkpoint steering must target the active embedded harness session",
);

// Exercise the publisher directly with mocked transports. This catches a
// subtle promise-cycle regression that source-shape assertions alone cannot:
// modelSelected used to append flush() to `chain`, while flush() awaited that
// same reassigned chain, permanently blocking every later tool/stream event.
const publisherStart = pluginSource.indexOf("function createPmStreamPublisher");
const publisherEnd = pluginSource.indexOf("\nasync function sendPmText", publisherStart);
assert.ok(publisherStart >= 0 && publisherEnd > publisherStart, "publisher source must be extractable");
const publisherSource = pluginSource.slice(publisherStart, publisherEnd).trim();
const posted = [];
const warnings = [];
const createPmStreamPublisher = new Function(
  "CHANNEL_ID",
  "resolveStreamUrl",
  "streamPayloadText",
  "streamPayloadDelta",
  "sendJsonLineToUnixSocket",
  "postJson",
  `return (${publisherSource});`,
)(
  "pm",
  (target) => target.streamUrl ?? "",
  (payload) => typeof payload?.text === "string" ? payload.text : "",
  (payload) => typeof payload?.delta === "string" ? payload.delta : "",
  async () => {},
  async (_url, _token, body) => { posted.push(body); return {}; },
);
const publisher = createPmStreamPublisher({
  account: { callbackToken: "test-token" },
  target: { streamUrl: "http://pm.test/stream", streamTransport: "http" },
  logger: { warn: (message) => warnings.push(message) },
});
publisher.partial({ delta: "before-model" });
publisher.modelSelected({ provider: "test-provider", model: "test-model" });
publisher.modelSelected({ provider: "ignored-provider", model: "ignored-model" });
await Promise.race([
  publisher.toolStart({ phase: "start", toolCallId: "tool-1", name: "exec" }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("publisher stream chain deadlocked")), 1_000)),
]);
await publisher.final("finished");
assert.deepEqual(
  posted.map((payload) => payload.event),
  ["partial", "model:selected", "tool:start", "final"],
  "model selection must preserve order and leave later tool/final callbacks drainable",
);
assert.equal(warnings.length, 0, "publisher must not hide callback failures during the lifecycle test");

console.log("pm channel runtime compatibility tests passed");
