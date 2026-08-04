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

import net from "node:net";
import { getProvider } from "./providers";

export type AgentRole = "coding" | "monitor";

/** A model the admin ticked as available to the agent, with its provider. */
export type SelectedModel = { provider: string; id: string; name?: string };

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
  reasoning: string;
  home: string;
  workspace: string;
  email: string;
  avatar: string;
  telegram: { enabled: boolean; bot: string };
  integrations: { gmail: boolean; jira: boolean; bitbucket: boolean; maildir: boolean };
  profileImages?: {
    theme: string;
    customizationMode?: string;
    gender?: string;
    ageGroup?: string;
    ethnicity?: string;
    prompt?: string;
    username?: string;
    fullName?: string;
    bio?: string;
  };
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
 * Allocate gateway (+ browser sidecar for coding agents) ports.
 *
 * A coding agent's OpenClaw gateway also binds an opt-in local browser/control
 * listener at gatewayPort + 2. Treat both as one allocation unit and prove the
 * required candidate ports are bindable before committing them to the
 * registry. Monitor agents only advertise their gateway listener.
 */
export async function allocatePorts(
  agents: Array<{ listeners?: Array<{ port?: number; owner?: string }> }>,
  role: AgentRole,
): Promise<{ listeners: ProvisionListener[]; gatewayPort: number }> {
  const ports = new Set<number>();
  for (const a of agents) {
    for (const l of a.listeners ?? []) {
      const port = Number(l.port);
      if (Number.isFinite(port)) {
        ports.add(port);
        if (l.owner === "openclaw-gateway") ports.add(browserPortForGateway(port));
      }
    }
  }

  for (let gw = 18789; gw <= 19999; gw++) {
    const bs = browserPortForGateway(gw);
    if (ports.has(gw) || ports.has(bs)) continue;
    const requiredPorts = role === "coding" ? [gw, bs] : [gw];
    if (!(await areLoopbackPortsAvailable(requiredPorts))) continue;

    const listeners: ProvisionListener[] = [
      { host: "127.0.0.1", port: gw, owner: "openclaw-gateway", expected: true },
    ];
    if (role === "coding") {
      listeners.push(
        { host: "127.0.0.1", port: bs, owner: "browser sidecar", expected: true },
      );
    }
    return { listeners, gatewayPort: gw };
  }

  throw new Error(`No free OpenClaw gateway port pair found for role ${role}`);
}

function browserPortForGateway(gatewayPort: number): number {
  return gatewayPort + 2;
}

async function areLoopbackPortsAvailable(ports: number[]): Promise<boolean> {
  for (const port of ports) {
    if (!(await isLoopbackPortAvailable(port))) return false;
  }
  return true;
}

async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  const checks = await Promise.all([
    canBindPort(port, "127.0.0.1"),
    canBindPort(port, "::1"),
  ]);
  return checks.every(Boolean);
}

function canBindPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
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
- Human: Mission Control owner.
- Workspace: ${workspaceFor(user, role)}.
`;
}

export function renderIdentity(name: string, user: string, email: string, role: AgentRole): string {
  const isMonitor = role === "monitor";
  return `# IDENTITY.md - Who Am I?

- Name: ${name}.
- Short name: ${user}.
- Email: ${email}.
- Human: Mission Control owner.
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

`;
}

export function renderMemory(): string {
  return `# MEMORY

## PM workflow policy (Mission Control / PM tasks)
- Backlog assignments are for planning/opinions only. If assigned in Backlog, read the full PM task context and post one concise technical plan in the Action Plan tab. Do not change status and do not start work.
- To Do is executable only after the Action Plan is approved. If \`approved_on\` is empty, post the technical Action Plan and wait for reviewer/reporter approval. Structure Action Plans as independent, parallelizable checklist items where useful; do not split small or strictly sequential/dependent work. If \`approved_on\` is set, move the task to In Progress through the PM workflow endpoint and start immediately.
- Reviewers/reporters approve acceptable Action Plans through the PM workflow endpoint with \`action=approve_plan\`. If a plan could be safely split into independent sub-tasks, flag that in consolidated feedback; do not start implementation before approval.
- Submit completed implementation with \`action=ready_for_review\` and one concise note. For repository work, leave changes uncommitted and unpushed; PM owns commit/publication and the task remains In Progress until Monitor Agent validation passes.
- For an Epic-child task whose remaining live checks require a remotely deployable commit, use \`action=publish_checkpoint\` only after the active owner posts a fresh explicit authorization naming the Task key/branch and target Epic branch. Cite that exact single-use \`authorizationCommentId\`; PM commits and publishes only the Epic branch while the task remains In Progress. Never commit/push the child branch yourself.
- Review is for completed-work review. The resolved reviewer is task acting manager, then To Do/In Progress Epic acting manager, then task reporter. If satisfied, call \`action=review_done\` without posting an approval-only comment. Repository tasks remain in Review while PM finalizes publication/merge and cleanup, then move to Done. If changes/blockers remain, call \`action=review_feedback\` with concise feedback.
- When acting as Epic manager, check whether the Epic has a branch before proposing Action Plans or creating tasks. If empty, PM derives \`<epic-id>-<epic-title>\` lowercase/sanitized; Epic child tasks with an empty branch must use that Epic branch.
- Worktrees ONLY: Action Plan approval reserves the branch contract; \`start\` provisions the linked Git worktree at the In Progress boundary. Use the returned worktreePath; never edit a primary checkout or create/copy an ordinary task folder. If provisioning fails, tag the reporter with the returned error.
- Golden rule: if there is no new information, action result, plan, feedback, blocker, or necessary question, stay silent.
- Tasks under an Epic are actionable only when that Epic is To Do or In Progress.
- These PM rules are separate from Jira rules.
`;
}

/**
 * Build an agent's openclaw.json from the providers + models the admin selected.
 * Only the chosen providers' connection blocks are written, each carrying just
 * the ticked models; `auth.profiles` is added for providers that need one.
 */
export function renderOpenClawJson(args: {
  user: string;
  email: string;
  reasoning: string;
  primary: string;
  fallbacks: string[];
  selectedModels: SelectedModel[];
  gatewayPort?: number;
  openRouterApiKey?: string | null;
  now?: string;
}): string {
  const now = args.now ?? new Date().toISOString();

  const byProvider = new Map<string, SelectedModel[]>();
  for (const m of args.selectedModels) {
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }

  const providers: Record<string, unknown> = {};
  const profiles: Record<string, unknown> = {};
  const aliases: Record<string, unknown> = {};

  for (const [pid, models] of byProvider) {
    const def = getProvider(pid);
    if (!def) continue;
    const configId = def.configId ?? pid;
    const modelNamespace = def.modelNamespace ?? pid;
    const connection = { ...def.connection };
    if (pid === "openrouter" && args.openRouterApiKey) {
      connection.apiKey = args.openRouterApiKey;
    }
    providers[configId] = {
      ...connection,
      models: models.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
    };
    if (def.authMode) {
      profiles[`${configId}:default`] = { provider: def.authProvider ?? configId, mode: def.authMode, email: args.email };
    }
    for (const m of models) aliases[`${modelNamespace}/${m.id}`] = { alias: m.name || m.id };
  }

  const canonicalModelRef = (ref: string): string => {
    const providerId = ref.split("/")[0] ?? "";
    const modelId = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
    const provider = getProvider(providerId);
    return `${provider?.modelNamespace ?? providerId}/${modelId}`;
  };

  const config = {
    meta: { lastTouchedVersion: "2026.7.1-2", lastTouchedAt: now },
    wizard: { lastRunAt: now, lastRunVersion: "2026.7.1-2", lastRunCommand: "configure", lastRunMode: "local" },
    auth: { profiles },
    models: { mode: "merge", providers },
    browser: {
      // The host package supplies one maintained executable; OpenClaw keeps
      // the managed profile and all cookies/session state under this agent's
      // own home directory. Never reuse another Linux user's browser cache.
      enabled: true,
      executablePath: "/usr/bin/chromium",
      headless: true,
      noSandbox: false,
      defaultProfile: "openclaw",
    },
    gateway: {
      mode: "local",
      ...(args.gatewayPort ? { port: args.gatewayPort } : {}),
    },
    diagnostics: {
      // Preserve a payload-free stability bundle before a gateway reaches its
      // V8 heap limit. The host has enough storage for the bounded snapshot,
      // and without it an automatically restarted gateway loses the evidence
      // needed to distinguish retained session state from a true leak.
      memoryPressureSnapshot: true,
    },
    agents: {
      defaults: {
        model: {
          primary: canonicalModelRef(args.primary),
          fallbacks: args.fallbacks.map(canonicalModelRef),
        },
        models: aliases,
        reasoningDefault: args.reasoning,
        workspace: `/home/${args.user}/workspace`,
        compaction: {
          mode: "safeguard",
          // PM execution sessions are intentionally long-lived. Keep enough
          // headroom for OpenClaw's recovery pass so a productive task turn
          // cannot end in an unrecoverable auto-compaction terminal.
          reserveTokensFloor: 50_000,
        },
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
  reasoning: string;
  primary: string;
  fallbacks: string[];
  selectedModels: SelectedModel[];
  gatewayPort?: number;
  openRouterApiKey?: string | null;
}): RenderedAgentFiles {
  return {
    soul: renderSoul(args.name, args.user, args.role, args.email),
    identity: renderIdentity(args.name, args.user, args.email, args.role),
    tools: renderTools(),
    memory: renderMemory(),
    heartbeat: "# HEARTBEAT.md\n",
    openclawJson: renderOpenClawJson({
      user: args.user,
      email: args.email,
      reasoning: args.reasoning,
      primary: args.primary,
      fallbacks: args.fallbacks,
      selectedModels: args.selectedModels,
      gatewayPort: args.gatewayPort,
      openRouterApiKey: args.openRouterApiKey,
    }),
  };
}

export function buildAgentEntry(args: {
  user: string;
  uid: number;
  name: string;
  role: AgentRole;
  reasoning: string;
  email: string;
  telegram?: { enabled?: boolean; bot?: string } | null;
  integrations?: { gmail?: boolean; jira?: boolean; bitbucket?: boolean; maildir?: boolean } | null;
  imageTheme?: string;
  imageGender?: string;
  imageAgeGroup?: string;
  imageEthnicity?: string;
  imageCustomizationMode?: string;
  imagePrompt?: string;
  imageUsername?: string;
  imageFullName?: string;
  imageBio?: string;
  listeners: ProvisionListener[];
}): AgentRegistryEntry {
  return {
    user: args.user,
    uid: args.uid,
    name: args.name,
    enabled: true,
    role: args.role,
    reasoning: args.reasoning,
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
      maildir: args.integrations?.maildir ?? false,
    },
    profileImages: {
      theme: args.imageTheme ?? "Generated by Confy",
      customizationMode: args.imageCustomizationMode ?? "Random",
      gender: args.imageGender ?? "Random",
      ageGroup: args.imageAgeGroup ?? "Random",
      ethnicity: args.imageEthnicity ?? "Random",
      prompt: args.imagePrompt,
      username: args.imageUsername ?? args.user,
      fullName: args.imageFullName ?? args.name,
      bio: args.imageBio,
    },
    listeners: args.listeners,
  };
}
