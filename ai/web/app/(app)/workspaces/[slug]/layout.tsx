import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  accessibleProjectWhere,
  requireViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";
import { normalizeWorkspaceSlug } from "@/lib/workspaces/service";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";
import WorkspaceTabs from "./workspace-tabs";

export default async function WorkspaceLayout({
  children,
  workspace: taskWorkspace,
  params,
}: {
  children: React.ReactNode;
  workspace: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const viewer = await requireViewer();
  const { slug: rawSlug } = await params;
  let slug: string;
  try {
    slug = normalizeWorkspaceSlug(rawSlug);
  } catch {
    notFound();
  }

  const workspace = await db.workspace.findFirst({
    where: { AND: [{ slug }, workspaceAccessWhere(viewer)] },
    select: {
      slug: true,
      name: true,
      archivedAt: true,
      logoPath: true,
      logoUpdatedAt: true,
      projects: {
        where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
        orderBy: { createdAt: "asc" },
        select: { project: { select: { name: true } } },
      },
    },
  });
  if (!workspace) notFound();

  const boardChromeScope = `workspace-${workspace.slug}`;
  const projectNames = workspace.projects.map(({ project }) => project.name).join(", ");

  return (
    <div
      data-board-layout
      className="[--page-available-height:calc(100dvh-5.5rem)] [--page-sticky-top:4.5rem] [--board-available-height:var(--page-available-height)] [--board-sticky-top:var(--page-sticky-top)]"
    >
      <header className="mb-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1 text-caption text-text-muted">
            <Link href="/workspaces" className="hover:text-text hover:underline">workspaces</Link>
            <span>/</span>
            <span>{workspace.slug}</span>
          </div>
          <div>
            <div className="flex items-center gap-3">
              {workspace.logoPath ? (
                <img
                  src={workspaceLogoPublicUrl(workspace.slug, workspace.logoUpdatedAt)}
                  alt={`${workspace.name} logo`}
                  className="h-10 w-10 shrink-0 rounded-lg border border-line bg-panel object-cover"
                />
              ) : null}
              <h1 className="text-display font-semibold tracking-tight">{workspace.name}</h1>
            </div>
            <p className="mt-1 text-body text-text-muted">
              Unified board across {workspace.projects.length} project{workspace.projects.length === 1 ? "" : "s"}
              {projectNames ? `: ${projectNames}` : ""}.
            </p>
            {workspace.archivedAt ? (
              <div className="mt-3 rounded-card border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-caption text-amber-800">
                This workspace is archived and hidden from default navigation. Direct access remains available and project history is preserved.
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <WorkspaceTabs
        slug={workspace.slug}
        name={workspace.name}
        boardChromeScope={boardChromeScope}
        canAccessSettings={viewer.isOwner}
      />
      {/* Keep the workspace board mounted while a task route is intercepted.
          At the same /ws container thresholds as a project board, the task
          renders beside the board; below the split threshold the open task
          hides the board and behaves like normal full-width navigation. */}
      <div className="@container/ws">
        <div className="group/ws @min-[146rem]/ws:flex @min-[146rem]/ws:items-start @min-[146rem]/ws:gap-4">
          <div className="@container/board min-w-0 flex-1 group-has-[[data-ws-open]]/ws:hidden @min-[146rem]/ws:group-has-[[data-ws-open]]/ws:block">
            {children}
          </div>
          {taskWorkspace}
        </div>
      </div>
    </div>
  );
}
