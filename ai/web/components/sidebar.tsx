import { signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import {
  accessibleProjectWhere,
  getViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";
import SidebarNav, {
  type SidebarAgent,
  type SidebarProject,
  type SidebarWorkspace,
} from "@/components/sidebar-nav";
import { avatarStatusTone } from "@/components/avatar-status";

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

export default async function Sidebar() {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");
  const projectWhere = accessibleProjectWhere(viewer, { archivedAt: null, deletedAt: null });
  const workspaceWhere = workspaceAccessWhere(viewer);
  const [agents, snapshot, projects, workspaces, latestAgentMsgs] = await Promise.all([
    viewer.isOwner ? db.agent.findMany({
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
    }) : Promise.resolve([]),
    viewer.isOwner ? readSnapshot() : Promise.resolve(null),
    db.project.findMany({
      where: projectWhere,
      orderBy: { name: "asc" },
      select: { slug: true, name: true },
    }),
    db.workspace.findMany({
      where: { AND: [{ archivedAt: null }, workspaceWhere] },
      orderBy: { name: "asc" },
      select: {
        slug: true,
        name: true,
        logoPath: true,
        logoUpdatedAt: true,
        projects: {
          where: { project: projectWhere },
          orderBy: { createdAt: "asc" },
          select: {
            project: {
              select: { slug: true, name: true, archivedAt: true, deletedAt: true },
            },
          },
        },
        agentPool: {
          orderBy: { createdAt: "asc" },
          select: { agent: { select: { slug: true } } },
        },
      },
    }),
    // Newest agent-authored direct-chat message per agent — paired with the
    // viewer's read cursor below to decide the unread red dot.
    viewer.isOwner ? db.directAgentChatMessage.groupBy({
      by: ["agentSlug"],
      where: { deletedAt: null, sender: { is: { kind: "agent" } } },
      _max: { createdAt: true },
    }) : Promise.resolve([]),
  ]);
  const readCursors = viewer.isOwner
    ? await db.chatReadCursor.findMany({
        where: { userId: viewer.id },
        select: { agentSlug: true, lastReadAt: true },
      })
    : [];
  const cursorBySlug = new Map(readCursors.map((c) => [c.agentSlug, c.lastReadAt]));
  const latestBySlug = new Map(
    latestAgentMsgs.map((m) => [m.agentSlug, m._max.createdAt]),
  );
  // Human display name + avatar for the chip below (session.user.name is the
  // username; the editable display name lives on the User row).
  const me = await db.user.findUnique({
    where: { id: viewer.id },
    select: { name: true, username: true, avatarUpdatedAt: true },
  });
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
    const tone = avatarStatusTone(status);
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

  const navWorkspaces: SidebarWorkspace[] = workspaces.map((workspace) => ({
    slug: workspace.slug,
    name: workspace.name,
    logoSrc: workspace.logoPath
      ? workspaceLogoPublicUrl(workspace.slug, workspace.logoUpdatedAt)
      : null,
    projects: workspace.projects
      .map(({ project }) => project)
      .filter((project) => !project.archivedAt && !project.deletedAt)
      .map((project) => ({ slug: project.slug, name: project.name })),
    agentSlugs: viewer.isOwner ? workspace.agentPool.map(({ agent }) => agent.slug) : [],
  }));

  async function signOutAction() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <SidebarNav
      isOwner={viewer.isOwner}
      canViewAgents={viewer.isOwner}
      agents={navAgents}
      projects={navProjects}
      workspaces={navWorkspaces}
      meName={me?.name ?? me?.username ?? viewer.username}
      meKind={viewer.kind}
      userId={viewer.id}
      userAvatarVersion={me?.avatarUpdatedAt ? me.avatarUpdatedAt.getTime() : null}
      signOutAction={signOutAction}
    />
  );
}
