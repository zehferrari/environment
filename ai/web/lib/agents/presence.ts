// Canonical agent-presence vocabulary. Every surface that says whether an
// agent is doing something derives its answer here, from the same two inputs:
// the PM DB row (registration/deactivation) and the live Atlas snapshot entry
// (busy probe + session idle). Shared by server components, the presence SSE
// route, and (types/ordering/colors only) client components.

import type { SnapshotAgent } from "@/lib/atlas-snapshot";

export type AgentPresenceStatus =
  | "busy"
  | "live"
  | "idle"
  | "stale"
  | "offline"
  | "registered";

export type PresenceDbAgent = {
  deactivatedAt: Date | null;
  user: { status: string } | null;
};

export type PresenceSnapshotAgent = Pick<SnapshotAgent, "session_idle_s" | "busy_state">;

/** Single source of truth for an agent's presence status. */
export function agentStatusFor(
  agent: PresenceDbAgent,
  live?: PresenceSnapshotAgent | null,
): AgentPresenceStatus {
  if (agent.deactivatedAt || agent.user?.status === "deactivated") return "offline";
  if (live?.busy_state?.is_busy) return "busy";
  if (live) {
    const idle = live.session_idle_s ?? 999999;
    if (idle < 90) return "live";
    if (idle < 900) return "idle";
    return "stale";
  }
  return agent.user ? "live" : "registered";
}

// Surface the most active agents first: Busy → Live → Idle → Stale, then the
// inert states. Ties keep whatever order the caller already had.
const AGENT_STATUS_RANK: Record<string, number> = {
  busy: 0,
  live: 1,
  idle: 2,
  stale: 3,
  registered: 4,
  offline: 5,
};

export function agentStatusRank(status: string | null | undefined): number {
  return AGENT_STATUS_RANK[status ?? ""] ?? 99;
}

/** Status accent colors (ring/pill + soft glow background) per presence state. */
export function agentStatusRing(status: string): { ring: string; bg: string; label: string } {
  if (status === "busy") return { ring: "#22c55e", bg: "rgba(34,197,94,0.16)", label: "busy" };
  if (status === "live") return { ring: "#2dd4bf", bg: "rgba(45,212,191,0.16)", label: "live" };
  if (status === "idle") return { ring: "#f59e0b", bg: "rgba(245,158,11,0.16)", label: "idle" };
  if (status === "stale") return { ring: "#64748b", bg: "rgba(100,116,139,0.16)", label: "stale" };
  if (status === "offline") return { ring: "#ef4444", bg: "rgba(239,68,68,0.16)", label: "offline" };
  return { ring: "#94a3b8", bg: "rgba(148,163,184,0.16)", label: status };
}
