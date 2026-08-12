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
assert.match(installerSource, /async function reconcileAgentConfigLink/);
assert.match(installerSource, /await reconcileAgentConfigLink\(/);

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
  /current\.canonicalSessionKey \|\| lookupKey/,
  "gateway cancellation must resolve the canonical key rather than the raw PM key",
);
assert.match(
  pluginSource,
  /const aborted = await harness\.abortAgentHarnessRun\(embeddedSessionId\)/,
  "gateway cancellation must inspect OpenClaw's actual abort result",
);
assert.match(
  pluginSource,
  /aborted: false, reason: "active_run_not_abortable"/,
  "gateway cancellation must reject a no-op abort rather than acknowledge it",
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

console.log("pm channel runtime compatibility tests passed");
