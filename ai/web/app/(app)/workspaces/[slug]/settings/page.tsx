import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getWorkspaceBySlug, normalizeWorkspaceSlug, serializeWorkspace } from "@/lib/workspaces/service";
import WorkspaceSettingsClient from "./workspace-settings-client";
import { getViewer } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = await getViewer();
  if (!viewer?.canAccessOwnerFeatures) notFound();
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
      <div>
        <h2 className="text-heading font-semibold tracking-tight">Workspace settings</h2>
        <p className="mt-1 text-body text-text-muted">
          Edit identity, related projects, archive state, and the coding-agent pool for this workspace.
        </p>
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
