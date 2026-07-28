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

console.log("pm channel runtime compatibility tests passed");
