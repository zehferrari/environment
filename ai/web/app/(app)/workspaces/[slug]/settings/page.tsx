import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getWorkspaceBySlug, normalizeWorkspaceSlug, serializeWorkspace } from "@/lib/workspaces/service";
import WorkspaceSettingsClient from "./workspace-settings-client";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await params;
  const slug = normalizeWorkspaceSlug(rawSlug);
  const [workspaceRow, projects, agents] = await Promise.all([
    getWorkspaceBySlug(slug),
    db.project.findMany({
      where: { deletedAt: null },
      orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
      select: { id: true, slug: true, name: true, archivedAt: true },
    }),
    db.agent.findMany({
      where: { role: "coding", deactivatedAt: null, user: { is: { status: "active" } } },
      orderBy: { slug: "asc" },
      select: { id: true, slug: true, name: true, role: true },
    }),
  ]);

  if (!workspaceRow) notFound();

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-2 text-caption text-text-muted">
            <Link href="/workspaces" className="hover:text-accent">Workspaces</Link>
            <span className="mx-2">/</span>
            <span>{workspaceRow.name}</span>
          </div>
          <h1 className="text-display font-semibold tracking-tight">Workspace settings</h1>
          <p className="mt-1 text-body text-text-muted">
            Edit identity, related projects, archive state, and the coding-agent pool for this workspace.
          </p>
        </div>
        <Link
          href="/workspaces"
          className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent"
        >
          All workspaces
        </Link>
      </div>

      <WorkspaceSettingsClient
        initialWorkspace={serializeWorkspace(workspaceRow)}
        projects={projects.map((project) => ({
          id: project.id,
          slug: project.slug,
          name: project.name,
          archived: project.archivedAt != null,
        }))}
        agents={agents}
      />
    </div>
  );
}
