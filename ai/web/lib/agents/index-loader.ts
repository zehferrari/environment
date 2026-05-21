import { readFile } from "fs/promises";

/**
 * Schema of /srv/agents/index.json — only the fields PM reads in v1.
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

const INDEX_PATH = process.env.AGENT_INDEX_PATH ?? "/srv/agents/index.json";

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
