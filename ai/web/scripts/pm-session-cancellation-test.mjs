import assert from "node:assert/strict";
import { clearPmSessionQueue } from "../openclaw-pm-channel/session-cancellation.js";

const stale = "agent:main:pm:task:wdt-17:agent:carmen:turn:ep16";
const other = "agent:main:pm:task:other:agent:carmen:turn:ep1";
const queued = new Map([[stale, ["expired-callback", "replacement"]], [other, ["unrelated"]]]);
let calls = 0;
const request = async (method, args) => {
  calls++;
  assert.equal(method, "sessions.abort");
  assert.equal(args.clearQueued, true);
  queued.delete(args.key);
  // There is no embedded run: the queue itself must still be cleared.
  return { ok: true, status: "no-active-run", abortedRunId: null };
};
await clearPmSessionQueue({ request, sessionKey: stale });
assert.equal(queued.has(stale), false);
assert.deepEqual(queued.get(other), ["unrelated"]);
await clearPmSessionQueue({ request, sessionKey: stale });
assert.equal(calls, 2, "already-empty cancellation is idempotent");
await assert.rejects(clearPmSessionQueue({ request, sessionKey: "global" }), /non-PM/);
assert.equal(calls, 2, "invalid scope never reaches the gateway");
await assert.rejects(clearPmSessionQueue({ sessionKey: stale }), /unavailable/);
await assert.rejects(clearPmSessionQueue({ request: async () => ({ ok: false }), sessionKey: stale }), /acknowledge/);
await assert.rejects(clearPmSessionQueue({ request: async () => { throw new Error("RPC failed"); }, sessionKey: stale }), /RPC failed/);
console.log("PASS queued-only cancellation, exact session scope, idempotence and fail-closed acknowledgements");
