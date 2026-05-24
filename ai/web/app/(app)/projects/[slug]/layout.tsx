import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
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
    select: { id: true, slug: true, name: true, deletedAt: true },
  });
  if (!project || project.deletedAt) notFound();

  return (
    <div>
      <header className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          <Link href={`/projects/${project.slug}`} className="hover:underline">
            {project.name}
          </Link>
        </h1>
        <div className="text-xs text-[var(--color-text-muted)]">/{project.slug}</div>
      </header>
      <ProjectTabs slug={project.slug} />
      {children}
    </div>
  );
}
