import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { repoHasReadme } from "@/lib/projects/repo-readme";
import ProjectTabs from "./project-tabs";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug },
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
    db.epic.count({ where: { projectId: project.id, deletedAt: { not: null } } }),
    db.task.count({ where: { projectId: project.id, deletedAt: { not: null } } }),
  ]);
  const hasBin = binnedEpics + binnedTasks > 0;

  return (
    <div>
      <header className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          <Link href={`/projects/${project.slug}`} className="hover:underline">
            {project.name}
          </Link>
        </h1>
        <div className="flex items-center gap-1 text-xs text-text-muted">
          <Link
            href="/projects"
            className="hover:text-text hover:underline"
          >
            projects
          </Link>
          <span>/</span>
          <span>{project.slug}</span>
        </div>
      </header>
      <ProjectTabs slug={project.slug} hasSummary={hasSummary} hasCode={hasCode} hasBin={hasBin} />
      {children}
    </div>
  );
}
