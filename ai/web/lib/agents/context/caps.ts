// Context-packet caps, driven by the recipient agent's role.
//
// Coding agents (asdrubal, barekbaal — role=="coding", capability
// can_modify_code=true) receive the FULL packet — sized for 1M-token
// model windows (Claude Opus 4.7, OpenAI gpt-5.5). They need every
// comment, every discussion bubble, full descriptions and attachment
// content because they're proposing work-item changes and writing code.
//
// Monitor agents (karen — role=="monitor") receive a smaller packet
// sized for 256k tokens. Monitors triage/route — they don't need the
// full repository conversation history to decide who to escalate to.
// The smaller packet also fits comfortably in karen's deepseek-v4-pro
// primary (128k) without overflow.
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
}

// Targets 1M tokens (~4MB packet ceiling). Realistic busy tasks land in
// 500KB–2MB at these caps. Row counts almost never bind; per-body clip
// is the working constraint.
export const CODE_CAPS: ContextCaps = {
  maxComments: 1000,
  maxLiveChats: 1000,
  maxActivity: 500,
  maxArchivedChats: 1000,
  maxTimelineBody: 24000,
  maxActivityBody: 8000,
  taskDescriptionMax: 60000,
  epicDescriptionMax: 60000,
  projectDescriptionMax: 30000,
  attachmentInlineBudget: 200000,
  attachmentPerExcerpt: 40000,
};

// Targets 256k tokens (~1MB packet ceiling). Half the row counts and
// half the per-body clip vs CODE_CAPS.
export const MONITOR_CAPS: ContextCaps = {
  maxComments: 500,
  maxLiveChats: 500,
  maxActivity: 200,
  maxArchivedChats: 500,
  maxTimelineBody: 12000,
  maxActivityBody: 4000,
  taskDescriptionMax: 30000,
  epicDescriptionMax: 30000,
  projectDescriptionMax: 15000,
  attachmentInlineBudget: 100000,
  attachmentPerExcerpt: 20000,
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
