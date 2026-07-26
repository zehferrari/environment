import { signOut } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import {
  accessibleProjectWhere,
  accessibleTaskWhere,
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
      select: { id: true, slug: true, name: true, backgroundColor: true },
    }),
    db.workspace.findMany({
      where: { AND: [{ archivedAt: null }, workspaceWhere] },
      orderBy: { name: "asc" },
      select: {
        slug: true,
        name: true,
        borderColor: true,
        logoPath: true,
        logoUpdatedAt: true,
        projects: {
          where: { project: projectWhere },
          orderBy: { createdAt: "asc" },
          select: {
            project: {
              select: {
                id: true,
                slug: true,
                name: true,
                backgroundColor: true,
                archivedAt: true,
                deletedAt: true,
              },
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

  // Completion feeding the sidebar progress meters. Archived tasks stay in
  // the denominator *and* the numerator: a project whose Done tasks aged out
  // of the board has still completed that work, so dropping them would make
  // finished projects slide backwards.
  const taskCounts = await db.task.groupBy({
    by: ["projectId", "status"],
    where: accessibleTaskWhere(viewer, { deletedAt: null }),
    _count: { _all: true },
  });
  const totalByProject = new Map<string, number>();
  const doneByProject = new Map<string, number>();
  for (const row of taskCounts) {
    const n = row._count._all;
    totalByProject.set(row.projectId, (totalByProject.get(row.projectId) ?? 0) + n);
    if (row.status === "Done") {
      doneByProject.set(row.projectId, (doneByProject.get(row.projectId) ?? 0) + n);
    }
  }

  // null (rather than 0) means "nothing to measure yet", which renders as an
  // empty grey track instead of a 0% red sliver.
  function completionOf(projectIds: string[]): number | null {
    let total = 0;
    let done = 0;
    for (const id of projectIds) {
      total += totalByProject.get(id) ?? 0;
      done += doneByProject.get(id) ?? 0;
    }
    if (total === 0) return null;
    return Math.round((done / total) * 100);
  }

  const navProjects: SidebarProject[] = projects.map((p) => ({
    slug: p.slug,
    name: p.name,
    color: p.backgroundColor,
    completion: completionOf([p.id]),
  }));

  const navWorkspaces: SidebarWorkspace[] = workspaces.map((workspace) => {
    const liveProjects = workspace.projects
      .map(({ project }) => project)
      .filter((project) => !project.archivedAt && !project.deletedAt);
    return {
      slug: workspace.slug,
      name: workspace.name,
      color: workspace.borderColor,
      completion: completionOf(liveProjects.map((project) => project.id)),
      logoSrc: workspace.logoPath
        ? workspaceLogoPublicUrl(workspace.slug, workspace.logoUpdatedAt)
        : null,
      projects: liveProjects.map((project) => ({
        slug: project.slug,
        name: project.name,
        color: project.backgroundColor,
        completion: completionOf([project.id]),
      })),
      agentSlugs: viewer.isOwner ? workspace.agentPool.map(({ agent }) => agent.slug) : [],
    };
  });

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
