import assert from "node:assert/strict";
import { waitForPmGatewayReady } from "../deploy/pm-gateway-ready.mjs";
let attempts = 0;
let waited = 0;
const args = { agent: "worker", port: 18789, token: "test", isActive: () => true, wait: async () => { waited++; } };
await waitForPmGatewayReady({ ...args, fetchImpl: async () => {
  if (++attempts === 1) throw new Error("connection refused");
  if (attempts === 2) return Response.json({ booting: true });
  return Response.json({ taskRuntimeVersions: [], taskTools: [] });
} });
assert.equal(attempts, 3, "active service and boot response are not channel readiness");
assert.equal(waited, 2);
await assert.rejects(waitForPmGatewayReady({ ...args, attempts: 2, fetchImpl: async () => Response.json({}, { status: 401 }) }), /did not become ready/);
await assert.rejects(waitForPmGatewayReady({ ...args, attempts: 1, isActive: () => false, fetchImpl: async () => { throw new Error("must not probe stopped service"); } }), /did not become ready/);
console.log("PASS readiness waits for authenticated PM capabilities, including CLI gateways");
