"use client";

import { useState, useTransition } from "react";
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

type Task = { id: string; title: string; status: string; rank: number };
type Column = { id: string; label: string };

type BoardProps = {
  projectSlug: string;
  columns: ReadonlyArray<Column>;
  tasks: Task[];
  moveTaskAction: (taskId: string, status: string, slug: string) => Promise<void>;
};

export default function Board({ projectSlug, columns, tasks, moveTaskAction }: BoardProps) {
  const [items, setItems] = useState<Task[]>(tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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

    // Optimistic move + server persist.
    setItems((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: overCol } : t)),
    );
    startTransition(async () => {
      await moveTaskAction(taskId, overCol, projectSlug);
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
      <div className="grid grid-cols-5 gap-3">
        {columns.map((col) => {
          const colTasks = items
            .filter((t) => t.status === col.id)
            .sort((a, b) => a.rank - b.rank);
          return (
            <ColumnDroppable key={col.id} id={col.id} label={col.label} count={colTasks.length}>
              {colTasks.map((t) => (
                <TaskCard key={t.id} task={t} />
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

function TaskCard({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`rounded border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm cursor-grab select-none ${
        isDragging ? "opacity-30" : ""
      }`}
    >
      {task.title}
    </div>
  );
}
