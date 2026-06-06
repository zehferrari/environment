import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { listAssignablePrincipals } from "@/lib/principals";
import { COLUMN_IDS } from "../columns";
import { actorDisplayName, MessageAvatar, type MessageActor } from "@/components/message-avatar";
import { formatGridDate } from "@/lib/date-format";
import { deploymentStatusIcon } from "@/lib/deploy/deployment-status";

export const dynamic = "force-dynamic";

const PAGE_SIZES = ["10", "25", "50", "100", "all"] as const;

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

function serializeActor(actor: ActorRow | null): MessageActor | null {
  if (!actor) return null;
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind,
    name: actor.name,
    avatarUpdatedAt: actor.avatarUpdatedAt?.toISOString() ?? null,
    agent: actor.agent,
  };
}

function buildTaskActivityActorMaps(rows: TaskActivityActorRow[]) {
  const createdBy = new Map<string, MessageActor>();
  const updatedBy = new Map<string, MessageActor>();

  for (const row of rows) {
    if (!row.taskId) continue;
    const actor = serializeActor(row.user) ?? systemActor;
    if (!updatedBy.has(row.taskId)) updatedBy.set(row.taskId, actor);
    if (row.kind === "task.create" && !createdBy.has(row.taskId)) {
      createdBy.set(row.taskId, actor);
    }
  }

  return { createdBy, updatedBy };
}

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parsePageSize(raw: string | string[] | undefined) {
  const value = single(raw);
  return PAGE_SIZES.includes(value as (typeof PAGE_SIZES)[number]) ? value! : "25";
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
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    select: { id: true, name: true },
  });
  if (!project) notFound();

  const view = single(sp.view) === "archive" ? "archive" : "board";
  const reporterId = single(sp.reporterId) ?? "";
  const assigneeId = single(sp.assigneeId) ?? "";
  const reviewerId = single(sp.reviewerId) ?? "";
  const status = single(sp.status) ?? "";
  const pageSize = parsePageSize(sp.pageSize);
  const take = pageSize === "all" ? undefined : Number(pageSize);

  const where = {
    projectId: project.id,
    deletedAt: null,
    parentTaskId: null,
    archivedAt: view === "archive" ? { not: null } : null,
    ...(reporterId ? { reporterId } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(reviewerId ? { actingManagerId: reviewerId } : {}),
    ...(status ? { status } : {}),
  };

  const [principals, tasks, totalCount] = await Promise.all([
    listAssignablePrincipals(),
    db.task.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take,
      include: {
        epic: { select: { id: true, title: true } },
        reporter: { select: actorSelect },
        assignee: { select: actorSelect },
        actingManager: { select: actorSelect },
      },
    }),
    db.task.count({ where }),
  ]);
  const taskIds = tasks.map((task) => task.id);
  const activityRows = taskIds.length > 0
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
  const activityActors = buildTaskActivityActorMaps(activityRows);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Tasks</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {tasks.length} shown of {totalCount} matching task{totalCount === 1 ? "" : "s"}.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1 text-xs">
          <Link
            href={`/projects/${slug}/tasks?view=board`}
            className={
              view === "board"
                ? "rounded-lg bg-[var(--color-accent)] px-3 py-1 font-medium text-[var(--color-bg)]"
                : "rounded-lg px-3 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }
          >
            Board
          </Link>
          <Link
            href={`/projects/${slug}/tasks?view=archive`}
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

      <form className="grid gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3 text-sm md:grid-cols-3 xl:grid-cols-[repeat(5,minmax(0,1fr))_auto]">
        <input type="hidden" name="view" value={view} />
        <FilterSelect label="Reporter" name="reporterId" value={reporterId}>
          <option value="">All reporters</option>
          {principals.map((principal) => (
            <option key={principal.id} value={principal.id}>
              {principal.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Assignee" name="assigneeId" value={assigneeId}>
          <option value="">All assignees</option>
          {principals.map((principal) => (
            <option key={principal.id} value={principal.id}>
              {principal.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Reviewer" name="reviewerId" value={reviewerId}>
          <option value="">All reviewers</option>
          {principals.map((principal) => (
            <option key={principal.id} value={principal.id}>
              {principal.name}
            </option>
          ))}
        </FilterSelect>
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
            className="h-9 rounded-lg bg-[var(--color-accent)] px-3 text-xs font-semibold text-[var(--color-bg)] hover:opacity-90"
          >
            Apply
          </button>
          <Link
            href={`/projects/${slug}/tasks?view=${view}`}
            className="grid h-9 place-items-center rounded-lg border border-[var(--color-line)] px-3 text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            Clear
          </Link>
        </div>
      </form>

      {tasks.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-6 text-center text-sm text-[var(--color-text-muted)]">
          No tasks match these filters.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)]">
          <div className="grid min-w-[68rem] grid-cols-[minmax(14rem,1.6fr)_6rem_4rem_minmax(7rem,0.9fr)_minmax(7rem,0.9fr)_minmax(7rem,0.9fr)_5.5rem_5.5rem_5.5rem] items-center gap-3 border-b border-[var(--color-line)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] xl:min-w-0">
            <span>Task</span>
            <span>Status</span>
            <span>Deploy</span>
            <span>Reporter</span>
            <span>Assignee</span>
            <span>Reviewer</span>
            <span className="text-right">Elapsed</span>
            <span className="text-right">Created At</span>
            <span className="text-right">Updated</span>
          </div>
          <ul className="divide-y divide-[var(--color-line)]">
            {tasks.map((task) => (
              <li
                key={task.id}
                className={`grid min-w-[68rem] grid-cols-[minmax(14rem,1.6fr)_6rem_4rem_minmax(7rem,0.9fr)_minmax(7rem,0.9fr)_minmax(7rem,0.9fr)_5.5rem_5.5rem_5.5rem] items-center gap-3 px-3 py-2 text-sm transition hover:bg-[var(--color-panel)] xl:min-w-0 ${statusRowClass(task.status)}`}
              >
                <Link href={`/projects/${slug}/tasks/${task.id}`} className="min-w-0 hover:underline">
                  <span className="mb-0.5 flex min-w-0 items-center gap-2">
                    <span className="inline-flex shrink-0 rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[var(--color-text-muted)]">
                      {task.workItemKey ?? task.id.slice(0, 8)}
                    </span>
                    {task.epic ? (
                      <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                        {task.epic.title}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate font-medium">{task.title}</span>
                  {task.archivedAt ? (
                    <span className="mt-0.5 inline-flex rounded-full border border-zinc-500/60 bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-900">
                      Archived
                    </span>
                  ) : null}
                </Link>
                <StatusPill status={task.status} />
                <DeploymentIndicator status={task.deploymentStatus} />
                <PersonCell actor={serializeActor(task.reporter)} emptyLabel="none" />
                <PersonCell actor={serializeActor(task.assignee)} emptyLabel="unassigned" />
                <PersonCell actor={serializeActor(task.actingManager)} emptyLabel="none" />
                <ElapsedCell
                  status={task.status}
                  createdAt={task.createdAt}
                  updatedAt={task.updatedAt}
                  statusChangedAt={task.statusChangedAt}
                  approvedOn={task.approvedOn}
                />
                <DateActorCell
                  iso={task.createdAt.toISOString()}
                  actor={activityActors.createdBy.get(task.id) ?? serializeActor(task.reporter)}
                  dateOnly
                />
                <DateActorCell
                  iso={task.updatedAt.toISOString()}
                  actor={activityActors.updatedBy.get(task.id) ?? activityActors.createdBy.get(task.id) ?? serializeActor(task.reporter)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DeploymentIndicator({ status }: { status: string }) {
  const icon = deploymentStatusIcon(status);
  if (icon === "—") {
    return (
      <span className="w-fit rounded border border-[var(--color-line)] px-1 text-[10px] text-[var(--color-text-muted)]" title="Deployment: Not Required">
        —
      </span>
    );
  }
  return (
    <span className="text-sm" title={`Deployment: ${status}`} aria-label={`Deployment: ${status}`}>
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
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <select
        name={name}
        defaultValue={value}
        className="h-9 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 text-xs outline-none focus:border-[var(--color-accent)]"
      >
        {children}
      </select>
    </label>
  );
}

function PersonCell({ actor, emptyLabel }: { actor: MessageActor | null; emptyLabel: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-muted)]">
      {actor ? <MessageAvatar actor={actor} size="sm" /> : null}
      <span className="truncate">{actor ? actorDisplayName(actor) : emptyLabel}</span>
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`w-fit rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusPillClass(status)}`}>
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
    <span className="flex min-w-0 items-center justify-end gap-1.5 text-xs text-[var(--color-text-muted)]">
      <time dateTime={iso} title={iso} className="min-w-0 truncate text-right tabular-nums" suppressHydrationWarning>
        {dateOnly ? formatGridDate(iso) : relativeUpdated(iso)}
      </time>
      {actor ? <MessageAvatar actor={actor} size="sm" /> : null}
    </span>
  );
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
  const end = status === "Done" ? (statusChangedAt ?? updatedAt).getTime() : Date.now();
  const start =
    status === "Done"
      ? (approvedOn ?? createdAt).getTime()
      : status === "Backlog"
        ? createdAt.getTime()
        : (statusChangedAt ?? updatedAt ?? createdAt).getTime();
  return (
    <span className="flex items-center justify-end gap-1.5 text-xs tabular-nums text-[var(--color-text-muted)]">
      <TimerIcon />
      <span>{formatElapsed(Math.max(0, end - start))}</span>
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
  return "border-l-4 border-l-slate-400 bg-[var(--color-panel-soft)]";
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
