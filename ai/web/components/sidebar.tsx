import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import SidebarNav, { type SidebarAgent } from "@/components/sidebar-nav";

type SnapshotAgent = {
  session_idle_s?: number | null;
  busy_state?: { is_busy?: boolean; signals?: string[] } | null;
};

type Snapshot = {
  agents?: Record<string, SnapshotAgent>;
};

async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Snapshot;
  } catch {
    return null;
  }
}

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}`;
}

function statusFor(
  agent: { deactivatedAt: Date | null; user: { status: string } | null },
  live?: SnapshotAgent | null
) {
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

function ringFor(status: string) {
  if (status === "busy") return "#22c55e"; // Green
  if (status === "live") return "#2dd4bf"; // Teal
  if (status === "idle") return "#f59e0b"; // Orange
  if (status === "stale") return "#64748b"; // Slate
  if (status === "offline") return "#ef4444"; // Red
  return "#94a3b8"; // Gray
}

export default async function Sidebar() {
  const [session, agents, snapshot] = await Promise.all([
    auth(),
    db.agent.findMany({
      where: {
        deactivatedAt: null,
        user: { is: { status: "active" } },
      },
      orderBy: { slug: "asc" },
      select: {
        slug: true,
        name: true,
        role: true,
        avatar: true,
        deactivatedAt: true,
        user: { select: { username: true, status: true } },
      },
    }),
    readSnapshot(),
  ]);
  const user = session?.user as
    | { id?: string; name?: string; kind?: string }
    | undefined;
  // Human display name + avatar for the chip below (session.user.name is the
  // username; the editable display name lives on the User row).
  const me = user?.id
    ? await db.user.findUnique({
        where: { id: user.id },
        select: { name: true, username: true, avatarUpdatedAt: true },
      })
    : null;
  const isAdmin = user?.name === "zeh";
  const liveAgents = snapshot?.agents ?? {};

  const navAgents: SidebarAgent[] = agents.map((agent) => {
    const live = liveAgents[agent.slug];
    const status = statusFor(agent, live);
    return {
      slug: agent.slug,
      name: agent.name,
      role: agent.role,
      avatarSrc: agent.avatar ? avatarUrl(agent.name) : null,
      status,
      statusColor: ringFor(status),
    };
  });

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <SidebarNav
      isAdmin={isAdmin}
      agents={navAgents}
      meName={me?.name ?? me?.username ?? user?.name ?? "?"}
      meKind={user?.kind ?? null}
      userId={user?.id ?? null}
      userAvatarVersion={me?.avatarUpdatedAt ? me.avatarUpdatedAt.getTime() : null}
      signOutAction={signOutAction}
    />
  );
}
