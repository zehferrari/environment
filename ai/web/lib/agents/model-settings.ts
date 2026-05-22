import path from "node:path";
import { rename, readFile, writeFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { requestAgentRestart } from "@/lib/agents/restart";

const AGENT_RE = /^[a-z][a-z0-9_-]{0,31}$/;

type OpenClawConfig = {
  agents?: {
    defaults?: {
      model?: { primary?: string; fallbacks?: string[] };
      models?: Record<string, { alias?: string }>;
    };
    list?: Array<{ id?: string; default?: boolean; model?: string; fallbacks?: string[] }>;
  };
  models?: { providers?: Record<string, { models?: Array<{ id?: string; name?: string }> }> };
};

export type AgentModelSettings = {
  readable: boolean;
  writablePath: string;
  active: string | null;
  defaultModel: string | null;
  fallbacks: string[];
  available: Array<{ id: string; label: string }>;
  error?: string;
};

export type AgentModelUpdateInput = {
  active?: string;
  defaultModel?: string;
  fallbacks?: string[];
};

function configPath(agent: string) {
  if (!AGENT_RE.test(agent)) throw new Error("Invalid agent id");
  return path.join("/srv/agents/openclaw", agent, "openclaw.json");
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
  return Array.from(labels, ([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
}

function primaryFor(cfg: OpenClawConfig) {
  const main = cfg.agents?.list?.find((entry) => entry.default || entry.id === "main");
  return main?.model ?? cfg.agents?.defaults?.model?.primary ?? null;
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

async function writeConfigAtomically(file: string, cfg: OpenClawConfig) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  // Parse the exact bytes before replacing the live config. This prevents a
  // malformed JSON write from taking the agent/PM process down on reload.
  JSON.parse(await readFile(tmp, "utf8"));
  await rename(tmp, file);
}

export async function readAgentModelSettings(agent: string): Promise<AgentModelSettings> {
  const file = configPath(agent);
  try {
    const raw = await readFile(file, "utf8");
    const cfg = JSON.parse(raw) as OpenClawConfig;
    return {
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
  const file = configPath(agent);
  const raw = await readFile(file, "utf8");
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
  if (next.fallbacks) cfg.agents.defaults.model.fallbacks = next.fallbacks;
  if (next.active) {
    const main = cfg.agents.list?.find((entry) => entry.default || entry.id === "main");
    if (main) main.model = next.active;
    else cfg.agents.defaults.model.primary = next.active;
  }

  const after = {
    active: primaryFor(cfg),
    defaultModel: cfg.agents.defaults.model.primary ?? null,
    fallbacks: cfg.agents.defaults.model.fallbacks ?? [],
  };

  await writeConfigAtomically(file, cfg);
  const restart = await requestAgentRestart(agent, `models:${before.active ?? "unset"}->${after.active ?? "unset"}`);
  await db.activityLog.create({
    data: {
      userId: actorUserId ?? undefined,
      kind: "agent.model.update",
      targetAgent: agent,
      targetFile: "openclaw.json",
      payload: JSON.stringify({ before, after, configPath: file, restart }),
    },
  });
  return { before, after, restart };
}

export async function updateAgentActiveModel(agent: string, model: string, actorUserId?: string | null) {
  return updateAgentModelSettings(agent, { active: model }, actorUserId);
}
