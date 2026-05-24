import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { restoreTask, restoreEpic } from "@/lib/bin/actions";

export const dynamic = "force-dynamic";

const PURGE_TTL_DAYS = 7;

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function daysUntilPurge(deletedAt: Date): number {
  const elapsedMs = Date.now() - deletedAt.getTime();
  const remainingMs = PURGE_TTL_DAYS * 86400_000 - elapsedMs;
  return Math.max(0, Math.ceil(remainingMs / 86400_000));
}

export default async function BinPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!project) notFound();

  const [deletedEpics, deletedTasks] = await Promise.all([
    db.epic.findMany({
      where: { projectId: project.id, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      include: {
        deletedBy: { select: { username: true, kind: true } },
        _count: {
          select: {
            tasks: { where: { deletedAt: { not: null } } },
          },
        },
      },
    }),
    db.task.findMany({
      where: { projectId: project.id, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      include: {
        deletedBy: { select: { username: true, kind: true } },
        epic: { select: { id: true, title: true } },
        parent: { select: { id: true, title: true } },
        _count: {
          select: {
            subtasks: { where: { deletedAt: { not: null } } },
          },
        },
      },
    }),
  ]);

  return (
    <div className="space-y-6">
      <p className="text-xs text-[var(--color-text-muted)]">
        Soft-deleted Epics and Tasks. Anything left here for more than{" "}
        {PURGE_TTL_DAYS} days is hard-deleted by the hourly purge job.
      </p>

      {deletedEpics.length === 0 && deletedTasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-sm text-[var(--color-text-muted)]">
          The bin is empty.
        </p>
      ) : null}

      {deletedEpics.length > 0 ? (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Deleted Epics ({deletedEpics.length})
          </h2>
          <ul className="space-y-2">
            {deletedEpics.map((e) => {
              const childrenInBin = e._count.tasks;
              const purgeIn = e.deletedAt ? daysUntilPurge(e.deletedAt) : null;
              return (
                <li
                  key={e.id}
                  className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{e.title}</div>
                      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                        Deleted{" "}
                        <time
                          dateTime={e.deletedAt?.toISOString()}
                          title={e.deletedAt?.toISOString()}
                        >
                          {e.deletedAt ? timeAgo(e.deletedAt) : ""}
                        </time>
                        {e.deletedBy ? (
                          <>
                            {" "}by @{e.deletedBy.username}
                            {e.deletedBy.kind === "agent" ? " (agent)" : ""}
                          </>
                        ) : null}
                        {purgeIn !== null ? (
                          <> · purge in {purgeIn}d</>
                        ) : null}
                        {childrenInBin > 0 ? (
                          <> · {childrenInBin} child task{childrenInBin === 1 ? "" : "s"} in bin</>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <form action={restoreEpic}>
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="epicId" value={e.id} />
                        <button
                          type="submit"
                          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
                        >
                          Restore
                        </button>
                      </form>
                      {childrenInBin > 0 ? (
                        <form action={restoreEpic}>
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="epicId" value={e.id} />
                          <input type="hidden" name="withChildren" value="true" />
                          <button
                            type="submit"
                            className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
                            title={`Also restore ${childrenInBin} child task${childrenInBin === 1 ? "" : "s"} that were deleted by this cascade`}
                          >
                            Restore + {childrenInBin} child
                            {childrenInBin === 1 ? "" : "ren"}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {deletedTasks.length > 0 ? (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Deleted Tasks ({deletedTasks.length})
          </h2>
          <ul className="space-y-2">
            {deletedTasks.map((t) => {
              const childrenInBin = t._count.subtasks;
              const purgeIn = t.deletedAt ? daysUntilPurge(t.deletedAt) : null;
              return (
                <li
                  key={t.id}
                  className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold">{t.title}</div>
                      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                        Status before delete: {t.status}
                        {t.epic ? <> · epic: {t.epic.title}</> : null}
                        {t.parent ? <> · parent: {t.parent.title}</> : null}
                      </div>
                      <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                        Deleted{" "}
                        <time
                          dateTime={t.deletedAt?.toISOString()}
                          title={t.deletedAt?.toISOString()}
                        >
                          {t.deletedAt ? timeAgo(t.deletedAt) : ""}
                        </time>
                        {t.deletedBy ? (
                          <>
                            {" "}by @{t.deletedBy.username}
                            {t.deletedBy.kind === "agent" ? " (agent)" : ""}
                          </>
                        ) : null}
                        {purgeIn !== null ? <> · purge in {purgeIn}d</> : null}
                        {childrenInBin > 0 ? (
                          <> · {childrenInBin} sub-task{childrenInBin === 1 ? "" : "s"} in bin</>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <form action={restoreTask}>
                        <input type="hidden" name="projectSlug" value={slug} />
                        <input type="hidden" name="taskId" value={t.id} />
                        <button
                          type="submit"
                          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
                        >
                          Restore
                        </button>
                      </form>
                      {childrenInBin > 0 ? (
                        <form action={restoreTask}>
                          <input type="hidden" name="projectSlug" value={slug} />
                          <input type="hidden" name="taskId" value={t.id} />
                          <input type="hidden" name="withChildren" value="true" />
                          <button
                            type="submit"
                            className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] hover:opacity-90"
                            title={`Also restore ${childrenInBin} sub-task${childrenInBin === 1 ? "" : "s"} that were deleted by this cascade`}
                          >
                            Restore + {childrenInBin} sub-task
                            {childrenInBin === 1 ? "" : "s"}
                          </button>
                        </form>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
