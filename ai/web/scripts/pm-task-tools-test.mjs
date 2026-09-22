import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createTaskTools, validateTaskRuntime, PM_TASK_TOOL_NAMES, taskToolCapabilities } from "../openclaw-pm-channel/task-tools.js";
const manifest = JSON.parse(readFileSync(new URL("../openclaw-pm-channel/openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../openclaw-pm-channel/package.json", import.meta.url), "utf8"));
assert.deepEqual([...manifest.contracts.tools].sort(), [...PM_TASK_TOOL_NAMES].sort(), "OpenClaw discovers plugin tools from manifest contracts before invoking factories");
assert.equal(manifest.version, pkg.version);
assert.deepEqual(taskToolCapabilities(manifest), { taskRuntimeVersions: [1], taskTools: PM_TASK_TOOL_NAMES });
assert.deepEqual(taskToolCapabilities({}).taskRuntimeVersions, [], "missing manifest contracts cannot advertise a usable compact runtime");
assert.deepEqual(taskToolCapabilities({ contracts: { tools: ["pm_context"] } }).taskRuntimeVersions, [], "partial tool installation fails the capability handshake");
console.log("PASS manifest advertises every native tool to OpenClaw discovery");
const target = { kind: "task-comment", taskId: "task-1", messageId: "message-1", agentSlug: "worker" };
const runtime = { version: 1, ...target, token: "private-workflow-token", contextUrl: "http://127.0.0.1:3000/api/agents/context/task/task-1?grant=private-read-grant", workflowUrl: "http://127.0.0.1:3000/api/agent/tasks/task-1/workflow", actions: ["context", "submit_plan", "checkpoint"] };
let turn = { acceptedId: "generation-1", replyTarget: target, taskRuntime: runtime };
const findTurn = (key) => key === "agent:main:pm:task:task-1" ? turn : undefined;
const context = { messageChannel: "pm", sessionKey: "agent:main:pm:task:task-1" };
const calls = [];
const fetchImpl = async (url, options) => { calls.push({ url, options }); return Response.json({ ok: true, actionPlan: { version: 3 }, currentThread: [], token: runtime.token }); };
assert.equal(createTaskTools({ context: { ...context, messageChannel: "telegram" }, findTurn }), null);
assert.equal(createTaskTools({ context: { ...context, sessionKey: "another-task" }, findTurn }), null);
for (const patch of [{ taskId: "other" }, { messageId: "old" }, { agentSlug: "other" }, { workflowUrl: "https://evil.invalid/workflow" }, { workflowUrl: "http://127.0.0.1:3000/api/agents/remove" }, { contextUrl: "http://127.0.0.1:3000/api/agents/context/task/other?grant=x" }, { actions: ["remove_user"] }]) assert.equal(validateTaskRuntime({ ...runtime, ...patch }, target), null);
const tools = createTaskTools({ context, findTurn, fetchImpl });
assert.deepEqual(tools.map((tool) => tool.name), ["pm_context", "pm_submit_plan", "pm_checkpoint"]);
const submit = tools.find((tool) => tool.name === "pm_submit_plan");
assert.ok(!JSON.stringify(tools).includes(runtime.token));
await assert.rejects(submit.execute("1", { actionPlan: {}, token: "injected" }), /Invalid PM tool/);
assert.equal(calls.length, 0);
const result = await submit.execute("2", { actionPlan: { summary: "fix", steps: [] } });
const sent = JSON.parse(calls[0].options.body);
assert.equal(sent.messageId, target.messageId); assert.equal(sent.token, runtime.token); assert.equal(sent.action, "submit_plan");
assert.ok(!JSON.stringify(result).includes(runtime.token));
const fetched = await tools[0].execute("3", { section: "plan" });
assert.deepEqual(JSON.parse(fetched.content[0].text), { actionPlan: { version: 3 } });
const oldTurn = turn; turn = { ...turn, acceptedId: "generation-2" };
await assert.rejects(submit.execute("4", { actionPlan: {} }), /replaced/);
turn = oldTurn; turn.abortedAt = Date.now();
await assert.rejects(submit.execute("5", { actionPlan: {} }), /canceled/);
delete turn.abortedAt;
let attempts = 0; const bodies = [];
const retry = createTaskTools({ context, findTurn, fetchImpl: async (_url, opts) => { bodies.push(opts.body); if (++attempts === 1) throw new Error("lost response"); return Response.json({ ok: true }); } });
await retry[1].execute("6", { actionPlan: {} }); assert.equal(attempts, 2); assert.equal(bodies[0], bodies[1]);
const denied = createTaskTools({ context, findTurn, fetchImpl: async () => Response.json({ error: "forbidden" }, { status: 403 }) });
assert.equal((await denied[1].execute("7", { actionPlan: {} })).isError, true);
console.log("PASS native PM tools: scope, generation fencing, credentials, replay and errors");

const { createPmTaskTelemetry } = await import("../openclaw-pm-channel/task-telemetry.js");
const usages = []; turn.stream = { contextUsage: async (usage) => usages.push(usage) };
const telemetry = createPmTaskTelemetry({ findTurn });
const usageContext = { sessionKey: context.sessionKey };
const modelEvent = { runId: "model-1", usage: { input: 120, output: 30, cacheRead: 60, total: 210 }, prompt: "private prompt" };
await telemetry.output(modelEvent, usageContext); assert.equal(usages.length, 0);
telemetry.input(modelEvent, usageContext); await telemetry.output(modelEvent, usageContext);
await telemetry.output(modelEvent, usageContext); assert.equal(usages.length, 1);
assert.equal(usages[0].inputTokens, 120); assert.ok(!JSON.stringify(usages).includes("private prompt"));
telemetry.input({ runId: "late" }, usageContext); turn = { ...turn, acceptedId: "new", modelRunIds: undefined };
await telemetry.output({ ...modelEvent, runId: "late" }, usageContext); assert.equal(usages.length, 1);
telemetry.input({ runId: "silent-model" }, usageContext);
await telemetry.output({ runId: "silent-model", assistantTexts: ["NO_REPLY"] }, usageContext);
assert.equal(turn.silentReply, true, "core-suppressed NO_REPLY still completes the PM turn");
telemetry.input({ runId: "visible-model" }, usageContext);
await telemetry.output({ runId: "visible-model", assistantTexts: ["The plan needs a regression test."] }, usageContext);
assert.equal(turn.silentReply, false, "later visible output is not treated as silence");
console.log("PASS model usage: generation correlation, duplicate suppression and no prompt capture");

turn.taskRuntime = { ...runtime, actionPlan: { id: "plan-3", version: 3 }, actions: ["context", "approve_plan"] };
const decisions = [];
const decisionTools = createTaskTools({ context, findTurn, fetchImpl: async (_url, opts) => { if (opts.body) decisions.push(JSON.parse(opts.body)); return Response.json({ actionPlan: { id: "plan-3", version: 4 } }); } });
await decisionTools[1].execute("approve", {}); assert.equal(decisions[0].actionPlanVersion, 3);
await decisionTools[0].execute("read-new-plan", { section: "plan" });
await decisionTools[1].execute("approve-new", {}); assert.equal(decisions[1].actionPlanVersion, 4);
turn.taskRuntime = { ...turn.taskRuntime, actionPlan: null };
const missingPlan = createTaskTools({ context, findTurn, fetchImpl });
await assert.rejects(missingPlan[1].execute("missing-plan", {}), /Read the current plan/);
console.log("PASS plan decisions bind the viewed revision; omitted plans require a read first");

const { nativeTaskToolsSupported } = await import("../openclaw-pm-channel/task-backend.js");
const apiCfg = { agents: { defaults: { model: { primary: "openai/test", fallbacks: ["ollama/test"] } } } };
const cliCfg = { agents: { defaults: { model: { primary: "claude-cli/test", fallbacks: [] } } } };
assert.equal(nativeTaskToolsSupported(apiCfg), true);
assert.equal(nativeTaskToolsSupported(cliCfg), false);
assert.equal(nativeTaskToolsSupported({}), false);
assert.equal(nativeTaskToolsSupported({ agents: { defaults: { model: { primary: "openai/test", fallbacks: ["claude-cli/test"] } } } }), false);
assert.equal(nativeTaskToolsSupported({ ...apiCfg, models: { providers: { openai: { api: "claude-cli" } } } }), false);
assert.equal(nativeTaskToolsSupported({ agents: { defaults: apiCfg.agents.defaults, list: [{ id: "main", model: "claude-cli/test" }] } }), false);
assert.equal(nativeTaskToolsSupported({ agents: { defaults: { ...apiCfg.agents.defaults, cliBackends: { openai: {} } } } }), false);
assert.deepEqual(taskToolCapabilities(manifest, cliCfg), { taskRuntimeVersions: [], taskTools: [] });
assert.deepEqual(taskToolCapabilities(manifest, apiCfg).taskTools, PM_TASK_TOOL_NAMES);
console.log("PASS native capabilities follow the actual configured backend and fallback chain");

// PH-193: accepted terminal actions stop once; ordinary work and errors do not.
const { stopCompletedTaskTurn, isProtocolSilentReply } = await import("../openclaw-pm-channel/turn-completion.js");
let stopCalls = 0;
turn = { acceptedId: "terminal-generation", replyTarget: target, taskRuntime: runtime, finishTask: async () => { stopCalls++; } };
let outcome = { ok: true, actionEffect: "continue", turnComplete: false };
const terminalTools = createTaskTools({ context, findTurn, fetchImpl: async () => Response.json(outcome) });
await terminalTools[2].execute("checkpoint", { nextAction: "verify" });
assert.equal(stopCalls, 0);
outcome = { ok: true, actionEffect: "finish", turnComplete: true };
await terminalTools[0].execute("context-cannot-stop", {});
assert.equal(stopCalls, 0, "context content cannot authorize termination");
await terminalTools[1].execute("submit-terminal", { actionPlan: {} });
assert.equal(stopCalls, 1);
assert.equal(turn.completedAction, "submit_plan");
await assert.rejects(terminalTools[2].execute("after-finish", { nextAction: "unexpected" }), /completed/);
assert.equal(createTaskTools({ context, findTurn }), null);
turn = { acceptedId: "denied-generation", replyTarget: target, taskRuntime: runtime, finishTask: async () => { stopCalls++; } };
await createTaskTools({ context, findTurn, fetchImpl: async () => Response.json(outcome, { status: 409 }) })[1].execute("denied-terminal", { actionPlan: {} });
assert.equal(stopCalls, 1);
const lateTools = createTaskTools({ context, findTurn, fetchImpl: async () => { turn = { ...turn, acceptedId: "successor" }; return Response.json(outcome); } });
await lateTools[1].execute("late-terminal", { actionPlan: {} });
assert.equal(stopCalls, 1, "late old-generation response cannot stop its successor");
let active = { completedAction: "approve_plan" };
const original = active;
const aborts = [];
const harness = { resolveActiveEmbeddedRunSessionId: () => "native-session", abortAgentHarnessRun: (id) => { aborts.push(id); return true; } };
const stopArgs = { turn: original, sessionKey: "session-key", findTurn: () => active, loadHarness: async () => harness, logger: { warn() {} } };
assert.equal(await stopCompletedTaskTurn(stopArgs), true);
assert.deepEqual(aborts, ["native-session"]);
active = original;
await stopCompletedTaskTurn({ ...stopArgs, loadHarness: async () => { active = { completedAction: "new" }; return harness; } });
assert.equal(aborts.length, 1, "generation rechecked after SDK load");
active = original;
await stopCompletedTaskTurn({ ...stopArgs, loadHarness: async () => ({ ...harness, resolveActiveEmbeddedRunSessionId: async () => { active = { completedAction: "newer" }; return "native-session"; } }) });
assert.equal(aborts.length, 1, "generation rechecked after session resolution");
for (const text of ["NO_REPLY", "NO_REPLY.NO_REPLY", "PM_SILENT_NO_CONTRIBUTION"]) assert.equal(isProtocolSilentReply(text), true);
for (const text of ["", "The literal NO_REPLY is part of this explanation.", "Review finished."]) assert.equal(isProtocolSilentReply(text), false);
console.log("PASS terminal outcomes stop native execution, fence later tools and preserve successor generations");

// A CLI-backed canonical model must not advertise tools owned by the gateway.
const migratedCliCfg = { agents: { defaults: { model: { primary: "openai/test" }, models: {
  "anthropic/claude-fable-5-1": { agentRuntime: { id: "claude-cli" } },
} }, entries: { main: { model: { primary: "anthropic/claude-fable-5-1" } } } } };
assert.equal(nativeTaskToolsSupported(migratedCliCfg), false);
assert.deepEqual(taskToolCapabilities(manifest, migratedCliCfg).taskTools, []);
assert.equal(nativeTaskToolsSupported({ agents: { defaults: apiCfg.agents.defaults, entries: { main: { model: "openai/test" } } } }), true);
assert.equal(nativeTaskToolsSupported({ agents: { defaults: { model: { primary: "openai/test", fallbacks: ["anthropic/claude-fable-5-1"] }, models: migratedCliCfg.agents.defaults.models } } }), false);
console.log("PASS OpenClaw 2026.9 entries and canonical CLI runtime capability checks");

assert.equal(nativeTaskToolsSupported({ agents: { defaults: { model: { primary: "openai/gpt-6-astra" }, models: { "openai/gpt-6-astra": { agentRuntime: { id: "codex" } } } } } }), true, "Codex harness bridges native OpenClaw tools");

// Explicit notes use the same scoped endpoint as Claude CLI without completing
// or replacing the running turn. API-provider selection does not change routing.
for (const provider of ['openai', 'anthropic', 'ollama']) {
  turn = { acceptedId: `note-${provider}`, replyTarget: target, taskRuntime: { ...runtime, actions: ['task_note'] } };
  const sent = [];
  const [note] = createTaskTools({ context, findTurn, fetchImpl: async (url, options) => { sent.push({ url: String(url), body: JSON.parse(options.body) }); return Response.json({ ok: true, id: 'note-id' }); } });
  await note.execute('note', { category: 'finding', body: 'Verified coverage.' });
  assert.equal(sent[0].url, 'http://127.0.0.1:3000/api/agent/tasks/task-1/notes');
  assert.equal(sent[0].body.token, runtime.token);
  assert.equal(turn.completedAction, undefined);
}
console.log('PASS explicit task notes use scoped HTTP without completing the turn');
