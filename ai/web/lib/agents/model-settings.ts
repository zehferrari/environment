import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
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

export async function updateAgentActiveModel(agent: string, model: string, actorUserId?: string | null) {
  const file = configPath(agent);
  const raw = await readFile(file, "utf8");
  const cfg = JSON.parse(raw) as OpenClawConfig;
  const before = primaryFor(cfg);
  const beforeFallbacks = cfg.agents?.defaults?.model?.fallbacks ?? [];
  const available = new Set(collectAvailable(cfg).map((entry) => entry.id));
  if (!available.has(model)) throw new Error("Model is not in this agent's available model list");
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.model ??= {};
  cfg.agents.defaults.model.primary = model;
  const main = cfg.agents.list?.find((entry) => entry.default || entry.id === "main");
  if (main && Object.prototype.hasOwnProperty.call(main, "model")) main.model = model;
  await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  const restart = await requestAgentRestart(agent, `model:${before ?? "unset"}->${model}`);
  await db.activityLog.create({
    data: {
      userId: actorUserId ?? undefined,
      kind: "agent.model.update",
      targetAgent: agent,
      targetFile: "openclaw.json",
      payload: JSON.stringify({ before, after: model, fallbacks: beforeFallbacks, configPath: file, restart }),
    },
  });
  return { before, after: model, restart };
}
