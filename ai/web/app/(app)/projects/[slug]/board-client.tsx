"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MoveTaskResult } from "./page";

type Task = {
  id: string;
  title: string;
  status: string;
  rank: number;
  updatedAt: string;
  assigneeName: string | null;
  epicTitle: string | null;
};
type Column = { id: string; label: string };

type BoardProps = {
  projectSlug: string;
  columns: ReadonlyArray<Column>;
  tasks: Task[];
  moveTaskAction: (
    taskId: string,
    status: string,
    slug: string,
  ) => Promise<MoveTaskResult>;
  reorderTasksAction: (orderedIds: string[]) => Promise<void>;
};

// Per Stage 0 sign-off (HOMELAB-44 description): the Backlog column has a
// show/hide toggle, defaults to hidden. Preference persists per project in
// localStorage so each board remembers its own state across reloads.
const BACKLOG_VISIBLE_KEY_PREFIX = "pm.board.backlogVisible.";

export default function Board({ projectSlug, columns, tasks, moveTaskAction, reorderTasksAction }: BoardProps) {
  const [items, setItems] = useState<Task[]>(tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Server-render and first client-render both start hidden so React
  // hydration matches; the stored preference (if any) is applied in a
  // post-mount effect, which is a normal state update and not a
  // hydration mismatch.
  const [backlogVisible, setBacklogVisible] = useState(false);
  const [prefsHydrated, setPrefsHydrated] = useState(false);

  // Server is the source of truth: when revalidatePath re-renders this
  // page with fresh tasks (status, rank), reset the local optimistic
  // copy. Without this, a successful server move keeps showing the
  // stale optimistic state until the user reloads.
  useEffect(() => {
    setItems(tasks);
  }, [tasks]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(
        BACKLOG_VISIBLE_KEY_PREFIX + projectSlug,
      );
      if (stored === "true") setBacklogVisible(true);
      else if (stored === "false") setBacklogVisible(false);
    } catch {
      // localStorage can throw in private modes or sandboxed iframes —
      // fall back to the default (hidden) silently.
    }
    setPrefsHydrated(true);
  }, [projectSlug]);

  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      window.localStorage.setItem(
        BACKLOG_VISIBLE_KEY_PREFIX + projectSlug,
        backlogVisible ? "true" : "false",
      );
    } catch {
      // Same fallback as the read: ignore storage failures.
    }
  }, [backlogVisible, projectSlug, prefsHydrated]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const taskId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId || overId === taskId) return;

    const task = items.find((t) => t.id === taskId);
    if (!task) return;

    // Drop target is a column (header / empty space) — cross-column move
    // with append-to-end. The existing moveTask handler enforces workflow
    // rules and computes rank.
    if (columns.some((c) => c.id === overId)) {
      if (task.status === overId) return;
      crossColumnMove(task, overId);
      return;
    }

    // Drop target is another card. If same status → reorder within
    // column. If different status → move into that card's column
    // (workflow check, append). Insert-at-position across columns is
    // intentionally out of scope here — once moved, the user can
    // reorder within the destination column.
    const over = items.find((t) => t.id === overId);
    if (!over) return;
    if (task.status === over.status) {
      reorderWithinColumn(task, over);
    } else {
      crossColumnMove(task, over.status);
    }
  }

  function crossColumnMove(task: Task, newStatus: string) {
    const previousStatus = task.status;
    setItems((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)),
    );
    setMoveError(null);
    startTransition(async () => {
      const result = await moveTaskAction(task.id, newStatus, projectSlug);
      if (!result.ok) {
        setItems((prev) =>
          prev.map((t) =>
            t.id === task.id ? { ...t, status: previousStatus } : t,
          ),
        );
        setMoveError(result.message);
      }
    });
  }

  function reorderWithinColumn(active: Task, over: Task) {
    const colTasks = items
      .filter((t) => t.status === active.status)
      .sort((a, b) => a.rank - b.rank);
    const oldIdx = colTasks.findIndex((t) => t.id === active.id);
    const newIdx = colTasks.findIndex((t) => t.id === over.id);
    if (oldIdx === -1 || newIdx === -1 || oldIdx === newIdx) return;
    const reordered = arrayMove(colTasks, oldIdx, newIdx);
    // Rewrite optimistic ranks 0..N within this column; other columns
    // are untouched. Server-side reorderTasks does the same write.
    const rankByTask = new Map(reordered.map((t, i) => [t.id, i]));
    setItems((prev) =>
      prev.map((t) =>
        rankByTask.has(t.id) ? { ...t, rank: rankByTask.get(t.id)! } : t,
      ),
    );
    startTransition(() => {
      void reorderTasksAction(reordered.map((t) => t.id));
    });
  }

  const active = items.find((t) => t.id === activeId);

  // Backlog is no longer a board column: the four workflow columns render
  // as the board grid, and Backlog renders below as its own card grid
  // (HOMELAB-41). Drag-and-drop still works across both because the move
  // logic keys off task status / droppable id, not layout.
  const workflowColumns = useMemo(
    () => columns.filter((c) => c.id !== "Backlog"),
    [columns],
  );
  const backlogTasks = useMemo(
    () =>
      items
        .filter((t) => t.status === "Backlog")
        .sort((a, b) => a.rank - b.rank),
    [items],
  );
  const backlogCount = backlogTasks.length;

  const columnLanes = useMemo(
    () =>
      workflowColumns.map((col) => ({
        col,
        tasks: items
          .filter((t) => t.status === col.id)
          .sort((a, b) => a.rank - b.rank),
      })),
    [workflowColumns, items],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {moveError ? (
        <div
          role="alert"
          className="mb-3 flex items-start justify-between gap-3 rounded border border-[var(--color-danger,#ff5d5d)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm"
        >
          <span>{moveError}</span>
          <button
            type="button"
            onClick={() => setMoveError(null)}
            className="text-xs uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            dismiss
          </button>
        </div>
      ) : null}

      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
            Backlog{backlogCount ? ` (${backlogCount})` : ""}
          </h2>
          <button
            type="button"
            onClick={() => setBacklogVisible((v) => !v)}
            aria-pressed={backlogVisible}
            className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {backlogVisible ? "Hide Backlog" : "Show Backlog"}
          </button>
        </div>

        {backlogVisible ? (
          <BacklogDroppable>
            {backlogTasks.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-[var(--color-text-muted)]">
                Backlog is empty. Drag a row here or add a task.
              </p>
            ) : (
              <div>
                <div className="grid grid-cols-[minmax(0,1fr)_10rem_8rem_4rem_1.5rem] items-center gap-3 border-b border-[var(--color-line)] px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  <span>Task</span>
                  <span>Epic</span>
                  <span>Assignee</span>
                  <span className="text-right">Updated</span>
                  <span className="sr-only">Open</span>
                </div>
                <SortableContext
                  items={backlogTasks.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {backlogTasks.map((t) => (
                    <BacklogRow key={t.id} task={t} projectSlug={projectSlug} />
                  ))}
                </SortableContext>
              </div>
            )}
          </BacklogDroppable>
        ) : null}
      </section>

      <div className="grid grid-cols-4 gap-3">
        {columnLanes.map(({ col, tasks: colTasks }) => (
          <ColumnDroppable key={col.id} id={col.id} label={col.label} count={colTasks.length}>
            <SortableContext
              items={colTasks.map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              {colTasks.map((t) => (
                <TaskCard key={t.id} task={t} projectSlug={projectSlug} />
              ))}
            </SortableContext>
          </ColumnDroppable>
        ))}
      </div>

      <DragOverlay>
        {active ? (
          <div className="rounded border border-[var(--color-accent)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm shadow-lg cursor-grabbing">
            {active.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function ColumnDroppable({
  id,
  label,
  count,
  children,
}: {
  id: string;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border bg-[var(--color-panel)] min-h-[60vh] p-2 transition-colors ${
        isOver
          ? "border-[var(--color-accent)] bg-[var(--color-panel-soft)]"
          : "border-[var(--color-line)]"
      }`}
    >
      <div className="px-1 pb-2 text-xs uppercase tracking-wider text-[var(--color-text-muted)] flex justify-between">
        <span>{label}</span>
        <span>{count}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function TaskCard({
  task,
  projectSlug,
}: {
  task: Task;
  projectSlug: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={`rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-sm cursor-grab select-none ${
        isDragging ? "opacity-30" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="truncate">{task.title}</span>
        {/* Open-detail link. stopPropagation on pointerdown keeps the drag
            sensor from claiming the click on the link itself; the rest of
            the card still drags normally. */}
        <Link
          href={`/projects/${projectSlug}/tasks/${task.id}`}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className="shrink-0 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
          aria-label={`Open ${task.title}`}
          title="Open task"
        >
          ↗
        </Link>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-muted)]">
        <span className="truncate">
          {task.assigneeName ? `@${task.assigneeName}` : "unassigned"}
        </span>
        <time
          dateTime={task.updatedAt}
          title={task.updatedAt}
          className="shrink-0 tabular-nums"
        >
          {relativeUpdated(task.updatedAt)}
        </time>
      </div>
    </div>
  );
}

// Droppable wrapper for the Backlog grid. Shares the "Backlog" id with
// the status column, so dragging a card onto this region routes through
// the same crossColumnMove path (status → "Backlog").
function BacklogDroppable({ children }: { children: React.ReactNode }) {
  const { isOver, setNodeRef } = useDroppable({ id: "Backlog" });
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border py-2 transition-colors ${
        isOver
          ? "border-[var(--color-accent)] bg-[var(--color-panel-soft)]"
          : "border-[var(--color-line)] bg-[var(--color-panel)]"
      }`}
    >
      {children}
    </div>
  );
}

// One backlog row in the table-style grid. The drag activator is the
// handle only (not the whole row), so the open-detail link and text stay
// clickable/selectable.
function BacklogRow({
  task,
  projectSlug,
}: {
  task: Task;
  projectSlug: string;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`grid grid-cols-[minmax(0,1fr)_10rem_8rem_4rem_1.5rem] items-center gap-3 border-b border-[var(--color-line)] px-3 py-2 text-sm last:border-b-0 ${
        isDragging ? "bg-[var(--color-panel-soft)] opacity-40" : ""
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder or move"
          className="shrink-0 cursor-grab touch-none select-none px-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          title="Drag"
        >
          ⠿
        </button>
        <span className="truncate">{task.title}</span>
      </div>
      <span className="truncate text-xs text-[var(--color-text-muted)]">
        {task.epicTitle ?? "—"}
      </span>
      <span className="truncate text-xs text-[var(--color-text-muted)]">
        {task.assigneeName ? `@${task.assigneeName}` : "unassigned"}
      </span>
      <time
        dateTime={task.updatedAt}
        title={task.updatedAt}
        className="text-right text-xs tabular-nums text-[var(--color-text-muted)]"
      >
        {relativeUpdated(task.updatedAt)}
      </time>
      <Link
        href={`/projects/${projectSlug}/tasks/${task.id}`}
        className="text-right text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        aria-label={`Open ${task.title}`}
        title="Open task"
      >
        ↗
      </Link>
    </div>
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
