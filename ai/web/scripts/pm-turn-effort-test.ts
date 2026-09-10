import assert from "node:assert/strict";
import { taskEffortPolicy } from "../lib/agents/pm-channel/turn-effort";
import { selectPmEffort, resolvePmTurnEffort, withPmHighDefault } from "../openclaw-pm-channel/turn-effort.js";
import { buildPmChannelIngressPayload } from "../lib/agents/pm-channel/openclaw";

async function main() {
  const task = { status: "Backlog", approvedOn: null as Date | null, assigneeId: "worker", actingManagerId: "reviewer", reporterId: "owner", epic: null };
  assert.deepEqual(taskEffortPolicy(task, "worker"), { mode: "manager", reason: "planning" });
  assert.deepEqual(taskEffortPolicy(task, "reviewer"), { mode: "manager", reason: "review" });
  assert.equal(taskEffortPolicy({ ...task, status: "In Progress", approvedOn: new Date() }, "worker").mode, "normal");
  assert.equal(taskEffortPolicy({ ...task, status: "Review" }, "reviewer").reason, "review");
  assert.equal(taskEffortPolicy({ ...task, status: "Review" }, "worker").mode, "normal");
  assert.equal(taskEffortPolicy({ ...task, actingManagerId: null, epic: { status: "In Progress", actingManagerId: "epic-manager" } }, "epic-manager").mode, "manager");
  assert.equal(taskEffortPolicy(task, "unrelated").mode, "normal");
  assert.equal(selectPmEffort("manager", ["high", "xhigh", "max"]), "xhigh");
  assert.equal(selectPmEffort("manager", ["high", "max"]), "max");
  assert.equal(selectPmEffort("manager", ["off", "high"]), "high");
  assert.equal(selectPmEffort("manager", ["off"]), null);
  assert.equal(selectPmEffort("normal", ["high", "xhigh", "max"]), "high");
  assert.equal(selectPmEffort("manager", ["off", "high", "max"], "ollama"), "high");
  const cfg = { agents: { defaults: { thinkingDefault: "low", model: { primary: "openai/model" } }, list: [{ id: "main", thinkingDefault: "xhigh" }, { id: "aux", thinkingDefault: "low" }] } };
  const cloned = withPmHighDefault(cfg, "main");
  assert.equal(cfg.agents.list[0].thinkingDefault, "xhigh");
  assert.equal(cloned.agents.list[0].thinkingDefault, "high");
  assert.equal(cloned.agents.list[1].thinkingDefault, "low");
  const sessionKey = "agent:main:pm:test";
  const logs: string[] = [];
  const logger = { info: (s: string) => logs.push(s), warn: (s: string) => logs.push(s) };
  let levels = ["high", "xhigh", "max"];
  let session = false;
  const runtime = { gateway: { request: async (_method: string, params: Record<string, unknown>) => {
    assert.equal(params.includeLastMessage, false);
    return { defaults: { thinkingLevels: levels.map((id) => ({ id })) }, sessions: session ? [{ key: sessionKey, thinkingLevels: [{ id: "high" }, { id: "max" }] }] : [] };
  } } };
  assert.deepEqual(await resolvePmTurnEffort({ runtime, cfg, agentId: "main", sessionKey, policy: { mode: "manager" }, logger }), { thinkingLevelOverride: "xhigh" });
  // A later normal turn in the same session must explicitly return to High.
  assert.deepEqual(await resolvePmTurnEffort({ runtime, cfg, agentId: "main", sessionKey, policy: { mode: "normal" }, logger }), { thinkingLevelOverride: "high" });
  session = true;
  assert.deepEqual(await resolvePmTurnEffort({ runtime, cfg, agentId: "main", sessionKey, policy: { mode: "manager" }, logger }), { thinkingLevelOverride: "max" });
  session = false; levels = ["off"];
  assert.deepEqual(await resolvePmTurnEffort({ runtime, cfg, agentId: "main", sessionKey, policy: { mode: "manager" }, logger }), {});
  const failingRuntime = { gateway: { request: async () => { throw new Error("unsupported API"); } } };
  assert.deepEqual(await resolvePmTurnEffort({ runtime: failingRuntime, cfg, agentId: "main", sessionKey, policy: { mode: "manager" }, logger }), {});
  const claudeCfg = { agents: { defaults: { model: { primary: "claude-cli/claude-fable-5-1" }, cliBackends: { "claude-cli": { command: "claude", env: { CLAUDE_CODE_EFFORT_LEVEL: "high", KEEP: "yes" } } } } }, models: { providers: { "claude-cli": { models: [{ id: "claude-fable-5-1", compat: { supportedReasoningEfforts: ["high", "xhigh", "max"] } }] } } } };
  const claudeRuntime = { gateway: { request: async () => ({ defaults: { modelProvider: "claude-cli", model: "claude-fable-5-1", thinkingLevels: [{ id: "off" }] }, sessions: [] }) } };
  assert.deepEqual(await resolvePmTurnEffort({ runtime: claudeRuntime, cfg: claudeCfg, agentId: "main", sessionKey, policy: { mode: "manager" }, logger }), { cliEffort: "xhigh" });
  const managerCfg = withPmHighDefault(claudeCfg, "main", "xhigh");
  assert.equal(managerCfg.agents.defaults.cliBackends["claude-cli"].env.CLAUDE_CODE_EFFORT_LEVEL, "xhigh");
  assert.equal(managerCfg.agents.defaults.cliBackends["claude-cli"].env.KEEP, "yes");
  assert.equal(claudeCfg.agents.defaults.cliBackends["claude-cli"].env.CLAUDE_CODE_EFFORT_LEVEL, "high");
  assert.equal(withPmHighDefault(managerCfg, "main").agents.defaults.cliBackends["claude-cli"].env.CLAUDE_CODE_EFFORT_LEVEL, "high");
  assert.deepEqual(await resolvePmTurnEffort({ runtime: claudeRuntime, cfg: claudeCfg, agentId: "main", sessionKey, policy: { mode: "normal" }, logger }), { cliEffort: "high" });
  const payload = buildPmChannelIngressPayload({ agentSlug: "test", gatewayPort: 1, sessionKey, kind: "direct", text: "hello", actor: { id: "owner", kind: "human" }, replyTarget: { kind: "direct", agentSlug: "test", messageId: "m" }, effortPolicy: { mode: "manager", reason: "review" } }, "http");
  assert.deepEqual(payload.effortPolicy, { mode: "manager", reason: "review" });
  console.log("PASS: planning/review/implementation roles, inherited manager, xHigh→Max→High selection, runtime metadata, per-turn reset and ingress policy");
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
