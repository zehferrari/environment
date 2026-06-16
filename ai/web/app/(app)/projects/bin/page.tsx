import Link from "next/link";
import { db } from "@/lib/db";
import { restoreProject } from "@/lib/projects/actions";

export const dynamic = "force-dynamic";

const PROJECT_BIN_TTL_DAYS = Math.max(
  1,
  Number(process.env.PM_PROJECT_BIN_TTL_DAYS ?? "30") || 30,
);

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function daysLeft(deletedAt: Date): number {
  const elapsedMs = Date.now() - deletedAt.getTime();
  const remaining = PROJECT_BIN_TTL_DAYS - elapsedMs / 86400_000;
  return Math.max(0, Math.ceil(remaining));
}

export default async function ProjectBinPage() {
  const projects = await db.project.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    include: {
      deletedBy: { select: { username: true } },
      _count: {
        select: {
          epics: true,
          tasks: true,
          attachments: true,
        },
      },
    },
  });

  return (
    <div className="max-w-4xl">
      <nav className="mb-3 text-sm">
        <Link
          href="/projects"
          className="text-text-muted hover:underline"
        >
          ← Projects
        </Link>
      </nav>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Project bin</h1>
      <p className="mb-6 text-xs text-text-muted">
        Projects in the bin are hard-deleted (along with all their epics,
        tasks, and attachments) {PROJECT_BIN_TTL_DAYS} days after the delete.
      </p>

      {projects.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-text-muted">
          The bin is empty.
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-2xl border border-line bg-panel">
          {projects.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-xs text-text-muted">
                  /{p.slug} · {p._count.epics} epic
                  {p._count.epics === 1 ? "" : "s"} · {p._count.tasks} task
                  {p._count.tasks === 1 ? "" : "s"} · {p._count.attachments} file
                  {p._count.attachments === 1 ? "" : "s"} · deleted{" "}
                  {p.deletedAt ? timeAgo(p.deletedAt) : "?"}
                  {p.deletedBy ? ` by @${p.deletedBy.username}` : ""} ·{" "}
                  {p.deletedAt ? `${daysLeft(p.deletedAt)}d left` : ""}
                </div>
              </div>
              <form action={restoreProject}>
                <input type="hidden" name="projectSlug" value={p.slug} />
                <button
                  type="submit"
                  className="rounded-lg border border-line bg-panel-soft px-3 py-1.5 text-xs font-medium hover:border-accent"
                >
                  Restore
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
