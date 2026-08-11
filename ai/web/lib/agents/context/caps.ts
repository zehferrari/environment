// Context-packet caps, driven by the recipient agent's role.
//
// Coding agents receive a bounded inline working set. Deep history remains
// available through scoped loopback grants. This is deliberately independent
// of model/provider marketing windows: the prompt must leave room for tools,
// reasoning, and provider fallbacks instead of assuming the largest model.
//
// Monitor agents (role=="monitor") receive a smaller packet
// sized for 256k tokens. Monitors triage/route — they don't need the
// full repository conversation history to decide who to escalate to.
// The smaller packet also fits comfortably in a monitoring model's context
// budget without overflow.
//
// The final aggregate inline ceiling is enforced by pm-channel/context.ts.

import { db } from "@/lib/db";

export interface ContextCaps {
  maxComments: number;
  maxLiveChats: number;
  maxActivity: number;
  maxArchivedChats: number;
  /** Per-comment / per-chat body character clip. */
  maxTimelineBody: number;
  /** Per-activity-row body character clip. */
  maxActivityBody: number;
  /** Task / Epic / Project description rendered-block clip. */
  taskDescriptionMax: number;
  epicDescriptionMax: number;
  projectDescriptionMax: number;
  /** Total characters available across ALL inlined attachment excerpts. */
  attachmentInlineBudget: number;
  /** Per-attachment excerpt character cap (still inside attachmentInlineBudget). */
  attachmentPerExcerpt: number;
  /** Total rendered related-timeline body budget before older rows are summarized. */
  maxRenderedTimelineChars: number;
  /** Recent timeline rows kept verbatim even when older rows are summarized. */
  recentTimelineVerbatimItems: number;
}

export const DIRECT_CHAT_CONTEXT_DEFAULTS = {
  activeMessages: 14,
  archiveMessages: 12,
  archiveChainLimit: 2,
} as const;

export function intEnv(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

export function directChatContextMessages() {
  return intEnv("PM_DIRECT_CHAT_CONTEXT_MESSAGES", DIRECT_CHAT_CONTEXT_DEFAULTS.activeMessages, 6, 40);
}

export function directChatArchiveContextMessages() {
  return intEnv("PM_DIRECT_CHAT_ARCHIVE_CONTEXT_MESSAGES", DIRECT_CHAT_CONTEXT_DEFAULTS.archiveMessages, 4, 40);
}

export function directChatArchiveChainLimit() {
  return intEnv("PM_DIRECT_CHAT_ARCHIVE_CHAIN_LIMIT", DIRECT_CHAT_CONTEXT_DEFAULTS.archiveChainLimit, 1, 6);
}

// These query/render caps prevent expensive construction of a second archive;
// the aggregate PM-channel context cap is the final provider-neutral guardrail.
export const CODE_CAPS: ContextCaps = {
  maxComments: 120,
  maxLiveChats: 80,
  maxActivity: 100,
  maxArchivedChats: 80,
  maxTimelineBody: 4000,
  maxActivityBody: 1200,
  taskDescriptionMax: 12000,
  epicDescriptionMax: 12000,
  projectDescriptionMax: 6000,
  attachmentInlineBudget: 12000,
  attachmentPerExcerpt: 6000,
  maxRenderedTimelineChars: 50000,
  recentTimelineVerbatimItems: 12,
};

// Monitor turns are smaller again because they triage and route rather than
// carrying an implementation tool loop.
export const MONITOR_CAPS: ContextCaps = {
  maxComments: 60,
  maxLiveChats: 40,
  maxActivity: 60,
  maxArchivedChats: 40,
  maxTimelineBody: 3000,
  maxActivityBody: 900,
  taskDescriptionMax: 8000,
  epicDescriptionMax: 8000,
  projectDescriptionMax: 4000,
  attachmentInlineBudget: 8000,
  attachmentPerExcerpt: 4000,
  maxRenderedTimelineChars: 30000,
  recentTimelineVerbatimItems: 10,
};

// ENV-121 — the continuation-episode profile.
//
// A continuation turn is NOT first contact. The agent already has an approved
// plan, a checklist, and a structured checkpoint from its previous episode;
// what it needs inline is the delta, not the archive. So this profile is an
// order of magnitude smaller than CODE_CAPS across the board, and full history
// stays reachable through the scoped loopback grants the brief still carries.
//
// Every field is env-overridable through `episodeCaps()` because the right
// size depends on the provider a host is actually running.
export const EPISODE_CAPS: ContextCaps = {
  maxComments: 8,
  maxLiveChats: 8,
  maxActivity: 10,
  maxArchivedChats: 0,
  maxTimelineBody: 900,
  maxActivityBody: 200,
  taskDescriptionMax: 3000,
  epicDescriptionMax: 1200,
  projectDescriptionMax: 600,
  attachmentInlineBudget: 0,
  attachmentPerExcerpt: 0,
  maxRenderedTimelineChars: 6000,
  recentTimelineVerbatimItems: 6,
};

/**
 * EPISODE_CAPS with per-field env overrides applied. Bounds are deliberately
 * tight: an operator may tune the brief, but "tune" must not become "restore
 * the unbounded packet under a different name".
 */
export function episodeCaps(): ContextCaps {
  return {
    ...EPISODE_CAPS,
    maxComments: intEnv("PM_EPISODE_MAX_COMMENTS", EPISODE_CAPS.maxComments, 0, 30),
    maxLiveChats: intEnv("PM_EPISODE_MAX_CHATS", EPISODE_CAPS.maxLiveChats, 0, 30),
    maxActivity: intEnv("PM_EPISODE_MAX_ACTIVITY", EPISODE_CAPS.maxActivity, 0, 40),
    maxTimelineBody: intEnv("PM_EPISODE_MAX_TIMELINE_BODY", EPISODE_CAPS.maxTimelineBody, 200, 4000),
    taskDescriptionMax: intEnv("PM_EPISODE_TASK_DESCRIPTION_MAX", EPISODE_CAPS.taskDescriptionMax, 500, 12000),
    maxRenderedTimelineChars: intEnv(
      "PM_EPISODE_MAX_RENDERED_TIMELINE_CHARS",
      EPISODE_CAPS.maxRenderedTimelineChars,
      1000,
      20000,
    ),
  };
}

/**
 * The ceiling a rendered continuation brief must stay under. This is the
 * property the episode contract test asserts: brief size must be FLAT in the
 * number of comments on the task, not merely "smaller than the full packet".
 */
export function episodeBriefCharBudget() {
  return intEnv("PM_EPISODE_BRIEF_MAX_CHARS", 24_000, 4_000, 80_000);
}

export function capsForRole(role: string | null | undefined): ContextCaps {
  // Only "coding" gets the 1M profile. monitor, room, or any unknown
  // role falls back to the smaller 256k profile.
  return role === "coding" ? CODE_CAPS : MONITOR_CAPS;
}

// Convenience: look up the agent by slug and resolve caps. Returns the
// 256k profile if the slug is unknown or deactivated — safest default.
export async function resolveAgentCaps(agentSlug: string): Promise<ContextCaps> {
  if (!agentSlug || agentSlug === "room") return MONITOR_CAPS;
  const agent = await db.agent.findUnique({
    where: { slug: agentSlug },
    select: { role: true },
  });
  return capsForRole(agent?.role ?? null);
}
