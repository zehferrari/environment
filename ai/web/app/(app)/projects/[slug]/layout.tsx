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

  return (
    <div>
      <header className="mb-4">
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
      </header>
      <ProjectTabs
        slug={project.slug}
        hasSummary={hasSummary}
        hasCode={viewer.isOwner && hasCode}
        hasBin={hasBin}
        canAccessSettings={viewer.isOwner}
      />
      {/* ENV-110 split workspace: when the workspace slot holds an
          intercepted task (data-ws-open), the children slot (board) hides
          below 4xl — matching plain route navigation — and sits beside the
          task pane at 4xl+. */}
      <div className="group/ws 4xl:flex 4xl:items-start 4xl:gap-4">
        <div className="min-w-0 flex-1 group-has-[[data-ws-open]]/ws:hidden 4xl:group-has-[[data-ws-open]]/ws:block">
          {children}
        </div>
        {workspace}
      </div>
    </div>
  );
}
