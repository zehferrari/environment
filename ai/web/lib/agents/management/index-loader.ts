import { readFile } from "fs/promises";

/**
 * Schema of the OpenClaw agent registry — only the fields PM reads in v1.
 * The file carries more; we tolerate extras silently.
 */
export type IndexListener = {
  host: string;
  port: number;
  owner: string;
  expected?: boolean;
};

export type IndexAgent = {
  user: string;
  uid?: number;
  name: string;
  enabled?: boolean;
  role: string;
  reasoning?: string | null;
  email?: string | null;
  avatar?: string | null;
  listeners?: IndexListener[];
};

export type AgentIndex = {
  version: number;
  codeOwner: string;
  codeGroup?: string;
  agents: IndexAgent[];
};

const INDEX_PATH = process.env.AGENT_INDEX_PATH ?? "/etc/openclaw/agents.json";
export const DEFAULT_AGENT_REASONING = "stream";
const AGENT_REASONING_VALUES = new Set(["on", "off", "stream"]);

export function normalizeAgentReasoning(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return AGENT_REASONING_VALUES.has(normalized) ? normalized : DEFAULT_AGENT_REASONING;
}

export async function readAgentIndex(path: string = INDEX_PATH): Promise<AgentIndex> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as AgentIndex;
  if (!parsed || !Array.isArray(parsed.agents)) {
    throw new Error(`Malformed agent index at ${path}: missing agents[]`);
  }
  return parsed;
}

/** Extract the openclaw-gateway port from a listener list, or undefined. */
export function gatewayPortFor(agent: IndexAgent): number | undefined {
  return agent.listeners?.find((l) => l.owner === "openclaw-gateway")?.port;
}
