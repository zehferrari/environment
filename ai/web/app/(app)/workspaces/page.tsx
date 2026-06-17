import Link from "next/link";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { restoreWorkspace } from "@/lib/workspaces/service";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";

export const dynamic = "force-dynamic";

async function restoreWorkspaceAction(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthenticated");
  const slug = String(formData.get("slug") ?? "");
  await restoreWorkspace(slug);
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${slug}`);
  revalidatePath(`/workspaces/${slug}/settings`);
}

export default async function WorkspacesPage({ searchParams }: { searchParams?: Promise<{ archived?: string }> }) {
  const params = await searchParams;
  const showingArchived = params?.archived === "1";
  const [workspaces, archivedCount] = await Promise.all([
    db.workspace.findMany({
      where: showingArchived ? { archivedAt: { not: null } } : { archivedAt: null },
      orderBy: showingArchived ? [{ archivedAt: "desc" }, { name: "asc" }] : [{ type: "asc" }, { name: "asc" }],
      include: {
        projects: { select: { projectId: true } },
        agentPool: { select: { agentId: true } },
      },
    }),
    db.workspace.count({ where: { archivedAt: { not: null } } }),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-display font-semibold tracking-tight">{showingArchived ? "Archived workspaces" : "Workspaces"}</h1>
          <p className="mt-1 text-body text-text-muted">
            {showingArchived
              ? "Restore inactive workspaces without deleting their projects, tasks, or history."
              : "Group projects and coding-agent pools into operating contexts."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      {workspaces.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line bg-panel p-card text-body text-text-muted">
          {showingArchived
            ? "No archived workspaces. Archived workspaces will appear here for restore."
            : "No active workspaces yet. Use the workspace API to create one, then manage projects, boards, and agents here."}
        </div>
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
                    <div className="rounded-xl border border-line bg-bg px-3 py-2">
                      <dt className="text-nano uppercase tracking-wider">Agent pool</dt>
                      <dd className="text-body font-semibold text-text">{workspace.agentPool.length}</dd>
                    </div>
                  </dl>
                </Link>
                {showingArchived ? (
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
