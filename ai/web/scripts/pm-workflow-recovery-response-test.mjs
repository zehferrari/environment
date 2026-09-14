import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const file = new URL("../app/api/agent/tasks/[taskId]/request-workflow-turn/route.ts", import.meta.url);
const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const records = [];
let delivery = { ok: false, error: "channel down: cooldown" };
let active = null;
let dispatches = 0;
const task = { id: "task", title: "Recovery", status: "In Progress", assigneeId: "agent-user", projectId: "project" };
const db = {
  agent: { findUnique: async () => ({ slug: "worker", user: { id: "agent-user", username: "worker", status: "active" } }) },
  task: { findFirst: async () => task },
  pmChannelRun: { findFirst: async () => active },
  activityLog: {
    findFirst: async ({ where }) => records.findLast((row) => row.kind === where.kind) ?? null,
    create: async ({ data }) => { records.push({ ...data, createdAt: new Date() }); },
  },
};
const imports = {
  "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
  "@/lib/db": { db },
  "@/lib/agents/pm-channel/openclaw": { resolvePmChannelToken: async () => "token" },
  "@/lib/agents/pm-channel/callback-auth": { authorizePmChannelCallback: ({ presented, expectedAgent }) => presented === expectedAgent },
  "@/lib/agents/workflow/notifications/task": { sendTaskWorkflowNotification: async () => { dispatches++; return { messageId: "message", delivery }; } },
  "@/lib/agents/private-task-access": { resolveAgentTaskAccess: async () => ({ allowed: true }) },
};
const exports = {};
runInNewContext(source, { exports, require: (id) => { assert.ok(imports[id], `unexpected import ${id}`); return imports[id]; }, process: { env: {} }, Date });
const call = () => exports.POST(new Request("http://localhost/recovery", { method: "POST", headers: { authorization: "Bearer token", "content-type": "application/json" }, body: JSON.stringify({ agentSlug: "worker" }) }), { params: Promise.resolve({ taskId: "task" }) });
let response = await call();
assert.equal(response.status, 503);
assert.deepEqual(await response.json(), { ok: false, dispatched: false, taskId: "task", messageId: "message", error: "channel down: cooldown" });
assert.equal(records[0].kind, "task.workflow.turn_request_failed");
assert.equal(JSON.parse(records[0].payload).dispatched, false);
delivery = { ok: true, status: 202 };
response = await call();
assert.equal(response.status, 200, "failed dispatch must not consume the successful-request rate limit");
assert.equal((await response.json()).dispatched, true);
assert.equal(records[1].kind, "task.workflow.turn_requested");
response = await call();
assert.equal(response.status, 429, "successful requests retain the duplicate guard");
active = { id: "active", status: "streaming", messageId: "running", leaseExpiresAt: null };
response = await call();
assert.equal(response.status, 200);
assert.equal((await response.json()).alreadyActive, true);
assert.equal(dispatches, 2, "active work and rate-limited requests must never enqueue a replacement");
console.log("PASS: suppressed recovery reports 503, truthful audit, retry after failure, successful cooldown and active-run protection");
