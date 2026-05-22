import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { createEpic } from "@/lib/epics/actions";
import { listAssignablePrincipals } from "@/lib/principals";

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

      <form
        action={createEpic}
        className="space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
      >
        <input type="hidden" name="projectSlug" value={slug} />
        <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          New epic
        </div>
        <input
          name="title"
          required
          maxLength={200}
          placeholder="Epic title"
          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <textarea
          name="description"
          rows={12}
          placeholder="Description (optional) — markdown supported"
          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]"
        />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex-1 min-w-[200px] text-xs">
            <span className="mb-1 block text-[var(--color-text-muted)]">
              Acting manager
            </span>
            <select
              name="actingManagerId"
              defaultValue=""
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            >
              <option value="">No acting manager</option>
              {principals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.username}
                  {p.kind === "agent" ? " (agent)" : ""}
                </option>
              ))}
            </select>
          </label>
          <p className="flex-[2] text-xs text-[var(--color-text-muted)]">
            After creating, you can upload attachments and set the assignee on
            the epic page.
          </p>
          <button
            type="submit"
            className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
          >
            Create epic
          </button>
        </div>
      </form>

      {epics.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-sm text-[var(--color-text-muted)]">
          No epics with status “{statusFilter}”.
        </p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {epics.map((e) => (
            <li key={e.id}>
              <Link
                href={`/projects/${slug}/epics/${e.id}`}
                className="block rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--color-accent)] hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <h2 className="truncate text-base font-semibold">{e.title}</h2>
                  <span className="shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider">
                    {e.status}
                  </span>
                </div>
                {e.description ? (
                  <p className="mt-1 line-clamp-2 text-xs text-[var(--color-text-muted)]">
                    {e.description}
                  </p>
                ) : null}
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <div className="flex items-center gap-1">
                    <dt className="text-[var(--color-text-muted)]">Assignee</dt>
                    <dd>{e.assignee ? `@${e.assignee.username}` : "—"}</dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt className="text-[var(--color-text-muted)]">Acting mgr</dt>
                    <dd>{e.actingManager ? `@${e.actingManager.username}` : "—"}</dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt className="text-[var(--color-text-muted)]">Tasks</dt>
                    <dd>{e._count.tasks}</dd>
                  </div>
                  <div className="flex items-center gap-1">
                    <dt className="text-[var(--color-text-muted)]">Files</dt>
                    <dd>{e._count.attachments}</dd>
                  </div>
                </dl>
                <div className="mt-3 text-[11px] text-[var(--color-text-muted)]">
                  Updated{" "}
                  <time
                    dateTime={e.updatedAt.toISOString()}
                    title={e.updatedAt.toISOString()}
                  >
                    {timeAgo(e.updatedAt)}
                  </time>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
