import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { rotateProviderModel, modelReference } from "../lib/agents/management/model-rotation";

async function main() {
  const base = { active: "openai/old", defaultModel: "openai/old", fallbacks: ["openai/second", "ollama/keep-one", "openai/last", "ollama/keep-two"] };
  const rotated = rotateProviderModel(base, "openai", "new");
  assert.deepEqual(rotated.after.fallbacks, ["openai/old", "openai/second", "ollama/keep-one", "ollama/keep-two"]);
  assert.equal(rotated.removed, "openai/last");
  assert.equal(rotateProviderModel(rotated.after, "openai", "new").changed, false);
  assert.deepEqual(rotateProviderModel(base, "openai", "second").after.fallbacks, ["openai/old", "ollama/keep-one", "ollama/keep-two"]);
  assert.deepEqual(rotateProviderModel({ ...base, fallbacks: ["ollama/only"] }, "openai", "new").after.fallbacks, ["openai/old", "ollama/only"]);
  assert.throws(() => rotateProviderModel({ ...base, active: "claude-cli/opus" }, "openai", "new"), /providers differ/);
  assert.throws(() => rotateProviderModel(base, "claude-cli", "new"), /does not belong/);
  assert.equal(modelReference("openrouter", "vendor/model"), "openrouter/vendor/model");
  assert.throws(() => modelReference("openai", "$(oops)"), /Invalid/);
  const claude = rotateProviderModel({ active: "claude-cli/opus", defaultModel: "claude-cli/opus", fallbacks: ["anthropic/keep", "claude-cli/old", "ollama/keep"] }, "claude-cli", "fable");
  assert.deepEqual(claude.after.fallbacks, ["claude-cli/opus", "anthropic/keep", "ollama/keep"]);

  // Real filesystem writes; stub only DB and restart transport so this suite
  // cannot touch the host registry, live database, or running services.
  const root = await mkdtemp(path.join(os.tmpdir(), "pm-model-rotation-"));
  const originalFetch = globalThis.fetch;
  delete process.env.DATABASE_URL;
  process.env.PM_AGENT_CONFIG_ROOT = root;
  process.env.AGENT_INDEX_PATH = path.join(root, "agents.json");
  process.env.AGENT_DEFAULTS_PATH = path.join(root, "defaults.json");
  await writeFile(process.env.AGENT_INDEX_PATH, JSON.stringify({ agents: [{ user: "test", enabled: true }] }));
  await mkdir(path.join(root, "test"));
  const file = path.join(root, "test/openclaw.json");
  const aux = { id: "google-workspace", model: "ollama/untouched" };
  const cfg = { agents: { defaults: { model: { primary: base.defaultModel, fallbacks: base.fallbacks }, models: { "openai/old": { agentRuntime: { id: "codex" } } } }, list: [{ id: "main", model: { primary: base.active, fallbacks: base.fallbacks } }, aux] },
    models: { providers: { openai: { apiKey: "FAKE_SECRET", models: [{ id: "old", name: "old", contextWindow: 999, agentRuntime: { id: "codex" } }] } } }, unrelated: { secret: "KEEP_PRIVATE" } };
  await writeFile(file, JSON.stringify(cfg), { mode: 0o640 });
  const { db } = await import("../lib/db");
  let busy = 0;
  const logs: unknown[] = [];
  Object.assign(db.pmChannelRun, { count: async () => busy });
  Object.assign(db.activityLog, { create: async (data: unknown) => { logs.push(data); return {}; } });
  Object.assign(db.agent, { findUnique: async () => null, findMany: async () => [] });
  let restarts = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.ok(url.startsWith("http://127.0.0.1:3013/"), "unexpected network request");
    if (url.endsWith("/restart")) restarts++;
    return new Response(JSON.stringify({ agents: {} }), { status: 200 });
  };
  const { previewAgentModelRotation, promoteAgentModel } = await import("../lib/agents/management/model-settings");
  try {
    const preview = await previewAgentModelRotation("test", "openai", "new");
    busy = 1;
    await assert.rejects(promoteAgentModel("test", "openai", "new", preview.revision), /active or queued/);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), cfg);
    busy = 0;
    await assert.rejects(promoteAgentModel("test", "openai", "new", "stale"), /Config changed/);
    await writeFile(`${file}.model-update.lock`, "");
    await assert.rejects(promoteAgentModel("test", "openai", "new", preview.revision), /in progress/);
    await rm(`${file}.model-update.lock`);
    await promoteAgentModel("test", "openai", "new", preview.revision);
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(after.agents.defaults.model, { primary: "openai/new", fallbacks: rotated.after.fallbacks });
    assert.deepEqual(after.agents.list[0].model, after.agents.defaults.model);
    assert.deepEqual(after.agents.defaults.models["openai/new"].agentRuntime, { id: "codex" });
    assert.deepEqual(after.agents.list[1], aux);
    assert.deepEqual(after.unrelated, cfg.unrelated);
    assert.equal(after.models.providers.openai.apiKey, "FAKE_SECRET");
    assert.deepEqual(after.models.providers.openai.models[1], { id: "new", name: "new", agentRuntime: { id: "codex" } });
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    assert.equal(restarts, 1);
    const again = await previewAgentModelRotation("test", "openai", "new");
    await promoteAgentModel("test", "openai", "new", again.revision);
    assert.equal(restarts, 1);
    assert.ok(!JSON.stringify(logs).includes("FAKE_SECRET"));
    assert.ok(!JSON.stringify(logs).includes("KEEP_PRIVATE"));
    await assert.rejects(promoteAgentModel("test", "openai", "third", preview.revision), /Config changed/);
    // Migrated keyed agents must change their actual override as well as defaults.
    const keyed = { ...cfg, agents: { defaults: cfg.agents.defaults, entries: { main: cfg.agents.list[0], auxiliary: aux } } };
    await writeFile(file, JSON.stringify(keyed));
    const keyedPreview = await previewAgentModelRotation("test", "openai", "new");
    await promoteAgentModel("test", "openai", "new", keyedPreview.revision);
    const keyedAfter = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(keyedAfter.agents.entries.main.model, keyedAfter.agents.defaults.model);
    assert.deepEqual(keyedAfter.agents.entries.auxiliary, aux);
    assert.equal(keyedAfter.agents.list, undefined);
    console.log("PASS: provider rotation, no-op, namespaces, busy/stale/lock guards, config preservation, permissions, restart and audit redaction");
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); await db.$disconnect(); }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
