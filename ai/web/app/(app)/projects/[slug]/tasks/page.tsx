import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { COLUMN_IDS } from "../columns";
import { actorDisplayName, MessageAvatar, type MessageActor } from "@/components/message-avatar";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import { formatGridDate } from "@/lib/date-format";
import { canShowDeploymentForTask, deploymentStatusIcon } from "@/lib/deploy/deployment-status";
import { accessibleProjectWhere, accessibleTaskWhere, requireViewer } from "@/lib/auth/permissions";
import StickyViewportSurface from "@/components/sticky-viewport-surface";
import {
  getActorVisibility,
  serializeVisibleActor,
  type ActorVisibility,
} from "@/lib/users/actor-visibility";

export const dynamic = "force-dynamic";

const PAGE_SIZES = ["10", "25", "50", "100", "all"] as const;
const TASK_VIEWS = ["all", "board", "archive"] as const;
type TaskView = (typeof TASK_VIEWS)[number];

type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
};

type TaskActivityActorRow = {
  taskId: string | null;
  kind: string;
  user: ActorRow | null;
};

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

const systemActor: MessageActor = {
  id: null,
  username: "system",
  kind: "system",
  name: "System",
  avatarUpdatedAt: null,
  agent: null,
};

function serializeActor(actor: ActorRow | null, visibility: ActorVisibility): MessageActor | null {
  return serializeVisibleActor(actor, visibility);
}

function buildTaskActivityActorMaps(rows: TaskActivityActorRow[], visibility: ActorVisibility) {
  const createdBy = new Map<string, MessageActor>();
  const updatedBy = new Map<string, MessageActor>();

  for (const row of rows) {
    if (!row.taskId) continue;
    const actor = serializeActor(row.user, visibility) ?? systemActor;
    if (!updatedBy.has(row.taskId)) updatedBy.set(row.taskId, actor);
    if (row.kind === "task.create" && !createdBy.has(row.taskId)) {
      createdBy.set(row.taskId, actor);
    }
  }

  return { createdBy, updatedBy };
}

async function readBusyAgentSlugs() {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return new Set<string>();
    const snapshot = (await res.json()) as {
      agents?: Record<string, { busy_state?: { is_busy?: boolean } | null }>;
    };
    const busy = new Set<string>();
    for (const [slug, agent] of Object.entries(snapshot.agents ?? {})) {
      if (agent?.busy_state?.is_busy) busy.add(slug);
    }
    return busy;
  } catch {
    return new Set<string>();
  }
}

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// Multi-value query params arrive as string | string[] | undefined depending
// on how many of the same key the GET form submitted. Normalize to a deduped
// non-empty list for `in` filtering.
function multi(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.filter(Boolean))];
}

function parsePageSize(raw: string | string[] | undefined) {
  const value = single(raw);
  return PAGE_SIZES.includes(value as (typeof PAGE_SIZES)[number]) ? value! : "25";
}

function parseTaskView(raw: string | string[] | undefined): TaskView {
  const value = single(raw)?.toLowerCase();
  return TASK_VIEWS.includes(value as TaskView) ? value as TaskView : "board";
}

export default async function ProjectTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    view?: string | string[];
    reporterId?: string | string[];
    assigneeId?: string | string[];
    reviewerId?: string | string[];
    status?: string | string[];
    pageSize?: string | string[];
  }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const viewer = await requireViewer();
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug, deletedAt: null }),
    select: { id: true, name: true },
  });
  if (!project) notFound();

  // Keep existing ?view=board|archive links compatible while also allowing an
  // aggregate view that includes both active and archived tasks.
  const view = parseTaskView(sp.view);
  const reporterIds = viewer.isOwner ? multi(sp.reporterId) : [];
  const assigneeIds = viewer.isOwner ? multi(sp.assigneeId) : [];
  const reviewerIds = viewer.isOwner ? multi(sp.reviewerId) : [];
  const status = single(sp.status) ?? "";
  const pageSize = parsePageSize(sp.pageSize);
  const take = pageSize === "all" ? undefined : Number(pageSize);
  const taskGridClass = viewer.isOwner
    ? "grid min-w-[68rem] grid-cols-[minmax(14rem,1.6fr)_6rem_4rem_minmax(7rem,0.9fr)_minmax(7rem,0.9fr)_minmax(7rem,0.9fr)_5.5rem_5.5rem_5.5rem] items-center gap-3 xl:min-w-0"
    : "grid min-w-[48rem] grid-cols-[minmax(14rem,1.6fr)_6rem_4rem_5.5rem_5.5rem_5.5rem] items-center gap-3 xl:min-w-0";

  const where = accessibleTaskWhere(viewer, {
    projectId: project.id,
    deletedAt: null,
    parentTaskId: null,
    ...(view === "archive"
      ? { archivedAt: { not: null } }
      : view === "board"
        ? { archivedAt: null }
        : {}),
    ...(reporterIds.length ? { reporterId: { in: reporterIds } } : {}),
    ...(assigneeIds.length ? { assigneeId: { in: assigneeIds } } : {}),
    ...(reviewerIds.length ? { actingManagerId: { in: reviewerIds } } : {}),
    ...(status ? { status } : {}),
  });

  const [principals, tasks, totalCount, busyAgentSlugs, actorVisibility] = await Promise.all([
    viewer.isOwner ? listAssignablePrincipals(viewer) : Promise.resolve([]),
    db.task.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take,
      include: {
        epic: {
          select: {
            id: true,
            title: true,
            status: true,
            deploymentStatus: true,
            createdAt: true,
            updatedAt: true,
            reporter: { select: actorSelect },
            actingManager: { select: actorSelect },
          },
        },
        reporter: { select: actorSelect },
        assignee: { select: actorSelect },
        actingManager: { select: actorSelect },
      },
    }),
    db.task.count({ where }),
    viewer.isOwner ? readBusyAgentSlugs() : Promise.resolve(new Set<string>()),
    getActorVisibility(viewer),
  ]);
  const taskIds = tasks.map((task) => task.id);
  const activityRows = viewer.isOwner && taskIds.length > 0
    ? await db.activityLog.findMany({
        where: { taskId: { in: taskIds } },
        orderBy: { createdAt: "desc" },
        select: {
          taskId: true,
          kind: true,
          user: { select: actorSelect },
        },
      })
    : [];
  const activityActors = buildTaskActivityActorMaps(activityRows, actorVisibility);

  // People filters carry avatars and allow multiple selection.
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
  const renderTaskRow = (task: (typeof tasks)[number]) => {
    const deploymentStatus = task.epic?.deploymentStatus ?? task.deploymentStatus;
    return (
      <li
        key={task.id}
        className={`${taskGridClass} px-3 py-2 text-body transition hover:bg-panel ${statusRowClass(task.status)}`}
      >
        <Link href={`/projects/${slug}/tasks/${task.id}`} className="min-w-0 hover:underline">
          <span className="mb-0.5 flex min-w-0 items-center gap-2">
            <span className="inline-flex shrink-0 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-nano font-semibold text-text-muted">
              {task.workItemKey ?? task.id.slice(0, 8)}
            </span>
            {task.epic ? (
              <span className="truncate text-nano font-semibold uppercase tracking-wider text-text-muted">
                {task.epic.title}
              </span>
            ) : null}
          </span>
          <span className="block truncate font-medium">{task.title}</span>
          {task.archivedAt ? (
            <span className="mt-0.5 inline-flex rounded-full border border-zinc-500/60 bg-zinc-200 px-1.5 py-0.5 text-nano font-semibold uppercase tracking-wider text-zinc-900">
              Archived
            </span>
          ) : null}
        </Link>
        <StatusPill status={task.status} />
        {canShowDeploymentForTask(task) ? <DeploymentIndicator status={deploymentStatus} /> : <span aria-hidden="true" />}
        {viewer.isOwner ? <PersonCell actor={serializeActor(task.reporter, actorVisibility)} emptyLabel="none" /> : null}
        {viewer.isOwner ? <PersonCell
          actor={serializeActor(task.assignee, actorVisibility)}
          emptyLabel="unassigned"
          busy={task.status === "In Progress" && Boolean(task.assignee?.agent?.slug && busyAgentSlugs.has(task.assignee.agent.slug))}
        /> : null}
        {viewer.isOwner ? <PersonCell actor={serializeActor(task.actingManager, actorVisibility)} emptyLabel="none" /> : null}
        <ElapsedCell
          status={task.status}
          createdAt={task.createdAt}
          updatedAt={task.updatedAt}
          statusChangedAt={task.statusChangedAt}
          approvedOn={task.approvedOn}
        />
        <DateActorCell
          iso={task.createdAt.toISOString()}
          actor={activityActors.createdBy.get(task.id) ?? (viewer.isOwner ? serializeActor(task.reporter, actorVisibility) : null)}
          dateOnly
        />
        <DateActorCell
          iso={task.updatedAt.toISOString()}
          actor={activityActors.updatedBy.get(task.id) ?? activityActors.createdBy.get(task.id) ?? (viewer.isOwner ? serializeActor(task.reporter, actorVisibility) : null)}
        />
      </li>
    );
  };

  // All views group tasks under their Epic in
  // collapsible blocks. Tasks with no epic are the "Direct Request" group,
  // which sorts first and stays expanded. Active and aggregate views expand
  // every group by default; the archive view opens Direct Request only.
  const DIRECT_REQUEST_KEY = "__direct__";
  type EpicGroup = {
    id: string;
    title: string;
    epic: (typeof tasks)[number]["epic"];
    tasks: typeof tasks;
  };
  const epicGroups: EpicGroup[] = [];
  {
    const byEpic = new Map<string, EpicGroup>();
    for (const task of tasks) {
      const key = task.epic?.id ?? DIRECT_REQUEST_KEY;
      let group = byEpic.get(key);
      if (!group) {
        group = {
          id: key,
          title: task.epic?.title ?? "Direct Request",
          epic: task.epic,
          tasks: [],
        };
        byEpic.set(key, group);
        epicGroups.push(group);
      }
      group.tasks.push(task);
    }
    epicGroups.sort((a, b) => {
      if (a.id === DIRECT_REQUEST_KEY) return -1;
      if (b.id === DIRECT_REQUEST_KEY) return 1;
      return 0;
    });
  }

  const TASK_HEADER_GRID = (
    <div className={`${taskGridClass} border-b border-line px-3 py-2 text-nano font-semibold uppercase tracking-wider text-text-muted`}>
      <span>Task</span>
      <span>Status</span>
      <span>Deploy</span>
      {viewer.isOwner ? <span>Reporter</span> : null}
      {viewer.isOwner ? <span>Assignee</span> : null}
      {viewer.isOwner ? <span>Reviewer</span> : null}
      <span className="text-right">Elapsed</span>
      <span className="text-right">Created At</span>
      <span className="text-right">Updated</span>
    </div>
  );

  return (
    <StickyViewportSurface kind="tasks-grid">
    <div className="space-y-section-gap">
      <header>
        <div>
          <h2 className="text-heading font-semibold tracking-tight">Tasks</h2>
          <p className="mt-1 text-body text-text-muted">
            {tasks.length} shown of {totalCount} matching task{totalCount === 1 ? "" : "s"}.
          </p>
        </div>
      </header>

      <form
        id="taskFilters"
        className={`grid gap-3 rounded-card border border-line bg-panel p-3 text-body ${viewer.isOwner ? "md:grid-cols-3 xl:grid-cols-[repeat(6,minmax(0,1fr))_auto]" : "md:grid-cols-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_auto]"}`}
      >
        <FilterSelect label="View" name="view" value={view}>
          <option value="all">All</option>
          <option value="board">Board</option>
          <option value="archive">Archive</option>
        </FilterSelect>
        {viewer.isOwner ? <FilterField label="Reporter">
          <AvatarCombobox
            formId="taskFilters"
            name="reporterId"
            multiple
            defaultValues={reporterIds}
            options={principalFilterOptions}
            emptyLabel="All reporters"
            ariaLabel="Reporter filter"
          />
        </FilterField> : null}
        {viewer.isOwner ? <FilterField label="Assignee">
          <AvatarCombobox
            formId="taskFilters"
            name="assigneeId"
            multiple
            defaultValues={assigneeIds}
            options={principalFilterOptions}
            emptyLabel="All assignees"
            ariaLabel="Assignee filter"
          />
        </FilterField> : null}
        {viewer.isOwner ? <FilterField label="Reviewer">
          <AvatarCombobox
            formId="taskFilters"
            name="reviewerId"
            multiple
            defaultValues={reviewerIds}
            options={principalFilterOptions}
            emptyLabel="All reviewers"
            ariaLabel="Reviewer filter"
          />
        </FilterField> : null}
        <FilterSelect label="Status" name="status" value={status}>
          <option value="">All statuses</option>
          {COLUMN_IDS.map((column) => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Rows" name="pageSize" value={pageSize}>
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size === "all" ? "All" : size}
            </option>
          ))}
        </FilterSelect>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="h-9 rounded-lg bg-accent px-3 text-caption font-semibold text-bg hover:opacity-90"
          >
            Apply
          </button>
          <Link
            href={`/projects/${slug}/tasks?view=${view}`}
            className="grid h-9 place-items-center rounded-lg border border-line px-3 text-caption font-semibold text-text-muted hover:text-text"
          >
            Clear
          </Link>
        </div>
      </form>

      {tasks.length === 0 ? (
        <p className="rounded-card border border-dashed border-line p-6 text-center text-body text-text-muted">
          No tasks match these filters.
        </p>
      ) : (
        <div className="space-y-3">
          {epicGroups.map((group) => {
            // Elapsed sums every child task; created/updated come from the epic
            // itself (or, for Direct Request, the span of its children).
            const elapsedMs = group.tasks.reduce((sum, t) => sum + computeElapsedMs(t), 0);
            const createdIso = (
              group.epic?.createdAt
              ?? group.tasks.reduce((min, t) => (t.createdAt < min ? t.createdAt : min), group.tasks[0].createdAt)
            ).toISOString();
            const updatedIso = (
              group.epic?.updatedAt
              ?? group.tasks.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), group.tasks[0].updatedAt)
            ).toISOString();
            return (
            <details
              key={group.id}
              open={view !== "archive" || group.id === DIRECT_REQUEST_KEY}
              className="group overflow-hidden rounded-lg border border-line bg-panel-soft"
            >
              <summary className="cursor-pointer list-none border-b border-line bg-panel [&::-webkit-details-marker]:hidden">
                <div className={`${taskGridClass} px-3 py-2.5 text-body`}>
                  <span className="flex min-w-0 items-center gap-2 font-semibold">
                    <ChevronIcon />
                    <span className="truncate">{group.title}</span>
                    <span className="shrink-0 text-caption font-normal tabular-nums text-text-muted">
                      ({group.tasks.length})
                    </span>
                  </span>
                  {group.epic ? (
                    <span className="w-fit rounded-full border border-line bg-panel-soft px-2 py-0.5 text-nano font-medium uppercase tracking-wider">
                      {group.epic.status}
                    </span>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  {group.epic ? (
                    <DeploymentIndicator status={group.epic.deploymentStatus} />
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  {viewer.isOwner ? <PersonCell actor={serializeActor(group.epic?.reporter ?? null, actorVisibility)} emptyLabel="—" /> : null}
                  {/* Assignee column intentionally blank at the Epic level. */}
                  {viewer.isOwner ? <span aria-hidden="true" /> : null}
                  {viewer.isOwner ? <PersonCell
                    actor={serializeActor(group.epic?.actingManager ?? group.epic?.reporter ?? null, actorVisibility)}
                    emptyLabel="—"
                  /> : null}
                  <span className="flex items-center justify-end gap-1.5 text-caption tabular-nums text-text-muted">
                    <TimerIcon />
                    <span>{formatElapsed(elapsedMs)}</span>
                  </span>
                  <DateActorCell iso={createdIso} actor={null} dateOnly />
                  <DateActorCell iso={updatedIso} actor={null} />
                </div>
              </summary>
              <div className="overflow-x-auto">
                {TASK_HEADER_GRID}
                <ul className="divide-y divide-line">
                  {group.tasks.map(renderTaskRow)}
                </ul>
              </div>
            </details>
            );
          })}
        </div>
      )}
    </div>
    </StickyViewportSurface>
  );
}

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted transition-transform group-open:rotate-90"
    >
      <path d="m9 18 6-6-6-6" />
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

function FilterSelect({
  label,
  name,
  value,
  children,
}: {
  label: string;
  name: string;
  value: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <select
        name={name}
        defaultValue={value}
        className="h-9 w-full rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
      >
        {children}
      </select>
    </label>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

function PersonCell({ actor, emptyLabel, busy = false }: { actor: MessageActor | null; emptyLabel: string; busy?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-caption text-text-muted">
      {actor ? <MessageAvatar actor={actor} size="sm" busy={busy} /> : null}
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

function DateActorCell({
  iso,
  actor,
  dateOnly = false,
}: {
  iso: string;
  actor: MessageActor | null;
  dateOnly?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5 text-caption text-text-muted">
      <time dateTime={iso} title={iso} className="min-w-0 truncate text-right tabular-nums" suppressHydrationWarning>
        {dateOnly ? formatGridDate(iso) : relativeUpdated(iso)}
      </time>
      {actor ? <MessageAvatar actor={actor} size="sm" /> : null}
    </span>
  );
}

function computeElapsedMs(task: {
  status: string;
  createdAt: Date;
  updatedAt: Date;
  statusChangedAt: Date | null;
  approvedOn: Date | null;
}) {
  const end = task.status === "Done" ? (task.statusChangedAt ?? task.updatedAt).getTime() : Date.now();
  const start =
    task.status === "Done"
      ? (task.approvedOn ?? task.createdAt).getTime()
      : task.status === "Backlog"
        ? task.createdAt.getTime()
        : (task.statusChangedAt ?? task.updatedAt ?? task.createdAt).getTime();
  return Math.max(0, end - start);
}

function ElapsedCell({
  status,
  createdAt,
  updatedAt,
  statusChangedAt,
  approvedOn,
}: {
  status: string;
  createdAt: Date;
  updatedAt: Date;
  statusChangedAt: Date | null;
  approvedOn: Date | null;
}) {
  return (
    <span className="flex items-center justify-end gap-1.5 text-caption tabular-nums text-text-muted">
      <TimerIcon />
      <span>{formatElapsed(computeElapsedMs({ status, createdAt, updatedAt, statusChangedAt, approvedOn }))}</span>
    </span>
  );
}

function formatElapsed(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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

function statusRowClass(status: string) {
  if (status === "To Do") return "border-l-4 border-l-sky-400 bg-sky-500/[0.10]";
  if (status === "In Progress") return "border-l-4 border-l-emerald-400 bg-emerald-500/[0.11]";
  if (status === "Review") return "border-l-4 border-l-amber-400 bg-amber-500/[0.13]";
  if (status === "Done") return "border-l-4 border-l-lime-400 bg-lime-500/[0.10]";
  return "border-l-4 border-l-slate-400 bg-panel-soft";
}

function statusPillClass(status: string) {
  if (status === "To Do") return "border-sky-500/70 bg-sky-100 text-sky-950 shadow-[inset_0_0_0_1px_rgba(2,132,199,0.18)]";
  if (status === "In Progress") return "border-emerald-500/70 bg-emerald-100 text-emerald-950 shadow-[inset_0_0_0_1px_rgba(5,150,105,0.18)]";
  if (status === "Review") return "border-amber-500/80 bg-amber-100 text-amber-950 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.22)]";
  if (status === "Done") return "border-lime-600/70 bg-lime-100 text-lime-950 shadow-[inset_0_0_0_1px_rgba(101,163,13,0.18)]";
  return "border-slate-500/60 bg-slate-100 text-slate-950 shadow-[inset_0_0_0_1px_rgba(71,85,105,0.16)]";
}

function TimerIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2" />
      <path d="M9 2h6" />
    </svg>
  );
}
