import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import NewEpicFab from "./new-epic-fab";

export const dynamic = "force-dynamic";

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

export default async function EpicsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { slug } = await params;
  const { status } = await searchParams;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!project) notFound();

  const statusFilter = status === "done" || status === "archived" ? status : "open";

  const principals = await listAssignablePrincipals();

  const epics = await db.epic.findMany({
    where: { projectId: project.id, status: statusFilter, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    include: {
      assignee: { select: { username: true } },
      actingManager: { select: { username: true } },
      _count: { select: { tasks: true, attachments: true } },
    },
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <nav className="text-sm">
            <Link
              href={`/projects/${slug}`}
              className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
            >
              ← {project.name}
            </Link>
          </nav>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Epics</h1>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 text-xs">
          {(["open", "done", "archived"] as const).map((s) => (
            <Link
              key={s}
              href={`/projects/${slug}/epics?status=${s}`}
              className={
                statusFilter === s
                  ? "rounded-lg bg-[var(--color-accent)] px-3 py-1 font-medium text-[var(--color-bg)]"
                  : "rounded-lg px-3 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              }
            >
              {s}
            </Link>
          ))}
        </div>
      </header>

      {epics.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-sm text-[var(--color-text-muted)]">
          No epics with status “{statusFilter}”.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-sm">
          <div className="grid grid-cols-[minmax(0,1fr)_6rem_8rem_8rem_4rem_4rem_7rem] items-center gap-3 border-b border-[var(--color-line)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <span>Epic</span>
            <span>Status</span>
            <span>Assignee</span>
            <span>Acting mgr</span>
            <span className="text-right">Tasks</span>
            <span className="text-right">Files</span>
            <span className="text-right">Updated</span>
          </div>
          <ul>
            {epics.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/projects/${slug}/epics/${e.id}`}
                  className="grid grid-cols-[minmax(0,1fr)_6rem_8rem_8rem_4rem_4rem_7rem] items-center gap-3 border-b border-[var(--color-line)] px-4 py-2.5 text-sm transition last:border-b-0 hover:bg-[var(--color-panel-soft)]"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{e.title}</span>
                    {e.description ? (
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">
                        {e.description}
                      </span>
                    ) : null}
                  </span>
                  <span>
                    <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                      {e.status}
                    </span>
                  </span>
                  <span className="truncate text-xs text-[var(--color-text-muted)]">
                    {e.assignee ? `@${e.assignee.username}` : "—"}
                  </span>
                  <span className="truncate text-xs text-[var(--color-text-muted)]">
                    {e.actingManager ? `@${e.actingManager.username}` : "—"}
                  </span>
                  <span className="text-right text-xs tabular-nums">
                    {e._count.tasks}
                  </span>
                  <span className="text-right text-xs tabular-nums">
                    {e._count.attachments}
                  </span>
                  <time
                    dateTime={e.updatedAt.toISOString()}
                    title={e.updatedAt.toISOString()}
                    className="text-right text-xs tabular-nums text-[var(--color-text-muted)]"
                  >
                    {timeAgo(e.updatedAt)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <NewEpicFab projectSlug={slug} principals={principals} />
    </div>
  );
}
