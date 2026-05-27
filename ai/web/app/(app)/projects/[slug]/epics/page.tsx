import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { actorDisplayName, MessageAvatar } from "@/components/message-avatar";
import { binEpic } from "@/lib/bin/actions";
import { createEpic } from "@/lib/epics/actions";
import { resolveDoneTtlDays } from "@/lib/settings/system";
import { formatGridDate } from "@/lib/date-format";
import NewEpicFab from "./new-epic-fab";
import EpicStatusFilter from "./epic-status-filter";

export const dynamic = "force-dynamic";

const BOARD_STATUSES = ["Backlog", "Open", "Done"] as const;

function normalizeView(value: string | undefined) {
  return value?.toLowerCase() === "archive" ? "archive" : "board";
}

function parseBoardStatuses(statuses: string | undefined, legacyStatus: string | undefined) {
  if (!statuses && legacyStatus) {
    const match = BOARD_STATUSES.find((status) => status.toLowerCase() === legacyStatus.toLowerCase());
    if (match) return [match];
  }
  if (statuses === undefined) return [...BOARD_STATUSES];
  const requested = statuses.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return BOARD_STATUSES.filter((status) => requested.includes(status.toLowerCase()));
}

export default async function EpicsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ view?: string; statuses?: string; status?: string }>;
}) {
  const { slug } = await params;
  const { view: rawView, statuses, status } = await searchParams;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, name: true, doneTtlDays: true },
  });
  if (!project) notFound();

  const view = normalizeView(rawView ?? (status?.toLowerCase() === "archive" ? "archive" : undefined));
  const selectedStatuses = parseBoardStatuses(statuses, status);
  const doneTtlDays = await resolveDoneTtlDays(project.doneTtlDays);
  const doneCutoff = new Date(Date.now() - doneTtlDays * 24 * 60 * 60 * 1000);

  const principals = await listAssignablePrincipals();

  const epics = await db.epic.findMany({
    where: {
      projectId: project.id,
      status: view === "archive" ? "Archive" : { in: selectedStatuses },
      deletedAt: null,
    },
    orderBy: { updatedAt: "desc" },
    include: {
      assignee: { select: { username: true } },
      actingManager: { select: { username: true } },
      reporter: {
        select: {
          id: true,
          username: true,
          kind: true,
          name: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, name: true, avatar: true } },
        },
      },
      _count: { select: { tasks: true } },
    },
  });
  const visibleEpics = view === "board"
    ? epics.filter((epic) => epic.status !== "Done" || !epic.statusChangedAt || epic.statusChangedAt >= doneCutoff)
    : epics;

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
          <Link
            href={`/projects/${slug}/epics?view=board`}
            className={
              view === "board"
                ? "rounded-lg bg-[var(--color-accent)] px-3 py-1 font-medium text-[var(--color-bg)]"
                : "rounded-lg px-3 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            Board
          </Link>
          <Link
            href={`/projects/${slug}/epics?view=archive`}
            className={
              view === "archive"
                ? "rounded-lg bg-[var(--color-accent)] px-3 py-1 font-medium text-[var(--color-bg)]"
                : "rounded-lg px-3 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            Archive
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <EpicStatusFilter
          projectSlug={slug}
          selectedStatuses={selectedStatuses}
          disabled={view === "archive"}
        />
        <p className="text-xs text-[var(--color-text-muted)]">
          {view === "archive"
            ? "Showing archived epics."
            : "Board shows Backlog, Open, and Done epics based on the selected statuses."}
        </p>
      </div>

      {visibleEpics.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-sm text-[var(--color-text-muted)]">
          No epics match the current filter.
        </p>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] shadow-sm">
          <div className="grid grid-cols-[minmax(0,1fr)_6rem_8rem_8rem_8rem_3rem_5rem_2rem] items-center gap-3 border-b border-[var(--color-line)] px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            <span>Epic</span>
            <span>Status</span>
            <span>Report by</span>
            <span>Assignee</span>
            <span>Acting mgr</span>
            <span className="text-right">Tasks</span>
            <span className="text-right">Created At</span>
            <span className="sr-only">Bin</span>
          </div>
          <ul>
            {visibleEpics.map((e) => (
              <li key={e.id} className="relative border-b border-[var(--color-line)] last:border-b-0 transition hover:bg-[var(--color-panel-soft)]">
                <Link
                  href={`/projects/${slug}/epics/${e.id}`}
                  className="absolute inset-0 z-0"
                  aria-label={`Open ${e.title}`}
                />
                <div className="grid grid-cols-[minmax(0,1fr)_6rem_8rem_8rem_8rem_3rem_5rem_2rem] items-center gap-3 px-4 py-2.5 text-sm">
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
                  <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-muted)]">
                    {e.reporter ? <MessageAvatar actor={e.reporter} size="sm" /> : null}
                    <span className="truncate">{e.reporter ? actorDisplayName(e.reporter) : "—"}</span>
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
                  <time
                    dateTime={e.createdAt.toISOString()}
                    title={e.createdAt.toISOString()}
                    className="text-right text-xs tabular-nums text-[var(--color-text-muted)]"
                  >
                    {formatGridDate(e.createdAt)}
                  </time>
                  <form action={binEpic} className="relative z-10 text-right">
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="epicId" value={e.id} />
                    <button
                      type="submit"
                      className="rounded-md px-1.5 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-crit)]/10 hover:text-[var(--color-crit)]"
                      aria-label={`Move ${e.title} to bin`}
                      title="Move to bin"
                    >
                      <TrashIcon />
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <NewEpicFab projectSlug={slug} principals={principals} createEpicAction={createEpic} />
    </div>
  );
}

function TrashIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M6 6l1 15h10l1-15" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}
