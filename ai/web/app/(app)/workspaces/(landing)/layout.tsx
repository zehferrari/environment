import { db } from "@/lib/db";
import {
  accessibleProjectWhere,
  requireViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";
import WorkspacesLandingTabs from "./workspaces-landing-tabs";
import { LANDING_CHROME_SCOPE } from "./landing-chrome";

// Landing layout for /workspaces. Kept in a (landing) route group so the
// @workspace parallel slot below is scoped to the landing page only and does
// not interfere with the per-workspace [slug] slot one level down.
export default async function WorkspacesLandingLayout({
  children,
  workspace: taskWorkspace,
}: {
  children: React.ReactNode;
  workspace: React.ReactNode;
}) {
  const viewer = await requireViewer();

  const workspaces = await db.workspace.findMany({
    where: { AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)] },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    select: {
      name: true,
      projects: {
        where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
        select: { projectId: true },
      },
    },
  });
  const projectCount = new Set(
    workspaces.flatMap((workspace) => workspace.projects.map(({ projectId }) => projectId)),
  ).size;

  return (
    <div
      data-board-layout
      className="[--page-available-height:calc(100dvh-5.5rem)] [--page-sticky-top:4.5rem] [--board-available-height:var(--page-available-height)] [--board-sticky-top:var(--page-sticky-top)]"
    >
      <header className="mb-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-1 text-caption text-text-muted">
            <span>workspaces</span>
          </div>
          <div>
            <h1 className="text-display font-semibold tracking-tight">Workspaces</h1>
            <p className="mt-1 text-body text-text-muted">
              Unified board across {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"} and {projectCount} project{projectCount === 1 ? "" : "s"}
              {workspaces.length > 0 ? `: ${workspaces.map((workspace) => workspace.name).join(", ")}` : ""}.
            </p>
          </div>
        </div>
      </header>

      <WorkspacesLandingTabs
        boardChromeScope={LANDING_CHROME_SCOPE}
        isOwner={viewer.isOwner}
      />
      {/* Same split-viewport contract as the per-workspace layout: the board
          stays mounted while a task route is intercepted; at the 146rem /ws
          threshold the task renders beside the board, below it the open task
          hides the board and behaves like full-width navigation. */}
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
