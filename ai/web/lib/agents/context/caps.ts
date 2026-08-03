// Context-packet caps, driven by the recipient agent's role.
//
// Coding agents (role=="coding", capability
// can_modify_code=true) receive the FULL packet — sized for 1M-token
// model windows (Claude Opus 4.7, OpenAI gpt-5.5). They need every
// comment, every discussion bubble, full descriptions and attachment
// content because they're proposing work-item changes and writing code.
//
// Monitor agents (role=="monitor") receive a smaller packet
// sized for 256k tokens. Monitors triage/route — they don't need the
// full repository conversation history to decide who to escalate to.
// The smaller packet also fits comfortably in a monitoring model's context
// budget without overflow.
//
// Both profiles only set ROW COUNTS and PER-ITEM CLIP CEILINGS. Real
// content is far shorter than these clips, so realistic packet sizes
// land at a tiny fraction of these worst-case envelopes.

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

// Coding turns need substantial tool-loop headroom inside the active model's
// 272k-token window. Deep history remains available through scoped live-fetch
// grants; the inline packet is a bounded working set, not a second archive.
export const CODE_CAPS: ContextCaps = {
  maxComments: 500,
  maxLiveChats: 500,
  maxActivity: 300,
  maxArchivedChats: 500,
  maxTimelineBody: 8000,
  maxActivityBody: 2400,
  taskDescriptionMax: 24000,
  epicDescriptionMax: 24000,
  projectDescriptionMax: 12000,
  attachmentInlineBudget: 60000,
  attachmentPerExcerpt: 16000,
  maxRenderedTimelineChars: 150000,
  recentTimelineVerbatimItems: 14,
};

// Monitor turns are smaller again because they triage and route rather than
// carrying an implementation tool loop.
export const MONITOR_CAPS: ContextCaps = {
  maxComments: 300,
  maxLiveChats: 300,
  maxActivity: 150,
  maxArchivedChats: 300,
  maxTimelineBody: 6000,
  maxActivityBody: 1600,
  taskDescriptionMax: 16000,
  epicDescriptionMax: 16000,
  projectDescriptionMax: 8000,
  attachmentInlineBudget: 40000,
  attachmentPerExcerpt: 12000,
  maxRenderedTimelineChars: 100000,
  recentTimelineVerbatimItems: 10,
};

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
