import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { renderFullMarkdown } from "@/lib/markdown";
import { readRepoReadme } from "@/lib/projects/repo-readme";

export const dynamic = "force-dynamic";

// Project "Summary" tab — renders the README.md at the root of the project's
// configured repository folder. The tab is only shown (see project-tabs.tsx)
// when that README exists; direct hits with no repo/README 404.
export default async function ProjectSummaryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug },
    select: { repositoryPath: true, deletedAt: true },
  });
  if (!project || project.deletedAt) notFound();

  const readme = await readRepoReadme(project.repositoryPath);
  if (readme === null) notFound();

  return (
    <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-sm">
      <div className="md" dangerouslySetInnerHTML={renderFullMarkdown(readme)} />
    </section>
  );
}
