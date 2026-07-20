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
import { readAtlasSnapshot } from "@/lib/atlas-snapshot";
import { agentStatusFor, agentStatusRank } from "@/lib/agents/presence";

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}?v=agent-image-v2`;
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
    viewer.isOwner ? readAtlasSnapshot() : Promise.resolve(null),
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

  // Server-render status is the SSR/first-paint value only; SidebarNav
  // re-derives status, ordering and busy-row visibility from the live
  // presence store on the client.
  const navAgents: SidebarAgent[] = agents.map((agent) => {
    const live = liveAgents[agent.slug];
    const status = agentStatusFor(agent, live);
    const latest = latestBySlug.get(agent.slug) ?? null;
    const lastRead = cursorBySlug.get(agent.slug) ?? null;
    const unread = Boolean(latest && (!lastRead || latest > lastRead));
    return {
      slug: agent.slug,
      name: agent.name,
      role: agent.role,
      avatarSrc: agent.avatar ? avatarUrl(agent.name) : null,
      status,
      unread,
    };
  });
  navAgents.sort((a, b) => agentStatusRank(a.status) - agentStatusRank(b.status));

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
