"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";
import { formatGridDate } from "@/lib/date-format";
import { statusPillClass } from "@/lib/board-status";

export type SortableTaskItem = {
  id: string;
  workItemKey?: string | null;
  title: string;
  status?: string;
  href: string;
  createdAt?: string | null;
  statusChangedAt?: string | null;
  approvedOn?: string | null;
  archivedAt?: string | null;
  reporter?: MessageActor | null;
  assignee?: MessageActor | null;
  reviewer?: MessageActor | null;
  createdBy?: MessageActor | null;
  updatedBy?: MessageActor | null;
  assigneeName?: string | null;
  reviewerName?: string | null;
  updatedAt?: string | null;
  alertReporter?: boolean | null;
  activeWorking?: boolean | null;
};

type Props = {
  items: SortableTaskItem[];
  showStatusBadge?: boolean;
  showAssignee?: boolean;
  showReviewer?: boolean;
  showCreated?: boolean;
  showReporterAvatar?: boolean;
  showUpdated?: boolean;
  tableLayout?: boolean;
  reorderAction: (orderedIds: string[]) => Promise<void>;
  deleteTaskAction?: (formData: FormData) => Promise<void>;
  projectSlug?: string;
  ariaLabel?: string;
  selectedIds?: Set<string>;
  onSelectionChange?: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
};

export default function SortableTaskList({
  items,
  showStatusBadge = false,
  showAssignee = false,
  showReviewer = false,
  showCreated = false,
  showReporterAvatar = false,
  showUpdated = false,
  tableLayout = false,
  reorderAction,
  deleteTaskAction,
  projectSlug,
  ariaLabel,
  selectedIds,
  onSelectionChange,
}: Props) {
  const [order, setOrder] = useState(items);
  const [now, setNow] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  // Server is source of truth: when revalidatePath refreshes the list,
  // adopt the new server order.
  useEffect(() => {
    setOrder(items);
  }, [items]);

  useEffect(() => {
    if (!tableLayout) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [tableLayout]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const oldIndex = order.findIndex((t) => t.id === active.id);
      const newIndex = order.findIndex((t) => t.id === over.id);
      if (oldIndex === -1 || newIndex === -1) return;
      const next = arrayMove(order, oldIndex, newIndex);
      setOrder(next);
      startTransition(() => {
        void reorderAction(next.map((t) => t.id));
      });
    },
    [order, reorderAction],
  );

  if (order.length === 0) return null;

  const rows = (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={order.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul
          aria-label={ariaLabel}
          className={tableLayout ? "divide-y divide-line" : "divide-y divide-line rounded-lg border border-line bg-panel-soft"}
        >
          {order.map((t) => (
            <SortableRow
              key={t.id}
              item={t}
              showStatusBadge={showStatusBadge}
              showAssignee={showAssignee}
              showReviewer={showReviewer}
              showCreated={showCreated}
              showReporterAvatar={showReporterAvatar}
              showUpdated={showUpdated}
              tableLayout={tableLayout}
              deleteTaskAction={deleteTaskAction}
              projectSlug={projectSlug}
              selectedIds={selectedIds}
              onSelectionChange={onSelectionChange}
              now={now}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );

  if (!tableLayout) return rows;

  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-panel-soft">
      <div className="grid min-w-[72rem] grid-cols-[minmax(16rem,1fr)_8rem_10rem_10rem_7rem_7rem_7rem_2rem] items-center gap-3 border-b border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
        <span>Task</span>
        <span>Status</span>
        <span>Assignee</span>
        <span>Reviewer</span>
        <span className="text-right">Elapsed</span>
        <span className="text-right">Created At</span>
        <span className="text-right">Updated</span>
        <span className="sr-only">Bin</span>
      </div>
      {rows}
    </div>
  );
}

function SortableRow({
  item,
  showStatusBadge,
  showAssignee,
  showReviewer,
  showCreated,
  showReporterAvatar,
  showUpdated,
  tableLayout,
  deleteTaskAction,
  projectSlug,
  selectedIds,
  onSelectionChange,
  now,
}: {
  item: SortableTaskItem;
  showStatusBadge: boolean;
  showAssignee: boolean;
  showReviewer: boolean;
  showCreated: boolean;
  showReporterAvatar: boolean;
  showUpdated: boolean;
  tableLayout: boolean;
  deleteTaskAction?: (formData: FormData) => Promise<void>;
  projectSlug?: string;
  selectedIds?: Set<string>;
  onSelectionChange?: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
  now: number | null;
}) {
  const router = useRouter();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  if (tableLayout) {
    return (
      <li
        ref={setNodeRef}
        style={style}
        role="link"
        tabIndex={0}
        onClick={() => router.push(item.href)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            router.push(item.href);
          }
        }}
        className={`grid min-w-[72rem] cursor-pointer grid-cols-[minmax(16rem,1fr)_8rem_10rem_10rem_7rem_7rem_7rem_2rem] items-center gap-3 px-3 py-2 text-sm transition hover:bg-panel ${item.alertReporter ? "bg-red-500/[0.08]" : statusRowClass(item.status)} ${
          isDragging ? "opacity-50" : ""
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
            onClick={(event) => event.stopPropagation()}
            className="cursor-grab select-none rounded px-1 text-text-muted hover:text-text active:cursor-grabbing"
          >
            ⋮⋮
          </button>
          {onSelectionChange && (
            <input
              type="checkbox"
              checked={selectedIds?.has(item.id) ?? false}
              onClick={(event) => {
                event.stopPropagation();
                onSelectionChange(item.id, !selectedIds?.has(item.id), event.shiftKey);
              }}
              onChange={() => {}}
              onPointerDown={(event) => event.stopPropagation()}
              className="h-4 w-4 shrink-0 accent-text-accent"
              aria-label={`Select ${item.title}`}
            />
          )}
          {showReporterAvatar && item.reporter ? <MessageAvatar actor={item.reporter} size="sm" /> : null}
          <span className="min-w-0 flex-1 truncate">
            {item.workItemKey ? (
              <span className="mr-1 font-mono text-[10px] font-semibold text-text-muted">
                {item.workItemKey}
              </span>
            ) : null}
            {item.title}
          </span>
        </div>
        {showStatusBadge ? <StatusCell status={item.status ?? null} archivedAt={item.archivedAt ?? null} /> : <span />}
        {showAssignee ? (
          <PersonCell actor={item.assignee ?? null} fallbackName={item.assigneeName} emptyLabel="unassigned" busy={Boolean(item.activeWorking)} />
        ) : <span />}
        {showReviewer ? (
          <PersonCell actor={item.reviewer ?? null} fallbackName={item.reviewerName} emptyLabel="none" />
        ) : <span />}
        <ElapsedCell item={item} now={now} />
        {showCreated ? <TimeCell iso={item.createdAt ?? null} actor={item.createdBy ?? null} dateOnly /> : <span />}
        {showUpdated ? <TimeCell iso={item.updatedAt ?? null} actor={item.updatedBy ?? null} /> : <span />}
        {deleteTaskAction && projectSlug ? (
          <form
            action={deleteTaskAction}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            className="text-right"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <input type="hidden" name="taskId" value={item.id} />
            <button
              type="submit"
              className="rounded-md px-1.5 py-1 text-text-muted hover:bg-crit/10 hover:text-crit"
              aria-label={`Move ${item.title} to bin`}
              title="Move to bin"
            >
              <TrashIcon />
            </button>
          </form>
        ) : <span />}
      </li>
    );
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-3 py-2 text-sm ${item.alertReporter ? "bg-red-500/[0.08]" : ""} ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        className="cursor-grab select-none rounded px-1 text-text-muted hover:text-text active:cursor-grabbing"
      >
        ⋮⋮
      </button>
      {onSelectionChange && (
        <input
          type="checkbox"
          checked={selectedIds?.has(item.id) ?? false}
          onClick={(event) => {
            event.stopPropagation();
            onSelectionChange(item.id, !selectedIds?.has(item.id), event.shiftKey);
          }}
          onChange={() => {}}
          onPointerDown={(event) => event.stopPropagation()}
          className="h-4 w-4 shrink-0 accent-text-accent"
          aria-label={`Select ${item.title}`}
        />
      )}
      <Link href={item.href} className="min-w-0 flex-1 truncate hover:underline">
        {item.workItemKey ? (
          <span className="mr-1 font-mono text-[10px] font-semibold text-text-muted">
            {item.workItemKey}
          </span>
        ) : null}
        {item.title}
      </Link>
      <div className="flex shrink-0 items-center gap-3 text-xs text-text-muted">
        {showAssignee && item.assigneeName ? (
          <span>@{item.assigneeName}</span>
        ) : null}
        {showStatusBadge && item.status ? (
          <span className="rounded border border-line px-1.5 py-0.5">
            {item.status}
          </span>
        ) : null}
        {showUpdated && item.updatedAt ? (
          <time dateTime={item.updatedAt} title={item.updatedAt}>
            {relativeUpdated(item.updatedAt)}
          </time>
        ) : null}
      </div>
    </li>
  );
}

function PersonCell({
  actor,
  fallbackName,
  emptyLabel,
  busy = false,
}: {
  actor: MessageActor | null;
  fallbackName?: string | null;
  emptyLabel: string;
  busy?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
      {actor ? (
        <MessageAvatar actor={actor} size="sm" busy={busy} />
      ) : (
        <span className="truncate">{fallbackName ? `@${fallbackName}` : emptyLabel}</span>
      )}
    </span>
  );
}

function TimeCell({
  iso,
  actor,
  dateOnly = false,
}: {
  iso: string | null;
  actor?: MessageActor | null;
  dateOnly?: boolean;
}) {
  if (!iso) {
    return <span className="text-right text-xs text-text-muted">—</span>;
  }
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5 text-xs text-text-muted">
      <time
        dateTime={iso}
        title={iso}
        className="min-w-0 truncate text-right tabular-nums"
        suppressHydrationWarning
      >
        {dateOnly ? formatGridDate(iso) : relativeUpdated(iso)}
      </time>
      {actor ? <MessageAvatar actor={actor} size="sm" /> : null}
    </span>
  );
}

function StatusCell({ status, archivedAt }: { status: string | null; archivedAt?: string | null }) {
  if (!status) return <span />;
  return (
    <span className="flex flex-wrap gap-1">
      <span className={`w-fit rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${statusPillClass(status)}`}>
        {status}
      </span>
      {archivedAt ? (
        <span
          className="w-fit rounded-full border border-slate-400/60 bg-slate-200/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700"
          title={`Archived ${archivedAt}`}
        >
          Archived
        </span>
      ) : null}
    </span>
  );
}

function ElapsedCell({ item, now }: { item: SortableTaskItem; now: number | null }) {
  const elapsed = elapsedMsForTask(item, now);
  if (elapsed === null) {
    return <span className="text-right text-xs text-text-muted">—</span>;
  }
  return (
    <span className="flex items-center justify-end gap-1.5 text-xs tabular-nums text-text-muted">
      <TimerIcon />
      <span>{formatElapsed(elapsed)}</span>
    </span>
  );
}

function elapsedMsForTask(item: SortableTaskItem, now: number | null) {
  const status = item.status ?? "";
  const endIso = status === "Done" ? (item.statusChangedAt ?? item.updatedAt ?? null) : null;
  const end = status === "Done" ? parseTime(endIso) : now;
  if (end === null) return null;

  const startIso =
    status === "Done"
      ? item.approvedOn ?? item.createdAt ?? null
      : status === "Backlog"
        ? item.createdAt ?? null
        : item.statusChangedAt ?? item.updatedAt ?? item.createdAt ?? null;
  const start = parseTime(startIso);
  if (start === null) return null;
  return Math.max(0, end - start);
}

function parseTime(iso: string | null | undefined) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) ? time : null;
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

function statusRowClass(status: string | null | undefined) {
  if (status === "To Do") return "border-l-4 border-l-sky-400 bg-sky-500/[0.10]";
  if (status === "In Progress") return "border-l-4 border-l-emerald-400 bg-emerald-500/[0.11]";
  if (status === "Review") return "border-l-4 border-l-amber-400 bg-amber-500/[0.13]";
  if (status === "Done") return "border-l-4 border-l-lime-400 bg-lime-500/[0.10]";
  if (status === "Backlog") return "border-l-4 border-l-slate-400 bg-panel-soft";
  return "";
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

function relativeUpdated(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return iso.slice(0, 10);
}
