import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { actorDisplayName, MessageAvatar } from "@/components/message-avatar";
import { binEpic } from "@/lib/bin/actions";
import { createEpic } from "@/lib/epics/actions";
import { formatGridDate } from "@/lib/date-format";
import { deploymentStatusIcon } from "@/lib/deploy/deployment-status";
import { type AvatarComboboxOption } from "@/components/avatar-combobox";
import type { MessageActor } from "@/components/message-avatar";
import NewEpicFab from "./new-epic-fab";
import EpicFilters from "./epic-filters";
import StickyViewportSurface from "@/components/sticky-viewport-surface";
import {
  accessibleEpicWhere,
  accessibleProjectWhere,
  accessibleTaskWhere,
  requireViewer,
} from "@/lib/auth/permissions";
import { getActorVisibility, serializeVisibleActor } from "@/lib/users/actor-visibility";
import { DEFAULT_EPIC_BOARD_STATUSES } from "@/lib/epics/status-filter";

const EPIC_VIEWS = ["all", "board", "archive"] as const;
type EpicView = (typeof EPIC_VIEWS)[number];
const PAGE_SIZES = ["10", "25", "50", "100", "all"] as const;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function multi(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter(Boolean))];
}

function parseEpicView(raw: string | string[] | undefined): EpicView {
  const value = single(raw)?.toLowerCase();
  return EPIC_VIEWS.includes(value as EpicView) ? (value as EpicView) : "board";
}

function parsePageSize(raw: string | string[] | undefined) {
  const value = single(raw);
  return PAGE_SIZES.includes(value as (typeof PAGE_SIZES)[number]) ? value! : "all";
}

export const dynamic = "force-dynamic";

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

export default async function EpicsListPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    view?: string | string[];
    reporterId?: string | string[];
    managerId?: string | string[];
    status?: string | string[];
    pageSize?: string | string[];
  }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const viewer = await requireViewer();
  const actorVisibility = await getActorVisibility(viewer);

  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug }),
    select: { id: true, name: true },
  });
  if (!project) notFound();

  // Filter model mirrors the Tasks tab: View / people / Status / Rows submitted
  // through one GET form. Board narrows to the actively-moving statuses unless a
  // single Status is chosen; Archive shows archived epics.
  const view = parseEpicView(sp.view);
  const reporterIds = viewer.isOwner ? multi(sp.reporterId) : [];
  const managerIds = viewer.isOwner ? multi(sp.managerId) : [];
  const status = single(sp.status) ?? "";
  const pageSize = parsePageSize(sp.pageSize);
  const take = pageSize === "all" ? undefined : Number(pageSize);

  const principals = viewer.isOwner ? await listAssignablePrincipals(viewer) : [];
  const principalFilterOptions: AvatarComboboxOption[] = principals.map((p) => ({
    value: p.id,
    label: p.name,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt ? p.avatarUpdatedAt.toISOString() : null,
      agent:
        p.kind === "agent"
          ? { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar }
          : null,
    },
  }));
  // Column widths mirror the Tasks tab's grid one-for-one on the shared
  // columns (flexible title, 6rem status, 4rem deploy, minmax people cells,
  // 5.5rem metric/date), so the two grids line up visually.
  const epicGridClass = viewer.isOwner
    ? "grid min-w-[62rem] grid-cols-[minmax(14rem,1.6fr)_6rem_4rem_minmax(7rem,0.9fr)_minmax(7rem,0.9fr)_5.5rem_5.5rem_2.5rem] items-center gap-3 xl:min-w-0"
    : "grid min-w-[42rem] grid-cols-[minmax(14rem,1.6fr)_6rem_4rem_5.5rem_5.5rem_2.5rem] items-center gap-3 xl:min-w-0";

  const where = accessibleEpicWhere(viewer, {
    projectId: project.id,
    deletedAt: null,
    archivedAt: view === "archive" ? { not: null } : null,
    ...(view === "archive"
      ? {}
      : status
        ? { status }
        : view === "board"
          ? { status: { in: [...DEFAULT_EPIC_BOARD_STATUSES] } }
          : {}),
    ...(reporterIds.length ? { reporterId: { in: reporterIds } } : {}),
    ...(managerIds.length ? { actingManagerId: { in: managerIds } } : {}),
  });

  const [epics, totalCount] = await Promise.all([
    db.epic.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      ...(take ? { take } : {}),
      include: {
        actingManager: { select: actorSelect },
        reporter: { select: actorSelect },
        _count: {
          select: {
            tasks: { where: accessibleTaskWhere(viewer, { deletedAt: null, parentTaskId: null }) },
          },
        },
      },
    }),
    db.epic.count({ where }),
  ]);
  const visibleEpics = epics;

  return (
    <StickyViewportSurface kind="tasks-grid">
    <div className="space-y-section-gap">
      {/* Chrome mirrors the Tasks tab: h2 heading + count and a bordered GET
          filter form with the same controls. */}
      <header>
        <div>
          <h2 className="text-heading font-semibold tracking-tight">Epics</h2>
          <p className="mt-1 text-body text-text-muted">
            {visibleEpics.length} shown of {totalCount} matching epic{totalCount === 1 ? "" : "s"}.
          </p>
        </div>
      </header>

      <EpicFilters
        slug={slug}
        isOwner={viewer.isOwner}
        view={view}
        reporterIds={reporterIds}
        managerIds={managerIds}
        status={status}
        pageSize={pageSize}
        options={principalFilterOptions}
      />

      {visibleEpics.length === 0 ? (
        <p className="rounded-card border border-dashed border-line p-6 text-center text-body text-text-muted">
          No epics match the current filter.
        </p>
      ) : (
        <div className="overflow-hidden rounded-panel border border-line bg-panel shadow-sm">
        <div className="overflow-x-auto">
          <div className={`${epicGridClass} border-b border-line px-3 py-2 text-nano font-semibold uppercase tracking-wider text-text-muted`}>
            <span>Epic</span>
            <span>Status</span>
            <span>Deploy</span>
            {viewer.isOwner ? <span>Report by</span> : null}
            {viewer.isOwner ? <span>Acting mgr</span> : null}
            <span className="text-right">Tasks</span>
            <span className="text-right">Created At</span>
            <span className="sr-only">Bin</span>
          </div>
          <ul className="divide-y divide-line">
            {visibleEpics.map((e) => {
              const reporter = serializeVisibleActor(e.reporter, actorVisibility);
              const manager = serializeVisibleActor(e.actingManager, actorVisibility);
              return (
                <li
                  key={e.id}
                  className={`${epicGridClass} px-3 py-2 text-body transition hover:bg-panel ${statusRowClass(e.status)}`}
                >
                  <Link href={`/projects/${slug}/epics/${e.id}`} className="min-w-0 hover:underline">
                    <span className="mb-0.5 flex min-w-0 items-center gap-2">
                      <span className="inline-flex shrink-0 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-nano font-semibold text-text-muted">
                        {e.workItemKey ?? e.id.slice(0, 8)}
                      </span>
                    </span>
                    <span className="block truncate font-medium">{e.title}</span>
                    {e.description ? (
                      <span className="mt-0.5 block truncate text-caption text-text-muted">{e.description}</span>
                    ) : null}
                  </Link>
                  <StatusPill status={e.status} />
                  <DeploymentIndicator status={e.deploymentStatus} />
                  {viewer.isOwner ? <PersonCell actor={reporter} emptyLabel="none" /> : null}
                  {viewer.isOwner ? <PersonCell actor={manager} emptyLabel="none" /> : null}
                  <span className="text-right text-caption tabular-nums text-text-muted">{e._count.tasks}</span>
                  <DateActorCell iso={e.createdAt.toISOString()} actor={null} dateOnly />
                  <form action={binEpic} className="text-right">
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
                </li>
              );
            })}
          </ul>
        </div>
        </div>
      )}

      <NewEpicFab
        projectSlug={slug}
        principals={viewer.isOwner ? principals : []}
        canManageAssignments={viewer.isOwner}
        canSetPrivate={viewer.isOwner}
        createEpicAction={createEpic}
      />
    </div>
    </StickyViewportSurface>
  );
}

// Row cells reuse the Tasks tab's exact visual language so the two grids read
// as one component.
function PersonCell({ actor, emptyLabel }: { actor: MessageActor | null; emptyLabel: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-caption text-text-muted">
      {actor ? <MessageAvatar actor={actor} size="sm" /> : null}
      <span className="truncate">{actor ? actorDisplayName(actor) : emptyLabel}</span>
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`w-fit rounded-full border px-2 py-0.5 text-nano font-semibold uppercase tracking-wider ${statusPillClass(status)}`}>
      {status}
    </span>
  );
}

function DateActorCell({ iso, actor, dateOnly = false }: { iso: string; actor: MessageActor | null; dateOnly?: boolean }) {
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5 text-caption text-text-muted">
      <time dateTime={iso} title={iso} className="min-w-0 truncate text-right tabular-nums" suppressHydrationWarning>
        {dateOnly ? formatGridDate(iso) : relativeUpdated(iso)}
      </time>
      {actor ? <MessageAvatar actor={actor} size="sm" /> : null}
    </span>
  );
}

function relativeUpdated(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return iso.slice(0, 10);
}

// Status colours match the Tasks grid one-for-one (To Do = sky, In Progress =
// emerald, Done = lime, Backlog/default = slate).
function statusRowClass(status: string) {
  if (status === "To Do") return "border-l-4 border-l-sky-400 bg-sky-500/[0.10]";
  if (status === "In Progress") return "border-l-4 border-l-emerald-400 bg-emerald-500/[0.11]";
  if (status === "Done") return "border-l-4 border-l-lime-400 bg-lime-500/[0.10]";
  return "border-l-4 border-l-slate-400 bg-panel-soft";
}

function statusPillClass(status: string) {
  if (status === "To Do") return "border-sky-500/70 bg-sky-100 text-sky-950 shadow-[inset_0_0_0_1px_rgba(2,132,199,0.18)]";
  if (status === "In Progress") return "border-emerald-500/70 bg-emerald-100 text-emerald-950 shadow-[inset_0_0_0_1px_rgba(5,150,105,0.18)]";
  if (status === "Done") return "border-lime-600/70 bg-lime-100 text-lime-950 shadow-[inset_0_0_0_1px_rgba(101,163,13,0.18)]";
  return "border-slate-500/60 bg-slate-100 text-slate-950 shadow-[inset_0_0_0_1px_rgba(71,85,105,0.16)]";
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
