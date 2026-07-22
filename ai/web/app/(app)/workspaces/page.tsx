import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createWorkspace, restoreWorkspace } from "@/lib/workspaces/service";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";
import {
  accessibleProjectWhere,
  accessibleTaskWhere,
  requireOwner,
  requireViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";
import WorkspacesBoard, { type BoardWorkspace } from "./workspaces-board";

export const dynamic = "force-dynamic";

async function createWorkspaceAction(formData: FormData) {
  "use server";
  await requireOwner();
  const workspace = await createWorkspace({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    type: String(formData.get("type") ?? "internal"),
    description: String(formData.get("description") ?? ""),
  });
  revalidatePath("/workspaces");
  redirect(`/workspaces/${workspace.slug}/settings`);
}

async function restoreWorkspaceAction(formData: FormData) {
  "use server";
  await requireOwner();
  const slug = String(formData.get("slug") ?? "");
  await restoreWorkspace(slug);
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${slug}`);
  revalidatePath(`/workspaces/${slug}/settings`);
}

export default async function WorkspacesPage({ searchParams }: { searchParams?: Promise<{ archived?: string }> }) {
  const params = await searchParams;
  const showingArchived = params?.archived === "1";
  const viewer = await requireViewer();
  const visibleProjects = accessibleProjectWhere(viewer);
  const [workspaces, archivedCount, activeWorkspaces] = await Promise.all([
    db.workspace.findMany({
      where: {
        AND: [
          showingArchived ? { archivedAt: { not: null } } : { archivedAt: null },
          workspaceAccessWhere(viewer),
        ],
      },
      orderBy: showingArchived ? [{ archivedAt: "desc" }, { name: "asc" }] : [{ type: "asc" }, { name: "asc" }],
      include: {
        projects: { where: { project: visibleProjects }, select: { projectId: true } },
        agentPool: { select: { agentId: true } },
      },
    }),
    db.workspace.count({ where: { AND: [{ archivedAt: { not: null } }, workspaceAccessWhere(viewer)] } }),
    db.workspace.findMany({
      where: { AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)] },
      select: { slug: true },
      take: 2,
    }),
  ]);
  if (!showingArchived && activeWorkspaces.length === 1) {
    redirect(`/workspaces/${activeWorkspaces[0].slug}`);
  }

  // Unified board (ENV-111): with >=2 accessible active workspaces the page
  // becomes a cross-workspace task board. Single-workspace users were already
  // redirected above; the archived view keeps the card grid.
  const boardWorkspaces: BoardWorkspace[] = showingArchived
    ? []
    : (
        await db.workspace.findMany({
          where: { AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)] },
          orderBy: [{ type: "asc" }, { name: "asc" }],
          select: {
            id: true,
            slug: true,
            name: true,
            type: true,
            borderColor: true,
            projects: {
              where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
              orderBy: { project: { name: "asc" } },
              select: {
                project: {
                  select: {
                    id: true,
                    slug: true,
                    name: true,
                    backgroundColor: true,
                    tasks: {
                      where: accessibleTaskWhere(viewer, {
                        deletedAt: null,
                        archivedAt: null,
                        parentTaskId: null,
                      }),
                      orderBy: [{ status: "asc" }, { rank: "asc" }],
                      select: { id: true, title: true, status: true, workItemKey: true },
                    },
                  },
                },
              },
            },
          },
        })
      ).map((workspace) => ({
        id: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        type: workspace.type,
        borderColor: workspace.borderColor,
        projects: workspace.projects.map(({ project }) => project),
      }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-display font-semibold tracking-tight">{showingArchived ? "Archived workspaces" : "Workspaces"}</h1>
          <p className="mt-1 text-body text-text-muted">
            {showingArchived
              ? "Restore inactive workspaces without deleting their projects, tasks, or history."
              : viewer.isOwner
                ? "Group projects and coding-agent pools into operating contexts."
                : "Workspaces containing projects available to your account."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!showingArchived && viewer.isOwner ? (
            <a href="#new-workspace" className="rounded-lg bg-accent px-control-x py-control-y text-caption font-semibold text-bg shadow-sm hover:opacity-90">
              New workspace
            </a>
          ) : null}
          {showingArchived ? (
            <Link href="/workspaces" className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent">
              Active workspaces
            </Link>
          ) : archivedCount > 0 ? (
            <Link href="/workspaces?archived=1" className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent">
              View archived ({archivedCount})
            </Link>
          ) : null}
        </div>
      </div>


      {!showingArchived && viewer.isOwner ? (
        <form id="new-workspace" action={createWorkspaceAction} className="rounded-panel border border-line bg-panel p-card shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold tracking-tight">Create workspace</h2>
            <p className="mt-1 text-caption text-text-muted">Create a workspace, then choose related projects, agent pool, defaults, and logo on the settings screen.</p>
          </div>
          <div className="grid gap-card md:grid-cols-[1fr_14rem_11rem_auto]">
            <label className="space-y-1">
              <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Name</span>
              <input name="name" required maxLength={200} placeholder="Product Team" className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent" />
            </label>
            <label className="space-y-1">
              <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Slug</span>
              <input name="slug" required pattern="[a-z0-9]+([._-][a-z0-9]+)*" placeholder="product-team" className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y font-mono text-body outline-none focus:border-accent" />
            </label>
            <label className="space-y-1">
              <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Type</span>
              <select name="type" defaultValue="internal" className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent">
                <option value="internal">Internal</option>
                <option value="client">Client</option>
                <option value="personal">Personal</option>
                <option value="other">Other</option>
              </select>
            </label>
            <button type="submit" className="self-end rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-bg shadow-sm hover:opacity-90">
              Create
            </button>
          </div>
          <label className="mt-card block space-y-1">
            <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">Description</span>
            <textarea name="description" rows={2} placeholder="Optional context for humans and agents..." className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent" />
          </label>
        </form>
      ) : null}

      {workspaces.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line bg-panel p-card text-body text-text-muted">
          {showingArchived
            ? "No archived workspaces. Archived workspaces will appear here for restore."
            : "No active workspaces yet. Use the workspace API to create one, then manage projects, boards, and agents here."}
        </div>
      ) : !showingArchived ? (
        <WorkspacesBoard workspaces={boardWorkspaces} isOwner={viewer.isOwner} />
      ) : (
        <div className="grid grid-cols-1 gap-card sm:grid-cols-2 xl:grid-cols-3">
          {workspaces.map((workspace) => {
            const logoUrl = workspace.logoPath ? workspaceLogoPublicUrl(workspace.slug, workspace.logoUpdatedAt) : null;
            return (
              <div
                key={workspace.id}
                className="group flex min-h-48 flex-col gap-4 rounded-panel border border-line bg-panel p-card shadow-sm transition hover:border-accent hover:shadow-md"
              >
                <Link href={`/workspaces/${workspace.slug}`} className="flex flex-1 flex-col gap-4">
                  <div className="flex items-start gap-3">
                    <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-panel-soft text-base font-semibold uppercase text-text">
                      {logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={logoUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        workspace.name.slice(0, 1)
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-base font-semibold tracking-tight group-hover:text-accent">
                        {workspace.name}
                      </div>
                      <div className="truncate text-caption text-text-muted">/{workspace.slug}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className="inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-accent">
                          {workspace.type}
                        </span>
                        {workspace.archivedAt ? (
                          <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-amber-700">
                            Archived
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {workspace.description ? (
                    <p className="line-clamp-3 text-caption text-text-muted">{workspace.description}</p>
                  ) : null}
                  <dl className="mt-auto grid grid-cols-2 gap-2 text-caption text-text-muted">
                    <div className="rounded-xl border border-line bg-bg px-3 py-2">
                      <dt className="text-nano uppercase tracking-wider">Projects</dt>
                      <dd className="text-body font-semibold text-text">{workspace.projects.length}</dd>
                    </div>
                    {viewer.isOwner ? (
                      <div className="rounded-xl border border-line bg-bg px-3 py-2">
                        <dt className="text-nano uppercase tracking-wider">Agent pool</dt>
                        <dd className="text-body font-semibold text-text">{workspace.agentPool.length}</dd>
                      </div>
                    ) : null}
                  </dl>
                </Link>
                {showingArchived && viewer.isOwner ? (
                  <form action={restoreWorkspaceAction}>
                    <input type="hidden" name="slug" value={workspace.slug} />
                    <button type="submit" className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent">
                      Restore workspace
                    </button>
                  </form>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
