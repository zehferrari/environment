/**
 * Agent provisioning helpers — single source of truth for the *content* the
 * privileged helper places on disk when an agent is created or edited.
 *
 * Layering (route-centric provisioning):
 *   - This module (runs as the PM web user) renders file *content* and computes
 *     UID/port allocation + the registry entry. It performs no privileged I/O.
 *   - `openclaw-manage-user` (root, invoked via sudo) receives the rendered
 *     payload and does every privileged step: useradd, home/Samba/sudoers, file
 *     placement with the right ownership, gateway + PM-channel install, and the
 *     atomic registry write.
 *
 * Keeping the generators here (rather than in the always-listening dashboard)
 * means the model catalog lives next to the UI's model picker and is unit-
 * testable without root.
 */

export type AgentRole = "coding" | "monitor";

export type ProvisionListener = {
  host: string;
  port: number;
  owner: string;
  expected: boolean;
};

export type RenderedAgentFiles = {
  soul: string;
  identity: string;
  tools: string;
  memory: string;
  heartbeat: string;
  openclawJson: string;
};

export type AgentRegistryEntry = {
  user: string;
  uid: number;
  name: string;
  enabled: boolean;
  role: AgentRole;
  home: string;
  workspace: string;
  email: string;
  avatar: string;
  telegram: { enabled: boolean; bot: string };
  integrations: { gmail: boolean; jira: boolean; bitbucket: boolean };
  listeners: ProvisionListener[];
};

export function capitalize(user: string): string {
  return user.charAt(0).toUpperCase() + user.slice(1);
}

export function workspaceFor(user: string, role: AgentRole): string {
  return role === "monitor" ? `/home/${user}/.openclaw/workspace` : `/home/${user}/workspace`;
}

export function avatarPathFor(user: string): string {
  return `/srv/agents/Pictures/${capitalize(user)}/avatar.png`;
}

/** Lowest free UID >= 1001 not already present in the registry. */
export function allocateUid(agents: Array<{ uid?: number }>): number {
  const used = new Set(agents.map((a) => Number(a.uid)).filter((n) => Number.isFinite(n)));
  let uid = 1001;
  while (used.has(uid)) uid++;
  return uid;
}

/**
 * Allocate gateway (+ browser sidecar for coding agents) ports, mirroring the
 * historical dashboard behaviour so existing agents keep their port range.
 */
export function allocatePorts(
  agents: Array<{ listeners?: Array<{ port?: number }> }>,
  role: AgentRole,
): { listeners: ProvisionListener[]; gatewayPort: number } {
  const ports: number[] = [];
  for (const a of agents) {
    for (const l of a.listeners ?? []) {
      if (l.port) ports.push(Number(l.port));
    }
  }
  let gw = 18789;
  while (ports.includes(gw)) gw++;
  let bs = gw + 1;
  while (ports.includes(bs) || bs === gw) bs++;

  const listeners: ProvisionListener[] = [
    { host: "127.0.0.1", port: gw, owner: "openclaw-gateway", expected: true },
  ];
  if (role === "coding") {
    listeners.push({ host: "127.0.0.1", port: bs, owner: "browser sidecar", expected: true });
  }
  return { listeners, gatewayPort: gw };
}

export function renderSoul(name: string, user: string, role: AgentRole, email: string): string {
  return `# SOUL.md - Who You Are

You are ${name}. You are a DevOps, code engineer, and architect solution expert.

## Persona

- Sharp, analytical, highly structured, pragmatic, and clear.
- Decisive, experienced in production environments, values observability, systems resilience, automation, and clean build/CI/CD pipelines.
- Expected to maintain high standards of code architecture and system robustness.

## Default Role

${name} defaults to a **${role}** role (see \`ROLES.md\` § Developer / Manager).

## Workflow

\`AGENTS.md\` (always-on rules + baseline), \`ROLES.md\` (role behaviour), and \`TEAM_WORKFLOW.md\` (action-indexed playbook) win on process and rules. This file only defines personality and default role.

## Identity

- Name: ${name}.
- Short name: ${user}.
- Email: ${email}.
- Human: zeh.
- Workspace: ${workspaceFor(user, role)}.
`;
}

export function renderIdentity(name: string, user: string, email: string, role: AgentRole): string {
  const isMonitor = role === "monitor";
  return `# IDENTITY.md - Who Am I?

- Name: ${name}.
- Short name: ${user}.
- Email: ${email}.
- Human: zeh.
- Timezone: Australia/Brisbane.
- Workspace: /home/${user}/${isMonitor ? ".openclaw/workspace" : "workspace"}.
- Avatar: \`${avatarPathFor(user)}\` (also published at \`/agents/avatars/${capitalize(user)}\` behind dashboard auth).

## Team Role

- ${isMonitor ? "Monitor, triage, and incident remediation expert." : "DevOps, senior code engineer, and architect solution expert."}
- Tuned for ${isMonitor ? "monitoring, alerts triage, and systems recovery." : "cloud infrastructure, system design, CI/CD, automation, systems resilience, and architectural reviews."}

## Working Style

- Analytical, sharp, pragmatic, and detail-oriented.
- Value solid system design, robust automation, observability, and clean build pipelines.

## Workflow Source

\`AGENTS.md\` (boot manifest) + \`ROLES.md\` (role behaviour) +
\`TEAM_WORKFLOW.md\` (action-indexed playbook) define task handling, Jira
workflow, delegation, review, communication, signature, and memory rules.
`;
}

export function renderTools(): string {
  return `# TOOLS.md - Local Notes

Skills define _how_ tools work. This file is for _your_ specifics — the stuff that's unique to your setup.

## What Goes Here

Things like:
- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

---

Add whatever helps you do your job. This is your cheat sheet.

## SSH Hosts

- **moonlight** → 10.0.0.10, user: root
  - Samsung laptop (NP900X4C), i7-3537U, 16GB RAM, 256GB SSD
  - Debian 12 bookworm
  - nginx, MariaDB, PHP, memcached, unbound DNS
  - Hosts: zeh.me, eurekafiles.com, rachaelsmith.net.au, vixi.au, etc.
`;
}

export function renderMemory(): string {
  return `# MEMORY

## PM workflow policy (Zero Latency / PM tasks)
- Backlog assignments are for planning/opinions only. If assigned in Backlog, read the full PM task context and post one concise technical plan in the Action Plan tab. Do not change status and do not start work.
- To Do is executable only after the Action Plan is approved. If \`approved_on\` is empty, post the technical Action Plan and wait for reviewer/reporter approval. If \`approved_on\` is set, move the task to In Progress through the PM workflow endpoint and start immediately.
- Reviewers/reporters approve acceptable Action Plans through the PM workflow endpoint with \`action=approve_plan\`. Do not start implementation before this approval.
- Move completed implementation from In Progress to Review through the PM workflow endpoint with one concise ready-for-review note.
- Review is for completed-work review. The resolved reviewer is task acting manager, then Open Epic acting manager, then task reporter. If satisfied, call \`action=review_done\` without posting an approval-only comment; PM will move the task to Done, assign the next To Do task in the Epic when one exists, and wake the assignee. If changes/blockers remain, call \`action=review_feedback\` with concise feedback.
- Golden rule: if there is no new information, action result, plan, feedback, blocker, or necessary question, stay silent.
- Tasks under an Epic are actionable only when that Epic is Open.
- These PM rules are separate from Jira rules.
`;
}

/** Static model catalog written into every agent's openclaw.json. */
const MODEL_PROVIDERS = {
  "google-gravity": {
    baseUrl: "https://gravity.googleapis.com",
    apiKey: "google-gravity-oauth",
    auth: "oauth",
    api: "google-generative-ai",
    models: [
      { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash high", api: "google-generative-ai", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1048576, maxTokens: 8192 },
      { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro High", api: "google-generative-ai", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 2000000, maxTokens: 8192 },
      { id: "claude-opus-4.6", name: "Claude Opus 4.6", api: "google-generative-ai", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 },
      { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", api: "google-generative-ai", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 },
    ],
  },
  "openai-codex": {
    baseUrl: "https://chatgpt.com/backend-api/v1",
    apiKey: "codex-app-server",
    auth: "token",
    api: "openai-codex-responses",
    models: [
      { id: "gpt-5.5", name: "gpt-5.5", api: "openai-codex-responses", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000 },
    ],
  },
  ollama: {
    baseUrl: "http://127.0.0.1:11434",
    apiKey: "ollama-local",
    api: "ollama",
    models: [
      { id: "gemma4:31b-cloud", name: "gemma4:31b-cloud", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000 },
      { id: "nemotron-3-ultra:cloud", name: "nemotron-3-ultra:cloud", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000 },
    ],
  },
} as const;

const MODEL_ALIASES = {
  "google-gravity/gemini-3.5-flash": { alias: "Gemini 3.5 Flash high" },
  "google-gravity/gemini-3.1-pro": { alias: "Gemini 3.1 Pro High" },
  "google-gravity/claude-opus-4.6": { alias: "Claude Opus 4.6" },
  "google-gravity/claude-sonnet-4.6": { alias: "Claude Sonnet 4.6" },
  "ollama/gemma4:31b-cloud": { alias: "gemma4:31b-cloud" },
  "ollama/nemotron-3-ultra:cloud": { alias: "nemotron-3-ultra:cloud" },
} as const;

export function renderOpenClawJson(
  name: string,
  user: string,
  email: string,
  primary: string,
  fallbacks: string[],
  provider: string,
  now: string = new Date().toISOString(),
): string {
  const config = {
    meta: { lastTouchedVersion: "2026.5.22", lastTouchedAt: now },
    wizard: { lastRunAt: now, lastRunVersion: "2026.5.22", lastRunCommand: "configure", lastRunMode: "local" },
    auth: {
      profiles: {
        [`${provider}:default`]: {
          provider,
          mode: provider === "google-gravity" ? "oauth" : "token",
          email,
        },
      },
    },
    models: { mode: "merge", providers: MODEL_PROVIDERS },
    agents: {
      defaults: {
        model: { primary, fallbacks },
        models: MODEL_ALIASES,
        workspace: `/home/${user}/workspace`,
        compaction: { mode: "safeguard" },
        typingIntervalSeconds: 2,
        typingMode: "message",
      },
    },
  };
  return JSON.stringify(config, null, 2) + "\n";
}

export function renderAgentFiles(args: {
  name: string;
  user: string;
  role: AgentRole;
  email: string;
  provider: string;
  primaryModel: string;
  fallbackModels: string[];
}): RenderedAgentFiles {
  return {
    soul: renderSoul(args.name, args.user, args.role, args.email),
    identity: renderIdentity(args.name, args.user, args.email, args.role),
    tools: renderTools(),
    memory: renderMemory(),
    heartbeat: "# HEARTBEAT.md\n",
    openclawJson: renderOpenClawJson(
      args.name,
      args.user,
      args.email,
      args.primaryModel,
      args.fallbackModels,
      args.provider,
    ),
  };
}

export function buildAgentEntry(args: {
  user: string;
  uid: number;
  name: string;
  role: AgentRole;
  email: string;
  telegram?: { enabled?: boolean; bot?: string } | null;
  integrations?: { gmail?: boolean; jira?: boolean; bitbucket?: boolean } | null;
  listeners: ProvisionListener[];
}): AgentRegistryEntry {
  return {
    user: args.user,
    uid: args.uid,
    name: args.name,
    enabled: true,
    role: args.role,
    home: `/home/${args.user}`,
    workspace: workspaceFor(args.user, args.role),
    email: args.email,
    avatar: avatarPathFor(args.user),
    telegram: {
      enabled: args.telegram?.enabled ?? false,
      bot: args.telegram?.bot ?? "",
    },
    integrations: {
      gmail: args.integrations?.gmail ?? false,
      jira: args.integrations?.jira ?? false,
      bitbucket: args.integrations?.bitbucket ?? false,
    },
    listeners: args.listeners,
  };
}
