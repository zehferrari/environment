import Link from "next/link";
import { db } from "@/lib/db";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";

export const dynamic = "force-dynamic";

export default async function WorkspacesPage() {
  const [workspaces, archivedCount] = await Promise.all([
    db.workspace.findMany({
      where: { archivedAt: null },
      orderBy: [{ type: "asc" }, { name: "asc" }],
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
          <h1 className="text-display font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-1 text-body text-text-muted">
            Group projects and coding-agent pools into operating contexts.
          </p>
        </div>
        {archivedCount > 0 ? (
          <span className="rounded-full border border-line bg-panel px-3 py-1 text-caption text-text-muted">
            {archivedCount} archived
          </span>
        ) : null}
      </div>

      {workspaces.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line bg-panel p-card text-body text-text-muted">
          No active workspaces yet. Use the workspace API to create one, then manage projects, boards, and agents here.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-card sm:grid-cols-2 xl:grid-cols-3">
          {workspaces.map((workspace) => {
            const logoUrl = workspace.logoPath ? workspaceLogoPublicUrl(workspace.slug, workspace.logoUpdatedAt) : null;
            return (
              <Link
                key={workspace.id}
                href={`/workspaces/${workspace.slug}`}
                className="group flex min-h-48 flex-col gap-4 rounded-panel border border-line bg-panel p-card shadow-sm transition hover:border-accent hover:shadow-md"
              >
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
                    <div className="mt-1 inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-accent">
                      {workspace.type}
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
            );
          })}
        </div>
      )}
    </div>
  );
}
