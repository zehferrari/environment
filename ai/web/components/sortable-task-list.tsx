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
  actorDisplayName,
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";
import { formatGridDate } from "@/lib/date-format";

export type SortableTaskItem = {
  id: string;
  title: string;
  status?: string;
  href: string;
  createdAt?: string | null;
  reporter?: MessageActor | null;
  assignee?: MessageActor | null;
  reviewer?: MessageActor | null;
  assigneeName?: string | null;
  reviewerName?: string | null;
  updatedAt?: string | null;
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
  const [, startTransition] = useTransition();

  // Server is source of truth: when revalidatePath refreshes the list,
  // adopt the new server order.
  useEffect(() => {
    setOrder(items);
  }, [items]);

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
          className={tableLayout ? "divide-y divide-[var(--color-line)]" : "divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)]"}
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
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );

  if (!tableLayout) return rows;

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)]">
      <div className="grid min-w-[46rem] grid-cols-[minmax(14rem,1fr)_10rem_10rem_5rem_5rem_2rem] items-center gap-3 border-b border-[var(--color-line)] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        <span>Task</span>
        <span>Assignee</span>
        <span>Reviewer</span>
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
        className={`grid min-w-[46rem] cursor-pointer grid-cols-[minmax(14rem,1fr)_10rem_10rem_5rem_5rem_2rem] items-center gap-3 px-3 py-2 text-sm transition hover:bg-[var(--color-panel)] ${
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
            className="cursor-grab select-none rounded px-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] active:cursor-grabbing"
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
              className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
              aria-label={`Select ${item.title}`}
            />
          )}
          {showReporterAvatar && item.reporter ? <MessageAvatar actor={item.reporter} size="sm" /> : null}
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
        </div>
        {showAssignee ? (
          <PersonCell actor={item.assignee ?? null} fallbackName={item.assigneeName} emptyLabel="unassigned" />
        ) : <span />}
        {showReviewer ? (
          <PersonCell actor={item.reviewer ?? null} fallbackName={item.reviewerName} emptyLabel="none" />
        ) : <span />}
        {showCreated ? <TimeCell iso={item.createdAt ?? null} dateOnly /> : <span />}
        {showUpdated ? <TimeCell iso={item.updatedAt ?? null} /> : <span />}
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
              className="rounded-md px-1.5 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-crit)]/10 hover:text-[var(--color-crit)]"
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
      className={`flex items-center gap-2 px-3 py-2 text-sm ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        className="cursor-grab select-none rounded px-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] active:cursor-grabbing"
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
          className="h-4 w-4 shrink-0 accent-[var(--color-accent)]"
          aria-label={`Select ${item.title}`}
        />
      )}
      <Link href={item.href} className="min-w-0 flex-1 truncate hover:underline">
        {item.title}
      </Link>
      <div className="flex shrink-0 items-center gap-3 text-xs text-[var(--color-text-muted)]">
        {showAssignee && item.assigneeName ? (
          <span>@{item.assigneeName}</span>
        ) : null}
        {showStatusBadge && item.status ? (
          <span className="rounded border border-[var(--color-line)] px-1.5 py-0.5">
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
}: {
  actor: MessageActor | null;
  fallbackName?: string | null;
  emptyLabel: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-muted)]">
      {actor ? <MessageAvatar actor={actor} size="sm" /> : null}
      <span className="truncate">
        {actor ? actorDisplayName(actor) : fallbackName ? `@${fallbackName}` : emptyLabel}
      </span>
    </span>
  );
}

function TimeCell({ iso, dateOnly = false }: { iso: string | null; dateOnly?: boolean }) {
  if (!iso) {
    return <span className="text-right text-xs text-[var(--color-text-muted)]">—</span>;
  }
  return (
    <time
      dateTime={iso}
      title={iso}
      className="text-right text-xs tabular-nums text-[var(--color-text-muted)]"
      suppressHydrationWarning
    >
      {dateOnly ? formatGridDate(iso) : relativeUpdated(iso)}
    </time>
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
