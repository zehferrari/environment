"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { MoveTaskResult } from "./page";

type Task = { id: string; title: string; status: string; rank: number };
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
};

// Per Stage 0 sign-off (HOMELAB-44 description): the Backlog column has a
// show/hide toggle, defaults to hidden. Preference persists per project in
// localStorage so each board remembers its own state across reloads.
const BACKLOG_VISIBLE_KEY_PREFIX = "pm.board.backlogVisible.";

export default function Board({ projectSlug, columns, tasks, moveTaskAction }: BoardProps) {
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
    const overCol = e.over?.id ? String(e.over.id) : null;
    if (!overCol || !columns.some((c) => c.id === overCol)) return;
    const task = items.find((t) => t.id === taskId);
    if (!task || task.status === overCol) return;

    const previousStatus = task.status;
    // Optimistic move. If the server rejects (workflow rule violation,
    // unknown column), the transition handler rolls this card back to
    // previousStatus and surfaces the rejection message.
    setItems((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: overCol } : t)),
    );
    setMoveError(null);

    startTransition(async () => {
      const result = await moveTaskAction(taskId, overCol, projectSlug);
      if (!result.ok) {
        setItems((prev) =>
          prev.map((t) =>
            t.id === taskId ? { ...t, status: previousStatus } : t,
          ),
        );
        setMoveError(result.message);
      }
    });
  }

  const active = items.find((t) => t.id === activeId);

  const visibleColumns = useMemo(
    () => (backlogVisible ? columns : columns.filter((c) => c.id !== "Backlog")),
    [backlogVisible, columns],
  );
  const backlogCount = useMemo(
    () => items.filter((t) => t.status === "Backlog").length,
    [items],
  );
  // Tailwind v4 scans source for literal class names, so both literals
  // need to appear in the file — keep this as a switch on two strings,
  // not a template.
  const gridColsClass =
    visibleColumns.length === 5 ? "grid-cols-5" : "grid-cols-4";

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

      <div className="mb-3 flex items-center justify-end">
        <button
          type="button"
          onClick={() => setBacklogVisible((v) => !v)}
          aria-pressed={backlogVisible}
          className="rounded border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {backlogVisible
            ? "Hide Backlog"
            : `Show Backlog${backlogCount ? ` (${backlogCount})` : ""}`}
        </button>
      </div>

      <div className={`grid ${gridColsClass} gap-3`}>
        {visibleColumns.map((col) => {
          const colTasks = items
            .filter((t) => t.status === col.id)
            .sort((a, b) => a.rank - b.rank);
          return (
            <ColumnDroppable key={col.id} id={col.id} label={col.label} count={colTasks.length}>
              {colTasks.map((t) => (
                <TaskCard key={t.id} task={t} projectSlug={projectSlug} />
              ))}
            </ColumnDroppable>
          );
        })}
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

function TaskCard({ task, projectSlug }: { task: Task; projectSlug: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm cursor-grab select-none flex items-start justify-between gap-2 ${
        isDragging ? "opacity-30" : ""
      }`}
    >
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
  );
}
