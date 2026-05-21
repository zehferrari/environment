"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
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

export default function Board({ projectSlug, columns, tasks, moveTaskAction }: BoardProps) {
  const [items, setItems] = useState<Task[]>(tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Server is the source of truth: when revalidatePath re-renders this
  // page with fresh tasks (status, rank), reset the local optimistic
  // copy. Without this, a successful server move keeps showing the
  // stale optimistic state until the user reloads.
  useEffect(() => {
    setItems(tasks);
  }, [tasks]);

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

      <div className="grid grid-cols-5 gap-3">
        {columns.map((col) => {
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
