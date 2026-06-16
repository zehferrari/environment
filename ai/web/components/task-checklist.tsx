"use client";

// Lightweight sub-task checklist (ENV-60/61). Renders a task's progress
// checklist: each item is a goal line + a checkbox. When an item is ticked done
// the assignee can record minutes spent on it; the header sums those minutes for
// a rough cost view. Humans edit here; the assigned agent does the same through
// the native workflow endpoint. The server is the source of truth — optimistic
// edits are replaced by the revalidated list on the next render.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
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

export type ChecklistItem = {
  id: string;
  text: string;
  completedAt: string | null;
  minutesSpent: number | null;
};

type Props = {
  taskId: string;
  projectSlug: string;
  items: ChecklistItem[];
  addAction: (formData: FormData) => Promise<void>;
  toggleAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
  reorderAction: (orderedIds: string[]) => Promise<void>;
};

export function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export default function TaskChecklist({
  taskId,
  projectSlug,
  items,
  addAction,
  toggleAction,
  removeAction,
  reorderAction,
}: Props) {
  const [order, setOrder] = useState(items);
  const [text, setText] = useState("");
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Server is source of truth: adopt the revalidated list when it changes.
  useEffect(() => {
    setOrder(items);
  }, [items]);

  const total = order.length;
  const done = order.filter((i) => i.completedAt).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const totalMinutes = order.reduce((sum, i) => sum + (i.minutesSpent ?? 0), 0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const submitToggle = useCallback(
    (id: string, completed: boolean, minutesSpent?: number | null) => {
      const fd = new FormData();
      fd.set("taskId", taskId);
      fd.set("projectSlug", projectSlug);
      fd.set("subTaskId", id);
      fd.set("completed", completed ? "1" : "0");
      if (minutesSpent !== undefined) fd.set("minutesSpent", String(minutesSpent ?? 0));
      startTransition(() => {
        void toggleAction(fd);
      });
    },
    [taskId, projectSlug, toggleAction],
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

  const toggle = useCallback(
    (item: ChecklistItem) => {
      const completed = !item.completedAt;
      setOrder((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? {
                ...i,
                completedAt: completed ? new Date().toISOString() : null,
                minutesSpent: completed ? i.minutesSpent : null,
              }
            : i,
        ),
      );
      submitToggle(item.id, completed);
    },
    [submitToggle],
  );

  const setMinutes = useCallback(
    (item: ChecklistItem, minutes: number | null) => {
      const normalized = minutes && minutes > 0 ? Math.round(minutes) : null;
      if (normalized === (item.minutesSpent ?? null)) return;
      setOrder((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, minutesSpent: normalized } : i)),
      );
      submitToggle(item.id, true, normalized);
    },
    [submitToggle],
  );

  const remove = useCallback(
    (id: string) => {
      setOrder((prev) => prev.filter((i) => i.id !== id));
      const fd = new FormData();
      fd.set("taskId", taskId);
      fd.set("projectSlug", projectSlug);
      fd.set("subTaskId", id);
      startTransition(() => {
        void removeAction(fd);
      });
    },
    [taskId, projectSlug, removeAction],
  );

  const add = useCallback(() => {
    const value = text.trim();
    if (!value) return;
    const fd = new FormData();
    fd.set("taskId", taskId);
    fd.set("projectSlug", projectSlug);
    fd.set("text", value);
    setText("");
    startTransition(() => {
      void addAction(fd);
    });
    inputRef.current?.focus();
  }, [text, taskId, projectSlug, addAction]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-wide text-text">
          Sub-tasks
        </h2>
        <div className="flex items-center gap-3">
          {totalMinutes > 0 ? (
            <span
              className="inline-flex items-center gap-1 text-xs text-text-muted"
              title="Total self-reported time across completed sub-tasks"
            >
              <ClockIcon />
              {formatMinutes(totalMinutes)}
            </span>
          ) : null}
          {total > 0 ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-28 overflow-hidden rounded-full bg-line">
                <div
                  className="h-full rounded-full bg-accent transition-[width]"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="tabular-nums text-xs text-text-muted">
                {done}/{total}
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <p className="mb-3 text-[11px] text-text-muted">
        Break this task into independent, parallelizable steps. Tick each off as
        it lands and record the minutes it took — the board shows how many remain
        and the total time rolls up here.
      </p>

      {total === 0 ? (
        <p className="text-xs text-text-muted">No sub-tasks yet.</p>
      ) : (
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
              aria-label="Sub-tasks"
              className="divide-y divide-line rounded-lg border border-line bg-panel-soft"
            >
              {order.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  onToggle={() => toggle(item)}
                  onRemove={() => remove(item.id)}
                  onSetMinutes={(minutes) => setMinutes(item, minutes)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <div className="mt-4 flex gap-2">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          maxLength={500}
          placeholder="Add a step…"
          className="flex-1 rounded-lg border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <button
          type="button"
          onClick={add}
          className="rounded-lg bg-accent px-3 text-sm font-medium text-bg hover:opacity-90"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function ChecklistRow({
  item,
  onToggle,
  onRemove,
  onSetMinutes,
}: {
  item: ChecklistItem;
  onToggle: () => void;
  onRemove: () => void;
  onSetMinutes: (minutes: number | null) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });
  const done = Boolean(item.completedAt);
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-3 py-2 text-sm ${isDragging ? "opacity-50" : ""}`}
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
      <input
        type="checkbox"
        checked={done}
        onChange={onToggle}
        aria-label={done ? `Mark "${item.text}" not done` : `Mark "${item.text}" done`}
        className="h-4 w-4 shrink-0 accent-text-accent"
      />
      <span
        className={`min-w-0 flex-1 ${done ? "text-text-muted line-through" : ""}`}
        title={item.completedAt ? `Completed ${item.completedAt}` : undefined}
      >
        {item.text}
      </span>
      {done ? (
        <MinutesInput minutes={item.minutesSpent} onCommit={onSetMinutes} />
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-md px-1.5 py-1 text-text-muted hover:bg-crit/10 hover:text-crit"
        aria-label={`Remove "${item.text}"`}
        title="Remove"
      >
        <TrashIcon />
      </button>
    </li>
  );
}

// Compact minutes field shown on a completed item. Local state while editing;
// commits the value on blur or Enter so a tick doesn't fire a write per keypress.
function MinutesInput({
  minutes,
  onCommit,
}: {
  minutes: number | null;
  onCommit: (minutes: number | null) => void;
}) {
  const [value, setValue] = useState(minutes != null ? String(minutes) : "");
  useEffect(() => {
    setValue(minutes != null ? String(minutes) : "");
  }, [minutes]);
  const commit = () => {
    const trimmed = value.trim();
    onCommit(trimmed === "" ? null : Number(trimmed));
  };
  return (
    <label className="flex shrink-0 items-center gap-1 text-[10px] text-text-muted" title="Minutes spent on this step">
      <ClockIcon />
      <input
        type="number"
        min={0}
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder="min"
        aria-label="Minutes spent"
        className="w-12 rounded border border-line bg-bg px-1 py-0.5 text-right tabular-nums outline-none focus:border-accent"
      />
      <span>m</span>
    </label>
  );
}

function ClockIcon() {
  return (
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
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
