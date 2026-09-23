// Run with OPENCLAW_DIST=/usr/local/lib/node_modules/openclaw/dist.
// Exercises the actual ingress handler against OpenClaw's real admission state,
// using an isolated HTTP server and a gated fake model (no credentials or LLM).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import path from "node:path";
const dist = process.env.OPENCLAW_DIST ?? "/usr/local/lib/node_modules/openclaw/dist";
assert.ok(dist, "Set OPENCLAW_DIST to the installed OpenClaw dist directory");
const file = readdirSync(dist).find((name) => /^gateway-work-admission-.*\.mjs$/.test(name));
assert.ok(file, "OpenClaw admission module must be available");
const admissionSource = readFileSync(path.join(dist, file), "utf8");
const admissionModule = await import(pathToFileURL(path.join(dist, file)));
function exported(name) {
  const alias = admissionSource.match(new RegExp(`\\b${name} as (\\w+)`))?.[1];
  assert.ok(alias, `Installed OpenClaw must export ${name}`);
  return admissionModule[alias];
}
const begin = exported("tryBeginGatewayRootWorkAdmission");
const closed = exported("isGatewaySubordinateWorkAdmissionClosed");
const activeCount = exported("getActiveGatewayRootWorkCount");
const source = readFileSync(process.env.PM_PLUGIN_SOURCE ?? new URL("../openclaw-pm-channel/index.js", import.meta.url), "utf8");
const handlerSource = source.slice(source.indexOf("async function handleIngress("), source.indexOf("async function handleCancel("));
let release;
let entered;
let mode = "success";
const activeTurns = new Map();
const errors = [];
const logger = { error: (line) => errors.push(line) };
const handler = runInNewContext(`(${handlerSource})`, {
  CHANNEL_ID: "pm", activeTurns, setImmediate, randomUUID: () => "test-dispatch", logger,
  normalizeInboundPayload: (p) => p, safeJsonParse: JSON.parse,
  normalizeAccountId: () => "default", resolvePmAccount: () => ({ token: "test-token" }),
  authHeader: (req) => req.headers.authorization, tokensEqual: (a, b) => a === b,
  validateTaskRuntime: () => true,
  readRequestBody: async (req) => { let text = ""; for await (const part of req) text += part; return text; },
  writeJson: (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
  runPmTurn: async ({ payload }) => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed(), false, "accepted turn must retain its HTTP admission after asynchronous context preparation");
    entered();
    await new Promise((resolve) => { release = resolve; });
    assert.equal(closed(), false, "admission must remain open throughout the turn");
    if (mode === "failure") throw new Error("simulated provider failure");
    activeTurns.delete(payload.sessionKey);
  },
});
const pending = new Set();
const server = createServer((req, res) => {
  const lease = begin("test:pm-http");
  assert.ok(lease);
  const work = lease.run(() => handler({ cfg: {}, logger, req, res })).finally(() => lease.release());
  pending.add(work);
  work.finally(() => pending.delete(work));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const send = (token = "test-token") => fetch(url, { method: "POST", headers: { authorization: token }, body: JSON.stringify({ sessionKey: "pm:test" }) });
try {
  assert.equal((await send("wrong-token")).status, 401);
  for (const outcome of ["success", "failure", "success"]) {
    mode = outcome;
    const started = new Promise((resolve) => { entered = resolve; });
    const response = await send();
    assert.equal(response.status, 202, "receipt must arrive before model completion");
    let deadline;
    try {
      await Promise.race([started, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(errors.join("\n") || "turn never entered")), 1000); })]);
    } finally { clearTimeout(deadline); }
    assert.equal(activeCount(), 1, "accepted HTTP turn must still own admission");
    assert.equal((await send()).status, 409, "same-session overlap must remain fenced");
    release();
    await Promise.all(pending);
    assert.equal(activeCount(), 0, "settled turn must release admission");
    assert.equal(activeTurns.size, 0, "success and failure must both release the PM lane");
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /simulated provider failure/);
  console.log("PASS: real OpenClaw admission, immediate HTTP 202, async model work, overlap fence, error cleanup and subsequent turn");
} finally {
  release?.();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
