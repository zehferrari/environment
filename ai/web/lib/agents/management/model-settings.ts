import path from "node:path";
import { rename, readFile, writeFile, open, unlink, lstat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KNOWN_MODEL_CAPABILITIES } from "./model-capabilities";
import { rotateProviderModel } from "./model-rotation";
import { readAgentIndex } from "./index-loader";
import { requestAgentRestart } from "@/lib/agents/ops/restart";
import { db } from "@/lib/db";
import { queueAgentRestart } from "@/lib/agents/ops/restart";

const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

type AgentModelEntry = { id?: string; default?: boolean; model?: string | { primary?: string; fallbacks?: string[] }; fallbacks?: string[] };

export type OpenClawConfig = {
  agents?: {
    defaults?: {
      model?: { primary?: string; fallbacks?: string[] };
      models?: Record<string, { alias?: string; agentRuntime?: { id: string } }>;
    };
    list?: AgentModelEntry[];
    entries?: Record<string, AgentModelEntry>;
  };
  models?: { providers?: Record<string, { apiKey?: string; api?: string; models?: Array<{ id?: string; name?: string; agentRuntime?: unknown }> }> };
};

export type AgentModelSettings = {
  revision?: string;
  readable: boolean;
  writablePath: string;
  active: string | null;
  defaultModel: string | null;
  fallbacks: string[];
  available: Array<{ id: string; label: string }>;
  error?: string;
};

export type AgentModelUpdateInput = {
  expectedRevision?: string;
  active?: string;
  defaultModel?: string;
  fallbacks?: string[];
};

export function configPath(agent: string) {
  if (!AGENT_RE.test(agent)) throw new Error("Invalid agent id");
  return path.join(process.env.PM_AGENT_CONFIG_ROOT ?? "/srv/agents/openclaw", agent, "openclaw.json");
}

function modelPrimary(model: unknown) {
  if (typeof model === "string") return model;
  if (model && typeof model === "object" && typeof (model as { primary?: unknown }).primary === "string") return (model as { primary: string }).primary;
  return null;
}

function modelFallbacks(model: unknown) {
  if (model && typeof model === "object" && Array.isArray((model as { fallbacks?: unknown }).fallbacks)) {
    return (model as { fallbacks: unknown[] }).fallbacks.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

function addConfiguredModel(labels: Map<string, string>, model: unknown) {
  const primary = modelPrimary(model);
  if (!primary) return;
  const id = primary.trim();
  if (!id || labels.has(id)) return;
  labels.set(id, `${id} · configured`);
}

function mainEntry(cfg: OpenClawConfig) {
  const entries = cfg.agents?.entries;
  return (entries && (Object.values(entries).find((entry) => entry.default) ?? entries.main))
    ?? cfg.agents?.list?.find((entry) => entry.default || entry.id === "main");
}

function collectAvailable(cfg: OpenClawConfig) {
  const labels = new Map<string, string>();
  for (const [id, meta] of Object.entries(cfg.agents?.defaults?.models ?? {})) labels.set(id, meta.alias ? `${meta.alias} · ${id}` : id);
  for (const [provider, providerCfg] of Object.entries(cfg.models?.providers ?? {})) {
    for (const model of providerCfg.models ?? []) {
      if (!model.id) continue;
      const id = model.id.includes("/") ? model.id : `${provider}/${model.id}`;
      labels.set(id, model.name ? `${model.name} · ${id}` : id);
    }
  }

  // Preserve already-configured values even when the local model registry is
  // incomplete/stale. Without this, saving only the current/default field can
  // fail because an existing fallback is not in the select list, and operators
  // cannot make a safe no-op save to recover settings.
  addConfiguredModel(labels, cfg.agents?.defaults?.model?.primary);
  for (const fallback of cfg.agents?.defaults?.model?.fallbacks ?? []) addConfiguredModel(labels, fallback);
  for (const entry of Object.values(cfg.agents?.entries ?? {}).concat(cfg.agents?.list ?? [])) {
    addConfiguredModel(labels, entry.model);
    for (const fallback of modelFallbacks(entry.model)) addConfiguredModel(labels, fallback);
    for (const fallback of entry.fallbacks ?? []) addConfiguredModel(labels, fallback);
  }

  return Array.from(labels, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function primaryFor(cfg: OpenClawConfig) {
  const main = mainEntry(cfg);
  return modelPrimary(main?.model) ?? cfg.agents?.defaults?.model?.primary ?? null;
}

function normalizeModel(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const model = value.trim();
  if (!model) throw new Error(`${field} cannot be empty`);
  if (model.length > 160) throw new Error(`${field} is too long`);
  return model;
}

function normalizeFallbacks(value: unknown) {
  if (!Array.isArray(value)) throw new Error("fallbacks must be an array");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const model = normalizeModel(item, "fallback model");
    if (seen.has(model)) continue;
    seen.add(model);
    out.push(model);
  }
  if (out.length > 12) throw new Error("fallbacks cannot contain more than 12 models");
  return out;
}

function assertAvailable(model: string, available: Set<string>, field: string) {
  if (!available.has(model)) throw new Error(`${field} is not in this agent's available model list`);
}

export function configRevision(raw: string) { return createHash("sha256").update(raw).digest("hex"); }

// Shared by the manual editor and provider rotation. cp preserves the existing
// permissions and ACL; a new default-mode temp file could expose config secrets.
async function writeConfigAtomically(file: string, cfg: OpenClawConfig, original: string) {
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    if (!(await lstat(file)).isFile()) throw new Error("Config must be a regular file");
    await promisify(execFile)("/usr/bin/cp", ["--preserve=all", "--", file, temp]);
    await writeFile(temp, JSON.stringify(cfg, null, 2) + "\n");
    if (await readFile(file, "utf8") !== original) throw new Error("Config changed; refresh and preview again");
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => undefined); }
}

async function withConfigLock<T>(agent: string, work: () => Promise<T>): Promise<T> {
  const lock = `${configPath(agent)}.model-update.lock`;
  const handle = await open(lock, "wx", 0o600).catch(() => { throw new Error("Another model update is in progress"); });
  try { return await work(); }
  finally { await handle.close(); await unlink(lock); }
}

export async function assertAgentIdle(agent: string) {
  const busy = await db.pmChannelRun.count({ where: { agentSlug: agent, status: { in: ["queued", "accepted", "streaming"] } } });
  if (busy) throw new Error(`${agent} has an active or queued PM run; retry when it finishes`);
}

export async function readAgentModelSettings(agent: string): Promise<AgentModelSettings> {
  const file = configPath(agent);
  try {
    const raw = await readFile(file, "utf8");
    const cfg = JSON.parse(raw) as OpenClawConfig;
    return {
      revision: configRevision(raw),
      readable: true,
      writablePath: file,
      active: primaryFor(cfg),
      defaultModel: cfg.agents?.defaults?.model?.primary ?? null,
      fallbacks: cfg.agents?.defaults?.model?.fallbacks ?? [],
      available: collectAvailable(cfg),
    };
  } catch (err) {
    return {
      readable: false,
      writablePath: file,
      active: null,
      defaultModel: null,
      fallbacks: [],
      available: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function updateAgentModelSettings(agent: string, input: AgentModelUpdateInput, actorUserId?: string | null) {
  return withConfigLock(agent, () => updateModelSettingsLocked(agent, input, actorUserId));
}

async function updateModelSettingsLocked(agent: string, input: AgentModelUpdateInput, actorUserId?: string | null) {
  const file = configPath(agent);
  const raw = await readFile(file, "utf8");
  if (input.expectedRevision && input.expectedRevision !== configRevision(raw)) throw new Error("Config changed; refresh and preview again");
  const cfg = JSON.parse(raw) as OpenClawConfig;
  const available = new Set(collectAvailable(cfg).map((entry) => entry.id));
  const before = {
    active: primaryFor(cfg),
    defaultModel: cfg.agents?.defaults?.model?.primary ?? null,
    fallbacks: cfg.agents?.defaults?.model?.fallbacks ?? [],
  };

  const next: AgentModelUpdateInput = {};
  if (Object.prototype.hasOwnProperty.call(input, "active")) {
    next.active = normalizeModel(input.active, "active model");
    assertAvailable(next.active, available, "active model");
  }
  if (Object.prototype.hasOwnProperty.call(input, "defaultModel")) {
    next.defaultModel = normalizeModel(input.defaultModel, "default model");
    assertAvailable(next.defaultModel, available, "default model");
  }
  if (Object.prototype.hasOwnProperty.call(input, "fallbacks")) {
    next.fallbacks = normalizeFallbacks(input.fallbacks);
    for (const fallback of next.fallbacks) assertAvailable(fallback, available, "fallback model");
  }
  if (!next.active && !next.defaultModel && !next.fallbacks) throw new Error("No model settings supplied");

  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.model ??= {};

  if (next.defaultModel) cfg.agents.defaults.model.primary = next.defaultModel;
  if (next.fallbacks) {
    cfg.agents.defaults.model.fallbacks = next.fallbacks;
    const main = mainEntry(cfg);
    if (main && modelPrimary(main.model)) main.model = { primary: modelPrimary(main.model)!, fallbacks: next.fallbacks };
  }
  if (next.active) {
    const main = mainEntry(cfg);
    if (main) {
      const currentFallbacks = modelFallbacks(main.model);
      const inheritedFallbacks = next.fallbacks ?? (currentFallbacks.length > 0 ? currentFallbacks : cfg.agents.defaults.model.fallbacks);
      main.model = { primary: next.active, fallbacks: inheritedFallbacks ?? [] };
    } else cfg.agents.defaults.model.primary = next.active;
  }

  const after = {
    active: primaryFor(cfg),
    defaultModel: cfg.agents.defaults.model.primary ?? null,
    fallbacks: cfg.agents.defaults.model.fallbacks ?? [],
  };

  if (JSON.stringify(before) === JSON.stringify(after)) return { before, after, restart: null, revision: configRevision(raw) };
  await assertAgentIdle(agent);
  await writeConfigAtomically(file, cfg, raw);
  const restart = queueAgentRestart(agent, `models:${before.active ?? "unset"}->${after.active ?? "unset"}`);
  await db.activityLog.create({
    data: {
      userId: actorUserId ?? undefined,
      kind: "agent.model.update",
      targetAgent: agent,
      targetFile: "openclaw.json",
      payload: JSON.stringify({ before, after, configPath: file, restart }),
    },
  });
  return { before, after, restart, revision: configRevision(JSON.stringify(cfg, null, 2) + "\n") };
}

export async function updateAgentActiveModel(agent: string, model: string, actorUserId?: string | null) {
  return updateAgentModelSettings(agent, { active: model }, actorUserId);
}

export async function previewAgentModelRotation(agent: string, provider: string, model: string) {
  const index = await readAgentIndex();
  if (!index.agents.some((a) => a.user === agent && a.enabled !== false)) throw new Error("Enabled agent not found");
  const settings = await readAgentModelSettings(agent);
  if (!settings.readable || !settings.revision) throw new Error("Cannot read agent model configuration");
  return { ...rotateProviderModel({ active: settings.active, defaultModel: settings.defaultModel, fallbacks: settings.fallbacks }, provider, model), revision: settings.revision };
}

export async function promoteAgentModel(agent: string, provider: string, model: string, revision: string, actorUserId?: string | null) {
  return withConfigLock(agent, async () => {
    const preview = await previewAgentModelRotation(agent, provider, model);
    if (preview.revision !== revision) throw new Error("Config changed; refresh and preview again");
    if (!preview.changed) return { ...preview, restart: null };
    await assertAgentIdle(agent);
    const file = configPath(agent);
    const raw = await readFile(file, "utf8");
    if (configRevision(raw) !== revision) throw new Error("Config changed; refresh and preview again");
    const cfg = JSON.parse(raw) as OpenClawConfig;
    const target = preview.after.defaultModel!;
    cfg.agents!.defaults!.models ??= {};
    const previousRuntime = cfg.agents!.defaults!.models![preview.before.defaultModel!]?.agentRuntime;
    cfg.agents!.defaults!.models![target] ??= {};
    if (previousRuntime) cfg.agents!.defaults!.models![target].agentRuntime ??= { ...previousRuntime };
    // Preserve the provider transport override without copying the old model's
    // context, price, or capability metadata onto a new model.
    const known = KNOWN_MODEL_CAPABILITIES[target];
    if (known) { cfg.models ??= {}; cfg.models.providers ??= {}; cfg.models.providers[provider] ??= { models: [] }; }
    const providerCfg = cfg.models?.providers?.[provider];
    if (providerCfg) {
      const id = target.slice(provider.length + 1);
      providerCfg.models ??= [];
      if (!providerCfg.models.some((m) => m.id === id || m.id === target)) {
        const oldId = preview.before.defaultModel!.slice(provider.length + 1);
        const old = providerCfg.models.find((m) => m.id === oldId || m.id === preview.before.defaultModel);
        providerCfg.models.push({ id, name: id, ...known, ...(old?.agentRuntime ? { agentRuntime: old.agentRuntime } : {}) });
      }
    }
    cfg.agents!.defaults!.model = { ...cfg.agents!.defaults!.model, primary: target, fallbacks: preview.after.fallbacks };
    const main = mainEntry(cfg);
    if (main) main.model = { primary: target, fallbacks: preview.after.fallbacks };
    await db.activityLog.create({ data: { kind: "agent.model.promotion.requested", targetAgent: agent, userId: actorUserId ?? undefined,
      payload: JSON.stringify({ provider, before: preview.before, after: preview.after, removed: preview.removed }) } });
    await writeConfigAtomically(file, cfg, raw);
    // Await the result: a saved config is not proof that its gateway restarted.
    const restart = await requestAgentRestart(agent, `model-promotion:${target}`, true);
    await db.activityLog.create({ data: { kind: "agent.model.update", targetAgent: agent, userId: actorUserId ?? undefined,
      payload: JSON.stringify({ provider, before: preview.before, after: preview.after, removed: preview.removed, restart }) } });
    return { ...preview, restart };
  });
}
