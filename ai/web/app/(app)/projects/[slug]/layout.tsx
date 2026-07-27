import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { repoHasReadme } from "@/lib/projects/repo-readme";
import ProjectTabs from "./project-tabs";
import {
  accessibleEpicWhere,
  accessibleProjectWhere,
  accessibleTaskWhere,
  requireViewer,
} from "@/lib/auth/permissions";

export default async function ProjectLayout({
  children,
  workspace,
  params,
}: {
  children: React.ReactNode;
  workspace: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const viewer = await requireViewer();
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug }),
    select: {
      id: true,
      slug: true,
      name: true,
      deletedAt: true,
      repositoryPath: true,
    },
  });
  if (!project || project.deletedAt) notFound();

  // Show the Summary tab only when the configured repo folder has a README.
  const hasSummary = repoHasReadme(project.repositoryPath);
  const hasCode = Boolean(project.repositoryPath);

  // The Bin tab only appears when something is actually in the bin.
  const [binnedEpics, binnedTasks] = await Promise.all([
    db.epic.count({ where: accessibleEpicWhere(viewer, { projectId: project.id, deletedAt: { not: null } }) }),
    db.task.count({ where: accessibleTaskWhere(viewer, { projectId: project.id, deletedAt: { not: null } }) }),
  ]);
  const hasBin = binnedEpics + binnedTasks > 0;
  const boardChromeScope = `project-${project.slug}`;

  return (
    <div
      data-board-layout
      className="[--page-available-height:calc(100dvh-5.5rem)] [--page-sticky-top:4.5rem] [--board-available-height:var(--page-available-height)] [--board-sticky-top:var(--page-sticky-top)]"
    >
      <header className="mb-4">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2 text-caption font-medium text-text-muted">
            <Link
              href="/projects"
              className="rounded-md px-1.5 py-0.5 transition hover:bg-accent-soft hover:text-accent"
            >
              Projects
            </Link>
            <span className="text-text-dim">/</span>
            <span className="truncate font-mono text-micro uppercase tracking-[0.12em]">{project.slug}</span>
          </div>
          <h1 className="text-display font-semibold tracking-[-0.035em] text-text">
            <Link href={`/projects/${project.slug}`} className="hover:underline">
              {project.name}
            </Link>
          </h1>
        </div>
      </header>
      <ProjectTabs
        slug={project.slug}
        name={project.name}
        boardChromeScope={boardChromeScope}
        hasSummary={hasSummary}
        hasCode={viewer.isOwner && hasCode}
        hasBin={hasBin}
        canAccessSettings={viewer.isOwner}
      />
      {/* ENV-110 split workspace, sized on AVAILABLE width, not the viewport:
          the @container/ws wrapper measures the real project content width
          after the sidebar (256px expanded / 64px collapsed), main padding,
          shell cap, and the 5xl command-deck rail have taken their share.
          Split view activates at 146rem (2336px = 1200px board minimum +
          16px gap + 1120px detail pane); otherwise the intercepted task
          (data-ws-open) hides the board — matching plain route navigation.
          Being pure CSS container queries, activation tracks live resize and
          sidebar collapse without any JS. */}
      <div className="@container/ws">
        <div className="group/ws @min-[146rem]/ws:flex @min-[146rem]/ws:items-start @min-[146rem]/ws:gap-4">
          <div className="@container/board min-w-0 flex-1 group-has-[[data-ws-open]]/ws:hidden @min-[146rem]/ws:group-has-[[data-ws-open]]/ws:block">
            {children}
          </div>
          {workspace}
        </div>
      </div>
    </div>
  );
}
