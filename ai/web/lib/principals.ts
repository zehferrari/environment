// Assignable-principal resolver (HOMELAB-47).
//
// Returns the User pool that can be set as Task assignee / Task reviewer
// (column actingManagerId in schema) / Epic worker / Epic acting manager.
// Pool composition:
//
//   - active humans (User.kind = "human", status = "active")
//   - active coding agents (User.kind = "agent", status = "active",
//     linked Agent.role = "coding", Agent.deactivatedAt = null)
//
// Non-coding agents (e.g. monitor) and remote-host agents that were
// never seeded as PM users are intentionally excluded — see HOMELAB-47
// product call. The same shape is used by the picker UI everywhere so
// "(agent)" suffixes are consistent.

import { db } from "@/lib/db";

export interface AssignablePrincipal {
  id: string;
  username: string;
  // Display name shown in pickers: the agent's full name for agents,
  // falling back to username for humans (the User row has no separate
  // name column).
  name: string;
  kind: "human" | "agent";
  avatarUpdatedAt: Date | null;
  agentSlug: string | null;
  agentRole: string | null;
  agentAvatar: string | null;
}

export async function listAssignablePrincipals(): Promise<
  AssignablePrincipal[]
> {
  const rows = await db.user.findMany({
    where: {
      status: "active",
      OR: [
        { kind: "human" },
        {
          kind: "agent",
          agent: { is: { role: "coding", deactivatedAt: null } },
        },
      ],
    },
    orderBy: [{ kind: "asc" }, { username: "asc" }],
    select: {
      id: true,
      username: true,
      name: true,
      avatarUpdatedAt: true,
      kind: true,
      agent: { select: { slug: true, role: true, name: true, avatar: true } },
    },
  });

  return rows.map((u) => ({
    id: u.id,
    username: u.username,
    // Agent's registry name for agents; the human's editable display name
    // for humans; username as the final fallback.
    name: u.agent?.name ?? u.name ?? u.username,
    kind: u.kind === "agent" ? "agent" : "human",
    avatarUpdatedAt: u.avatarUpdatedAt,
    agentSlug: u.agent?.slug ?? null,
    agentRole: u.agent?.role ?? null,
    agentAvatar: u.agent?.avatar ?? null,
  }));
}

// Label helper so the "(agent)" suffix is rendered identically in every
// picker / activity line. Kept tiny on purpose.
export function principalLabel(p: AssignablePrincipal): string {
  return p.kind === "agent" ? `${p.username} (agent)` : p.username;
}
