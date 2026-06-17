import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { actorDisplayName, MessageAvatar } from "@/components/message-avatar";
import { binEpic } from "@/lib/bin/actions";
import { createEpic } from "@/lib/epics/actions";
import { formatGridDate } from "@/lib/date-format";
import { deploymentStatusIcon } from "@/lib/deploy/deployment-status";
import NewEpicFab from "./new-epic-fab";
import EpicStatusFilter from "./epic-status-filter";

export const dynamic = "force-dynamic";

const BOARD_STATUSES = ["Backlog", "In Progress", "Ready to Deploy", "Done"] as const;
// Default board view surfaces in-flight work (Backlog + In Progress) and hides Done
// until the user opts back into it via the status filter.
const DEFAULT_BOARD_STATUSES = ["Backlog", "In Progress"] as const;
const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

function normalizeView(value: string | undefined) {
  return value?.toLowerCase() === "archive" ? "archive" : "board";
}

function parseBoardStatuses(statuses: string | undefined, legacyStatus: string | undefined) {
  if (!statuses && legacyStatus) {
    const match = BOARD_STATUSES.find((status) => status.toLowerCase() === legacyStatus.toLowerCase());
    if (match) return [match];
  }
  if (statuses === undefined) return [...DEFAULT_BOARD_STATUSES];
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
    select: { id: true, name: true },
  });
  if (!project) notFound();

  const view = normalizeView(rawView ?? (status?.toLowerCase() === "archive" ? "archive" : undefined));
  const selectedStatuses = parseBoardStatuses(statuses, status);

  const principals = await listAssignablePrincipals();

  const archivedCount = await db.epic.count({
    where: { projectId: project.id, archivedAt: { not: null }, deletedAt: null },
  });

  const epics = await db.epic.findMany({
    where: {
      projectId: project.id,
      archivedAt: view === "archive" ? { not: null } : null,
      ...(view === "board" ? { status: { in: selectedStatuses } } : {}),
      deletedAt: null,
    },
    orderBy: { updatedAt: "desc" },
    include: {
      actingManager: { select: actorSelect },
      reporter: { select: actorSelect },
      _count: {
        select: {
          tasks: { where: { deletedAt: null, parentTaskId: null } },
        },
      },
    },
  });
  const visibleEpics = epics;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <nav className="text-body">
            <Link
              href={`/projects/${slug}`}
              className="text-text-muted hover:text-text hover:underline"
            >
              ← {project.name}
            </Link>
          </nav>
          <h1 className="mt-1 text-display font-semibold tracking-tight">Epics</h1>
        </div>
        <div className="flex items-center gap-1 rounded-card border border-line bg-panel p-1 text-caption">
          <Link
            href={`/projects/${slug}/epics?view=board`}
            className={
              view === "board"
                ? "rounded-lg bg-accent px-3 py-1 font-medium text-bg"
                : "rounded-lg px-3 py-1 text-text-muted hover:text-text"
            }
          >
            Board
          </Link>
          {view === "archive" || archivedCount > 0 ? (
            <Link
              href={`/projects/${slug}/epics?view=archive`}
              className={
                view === "archive"
                  ? "rounded-lg bg-accent px-3 py-1 font-medium text-bg"
                  : "rounded-lg px-3 py-1 text-text-muted hover:text-text"
              }
            >
              Archive
            </Link>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <EpicStatusFilter
          projectSlug={slug}
          selectedStatuses={selectedStatuses}
          disabled={view === "archive"}
        />
        <p className="text-caption text-text-muted">
          {view === "archive"
            ? "Showing archived epics."
            : "Board defaults to Backlog and In Progress epics; add Ready to Deploy or Done from the status filter."}
        </p>
      </div>

      {visibleEpics.length === 0 ? (
        <p className="rounded-card border border-dashed border-line p-6 text-center text-body text-text-muted">
          No epics match the current filter.
        </p>
      ) : (
        <div className="overflow-hidden rounded-panel border border-line bg-panel shadow-sm">
          <div className="grid grid-cols-[minmax(0,1fr)_6rem_4rem_9rem_9rem_3rem_5rem_2rem] items-center gap-3 border-b border-line px-card py-control-y text-nano font-semibold uppercase tracking-wider text-text-muted">
            <span>Epic</span>
            <span>Status</span>
            <span>Deploy</span>
            <span>Report by</span>
            <span>Acting mgr</span>
            <span className="text-right">Tasks</span>
            <span className="text-right">Created At</span>
            <span className="sr-only">Bin</span>
          </div>
          <ul>
            {visibleEpics.map((e) => (
              <li key={e.id} className="relative border-b border-line last:border-b-0 transition hover:bg-panel-soft">
                <Link
                  href={`/projects/${slug}/epics/${e.id}`}
                  className="absolute inset-0 z-0"
                  aria-label={`Open ${e.title}`}
                />
                <div className="grid grid-cols-[minmax(0,1fr)_6rem_4rem_9rem_9rem_3rem_5rem_2rem] items-center gap-3 px-card py-control-y.5 text-body">
                  <span className="min-w-0">
                    {e.workItemKey ? (
                      <span className="mb-0.5 inline-flex rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-nano font-semibold text-text-muted">
                        {e.workItemKey}
                      </span>
                    ) : null}
                    <span className="block truncate font-medium">{e.title}</span>
                    {e.description ? (
                      <span className="block truncate text-caption text-text-muted">
                        {e.description}
                      </span>
                    ) : null}
                  </span>
                  <span>
                    <span className="rounded-full border border-line bg-panel-soft px-2 py-0.5 text-nano font-medium uppercase tracking-wider">
                      {e.status}
                    </span>
                  </span>
                  <DeploymentIndicator status={e.deploymentStatus} />
                  <span className="flex min-w-0 items-center gap-2 text-caption text-text-muted">
                    {e.reporter ? <MessageAvatar actor={e.reporter} size="sm" /> : null}
                    <span className="truncate">{e.reporter ? actorDisplayName(e.reporter) : "—"}</span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-caption text-text-muted">
                    {e.actingManager ? <MessageAvatar actor={e.actingManager} size="sm" /> : null}
                    <span className="truncate">{e.actingManager ? actorDisplayName(e.actingManager) : "—"}</span>
                  </span>
                  <span className="text-right text-caption tabular-nums">
                    {e._count.tasks}
                  </span>
                  <time
                    dateTime={e.createdAt.toISOString()}
                    title={e.createdAt.toISOString()}
                    className="text-right text-caption tabular-nums text-text-muted"
                  >
                    {formatGridDate(e.createdAt)}
                  </time>
                  <form action={binEpic} className="relative z-10 text-right">
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="epicId" value={e.id} />
                    <button
                      type="submit"
                      className="rounded-md px-1.5 py-1 text-text-muted hover:bg-crit/10 hover:text-crit"
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

function DeploymentIndicator({ status }: { status: string }) {
  const icon = deploymentStatusIcon(status);
  if (icon === "—") {
    return (
      <span
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line text-pico text-text-muted transition hover:scale-110 hover:border-accent"
        title="Deployment: Not Required"
        aria-label="Deployment: Not Required"
      >
        —
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-nano leading-none transition hover:scale-110"
      title={`Deployment: ${status}`}
      aria-label={`Deployment: ${status}`}
    >
      {icon}
    </span>
  );
}
