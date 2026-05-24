"use client";

import Link from "next/link";
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

export type SortableTaskItem = {
  id: string;
  title: string;
  status?: string;
  href: string;
  assigneeName?: string | null;
  updatedAt?: string | null;
};

type Props = {
  items: SortableTaskItem[];
  showStatusBadge?: boolean;
  showAssignee?: boolean;
  showUpdated?: boolean;
  reorderAction: (orderedIds: string[]) => Promise<void>;
  ariaLabel?: string;
};

export default function SortableTaskList({
  items,
  showStatusBadge = false,
  showAssignee = false,
  showUpdated = false,
  reorderAction,
  ariaLabel,
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

  return (
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
          className="divide-y divide-[var(--color-line)] rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)]"
        >
          {order.map((t) => (
            <SortableRow
              key={t.id}
              item={t}
              showStatusBadge={showStatusBadge}
              showAssignee={showAssignee}
              showUpdated={showUpdated}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  item,
  showStatusBadge,
  showAssignee,
  showUpdated,
}: {
  item: SortableTaskItem;
  showStatusBadge: boolean;
  showAssignee: boolean;
  showUpdated: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
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

function relativeUpdated(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return iso.slice(0, 10);
}
