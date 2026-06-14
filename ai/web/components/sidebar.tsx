import { auth, signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import SidebarNav, {
  type SidebarAgent,
  type SidebarProject,
} from "@/components/sidebar-nav";

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
  return `/agents/avatars/${encodeURIComponent(first)}?v=agent-image-v2`;
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

// Avatar treatment per status (HOMELAB sidebar rework): busy agents get a
// discrete glowing pulse ring; stale/offline render black & white; live and
// idle stay in full colour. The old coloured status dot + label are gone.
function avatarTone(status: string): { grayscale: boolean; pulse: boolean } {
  return {
    grayscale: status === "stale" || status === "offline",
    pulse: status === "busy",
  };
}

export default async function Sidebar() {
  const [session, agents, snapshot, projects, latestAgentMsgs] = await Promise.all([
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
    db.project.findMany({
      where: { archivedAt: null, deletedAt: null },
      orderBy: { name: "asc" },
      select: { slug: true, name: true },
    }),
    // Newest agent-authored direct-chat message per agent — paired with the
    // viewer's read cursor below to decide the unread red dot.
    db.directAgentChatMessage.groupBy({
      by: ["agentSlug"],
      where: { deletedAt: null, sender: { is: { kind: "agent" } } },
      _max: { createdAt: true },
    }),
  ]);
  const user = session?.user as
    | { id?: string; name?: string; kind?: string }
    | undefined;
  const readCursors = user?.id
    ? await db.chatReadCursor.findMany({
        where: { userId: user.id },
        select: { agentSlug: true, lastReadAt: true },
      })
    : [];
  const cursorBySlug = new Map(readCursors.map((c) => [c.agentSlug, c.lastReadAt]));
  const latestBySlug = new Map(
    latestAgentMsgs.map((m) => [m.agentSlug, m._max.createdAt]),
  );
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

  // Surface the most active agents first: Busy → Live → Idle → Stale, then
  // the inert states. Ties keep the alphabetical (slug) order the query returns.
  const STATUS_ORDER: Record<string, number> = {
    busy: 0,
    live: 1,
    idle: 2,
    stale: 3,
    registered: 4,
    offline: 5,
  };
  const navAgents: SidebarAgent[] = agents.map((agent) => {
    const live = liveAgents[agent.slug];
    const status = statusFor(agent, live);
    const tone = avatarTone(status);
    const latest = latestBySlug.get(agent.slug) ?? null;
    const lastRead = cursorBySlug.get(agent.slug) ?? null;
    const unread = Boolean(latest && (!lastRead || latest > lastRead));
    return {
      slug: agent.slug,
      name: agent.name,
      role: agent.role,
      avatarSrc: agent.avatar ? avatarUrl(agent.name) : null,
      status,
      grayscale: tone.grayscale,
      pulse: tone.pulse,
      unread,
    };
  });
  navAgents.sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99),
  );

  const navProjects: SidebarProject[] = projects.map((p) => ({
    slug: p.slug,
    name: p.name,
  }));

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <SidebarNav
      isAdmin={isAdmin}
      agents={navAgents}
      projects={navProjects}
      meName={me?.name ?? me?.username ?? user?.name ?? "?"}
      meKind={user?.kind ?? null}
      userId={user?.id ?? null}
      userAvatarVersion={me?.avatarUpdatedAt ? me.avatarUpdatedAt.getTime() : null}
      signOutAction={signOutAction}
    />
  );
}
