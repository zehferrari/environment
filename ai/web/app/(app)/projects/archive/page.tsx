import Link from "next/link";
import { db } from "@/lib/db";
import { unarchiveProject } from "@/lib/projects/actions";
import {
  accessibleEpicWhere,
  accessibleProjectWhere,
  accessibleTaskWhere,
  requireViewer,
} from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default async function ProjectArchivePage() {
  const viewer = await requireViewer();
  const projects = await db.project.findMany({
    where: accessibleProjectWhere(viewer, { archivedAt: { not: null }, deletedAt: null }),
    orderBy: { archivedAt: "desc" },
    include: {
      _count: {
        select: {
          epics: { where: accessibleEpicWhere(viewer) },
          tasks: { where: accessibleTaskWhere(viewer) },
          attachments: {
            where: {
              OR: [
                { task: { is: accessibleTaskWhere(viewer) } },
                { epic: { is: accessibleEpicWhere(viewer) } },
              ],
            },
          },
        },
      },
    },
  });

  return (
    <div className="max-w-4xl">
      <nav className="mb-3 text-body">
        <Link
          href="/projects"
          className="text-text-muted hover:underline"
        >
          ← Projects
        </Link>
      </nav>
      <h1 className="mb-1 text-display font-semibold tracking-tight">
        Archived projects
      </h1>
      <p className="mb-6 text-caption text-text-muted">
        Archived projects are hidden from the active project lists and the
        sidebar. Nothing is deleted or purged — unarchive to bring a project
        back at any time.
      </p>

      {projects.length === 0 ? (
        <p className="rounded-card border border-dashed border-line p-6 text-center text-body text-text-muted">
          No archived projects.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-panel border border-line bg-panel">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-card px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium">{p.name}</div>
                <div className="text-caption text-text-muted">
                  /{p.slug} · {p._count.epics} epic
                  {p._count.epics === 1 ? "" : "s"} · {p._count.tasks} task
                  {p._count.tasks === 1 ? "" : "s"} · {p._count.attachments} file
                  {p._count.attachments === 1 ? "" : "s"} · archived{" "}
                  {p.archivedAt ? timeAgo(p.archivedAt) : "?"}
                </div>
              </div>
              <form action={unarchiveProject}>
                <input type="hidden" name="projectSlug" value={p.slug} />
                <button
                  type="submit"
                  className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-caption font-medium hover:border-accent"
                >
                  Unarchive
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
