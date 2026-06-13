// Chat-target resolver (HOMELAB-48).
//
// Broader than lib/principals.ts — chat lets the user talk to ANY
// active agent regardless of role, including monitors. (Assignment +
// review pickers stay restricted to coding agents.) An agent is a
// valid chat target if its Agent row is not deactivated AND it has a
// seeded User row that is active. Monitors are seeded by the same
// instrumentation boot sync (lib/agents/sync.ts) so they appear here
// without code changes.

import { db } from "@/lib/db";

export interface ChatTarget {
  userId: string;
  username: string;
  agentSlug: string;
  agentRole: string;
  displayName: string;
  gatewayPort: number | null;
}

export async function listChatTargets(): Promise<ChatTarget[]> {
  const rows = await db.user.findMany({
    where: {
      kind: "agent",
      status: "active",
      agent: { is: { deactivatedAt: null } },
    },
    orderBy: { username: "asc" },
    select: {
      id: true,
      username: true,
      agent: {
        select: { slug: true, role: true, name: true, gatewayPort: true },
      },
    },
  });

  const out: ChatTarget[] = [];
  for (const u of rows) {
    if (!u.agent) continue;
    out.push({
      userId: u.id,
      username: u.username,
      agentSlug: u.agent.slug,
      agentRole: u.agent.role,
      displayName: u.agent.name || u.username,
      gatewayPort: u.agent.gatewayPort ?? null,
    });
  }
  return out;
}
