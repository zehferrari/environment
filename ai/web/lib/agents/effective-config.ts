import { readFile } from "node:fs/promises";

export type ControlValue = boolean | string | number;

type Layer = {
  services?: unknown;
  capabilities?: unknown;
};

type AgentDefaults = {
  core?: Layer;
  byRole?: Record<string, Layer>;
  byIntegration?: Record<string, Layer>;
};

export type RawAgentConfig = {
  role?: string;
  integrations?: Record<string, boolean>;
  capabilities?: Record<string, ControlValue>;
  services?: string[];
  telegram?: { enabled?: boolean };
};

export type EffectiveAgentConfig = {
  integrations: Record<string, boolean>;
  capabilities: Record<string, ControlValue>;
  services: string[];
};

const DEFAULTS_PATH = process.env.AGENT_DEFAULTS_PATH ?? "/etc/openclaw/agent-defaults.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function boolRecord(value: unknown): Record<string, boolean> {
  if (!isRecord(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return out;
}

function controlRecord(value: unknown): Record<string, ControlValue> {
  if (!isRecord(value)) return {};
  const out: Record<string, ControlValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean" || typeof entry === "string" || typeof entry === "number") out[key] = entry;
  }
  return out;
}

export function parseRawAgentConfig(raw: string | null): RawAgentConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    return {
      role: typeof parsed.role === "string" ? parsed.role : undefined,
      integrations: boolRecord(parsed.integrations),
      capabilities: controlRecord(parsed.capabilities),
      services: stringArray(parsed.services),
      telegram: isRecord(parsed.telegram) ? { enabled: parsed.telegram.enabled === true } : undefined,
    };
  } catch {
    return {};
  }
}

async function readDefaults(): Promise<AgentDefaults> {
  try {
    const parsed = JSON.parse(await readFile(DEFAULTS_PATH, "utf8")) as unknown;
    return isRecord(parsed) ? parsed as AgentDefaults : {};
  } catch {
    return {};
  }
}

function mergeLayer(layer: Layer | undefined, services: Set<string>, capabilities: Record<string, ControlValue>) {
  for (const service of stringArray(layer?.services)) services.add(service);
  Object.assign(capabilities, controlRecord(layer?.capabilities));
}

export async function resolveEffectiveAgentConfig(
  rawJson: string | null,
  allAgentsJson?: (string | null)[]
): Promise<EffectiveAgentConfig> {
  const raw = parseRawAgentConfig(rawJson);
  const defaults = await readDefaults();
  const services = new Set<string>();
  const capabilities: Record<string, ControlValue> = {};

  mergeLayer(defaults.core, services, capabilities);
  if (raw.role) mergeLayer(defaults.byRole?.[raw.role], services, capabilities);
  for (const [integration, enabled] of Object.entries(raw.integrations ?? {})) {
    if (enabled) mergeLayer(defaults.byIntegration?.[integration], services, capabilities);
  }
  if (raw.telegram?.enabled) mergeLayer(defaults.byIntegration?.telegram, services, capabilities);

  for (const service of raw.services ?? []) services.add(service);
  Object.assign(capabilities, raw.capabilities ?? {});

  const activeIntegrations: Record<string, boolean> = {};
  if (allAgentsJson) {
    for (const json of allAgentsJson) {
      const a = parseRawAgentConfig(json);
      if (a.role === "coding") {
        for (const [k, on] of Object.entries(a.integrations ?? {})) {
          if (on) activeIntegrations[k] = true;
        }
      }
    }
  }

  const RECEIVER_RE = /^openclaw-([a-z0-9-]+)-receiver\.service$/;
  const filteredServices = Array.from(services).filter((s) => {
    const m = s.match(RECEIVER_RE);
    if (!m) return true;
    const gate = m[1];
    if (!raw.integrations?.[gate] || !raw.integrations?.monitor) return false;
    if (raw.role === "monitor" && !activeIntegrations[gate]) return false;
    return true;
  });

  return {
    integrations: raw.integrations ?? {},
    capabilities,
    services: filteredServices,
  };
}
