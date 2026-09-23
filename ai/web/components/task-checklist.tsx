"use client";

// Lightweight sub-task checklist (ENV-60/61). Renders a task's progress
// checklist: each item is a goal line + a checkbox. When an item is ticked done
// the assignee can record minutes spent on it; the header sums those minutes for
// a rough cost view. Humans edit here; the assigned agent does the same through
// the native workflow endpoint. The server is the source of truth — optimistic
// edits are replaced by the revalidated list on the next render.
//
// Items carry a `kind`: "implementation" is the assignee's In Progress
// breakdown, "review" is the reviewer's topics-to-address list. The two phases
// render as separate titled sections, each with its own progress summary; the
// Review section stays hidden until the task reaches Review or the first
// review topic exists.

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
import { useToast } from "@/components/toast";
import { CSS } from "@dnd-kit/utilities";

// Mirrors SubTaskKind in lib/tasks/subtasks.ts (not imported: that module is
// server-only — it pulls in the db client).
export type ChecklistKind = "implementation" | "review";

export type ChecklistItem = {
  id: string;
  text: string;
  completedAt: string | null;
  minutesSpent: number | null;
  kind: ChecklistKind;
  reviewFinding?: { id: string; completionEvidence: string | null } | null;
};

type Props = {
  taskId: string;
  projectSlug: string;
  taskStatus: string;
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
  taskStatus,
  items,
  addAction,
  toggleAction,
  removeAction,
  reorderAction,
}: Props) {
  const toast = useToast();
  const [order, setOrder] = useState(items);
  const [text, setText] = useState("");
  // null = follow the status-based default (review while the task is in
  // Review, implementation otherwise); set once the user picks a phase.
  const [kindOverride, setKindOverride] = useState<ChecklistKind | null>(null);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Server is source of truth: adopt the revalidated list when it changes.
  useEffect(() => {
    setOrder(items);
  }, [items]);

  const implementation = order.filter((i) => i.kind !== "review");
  const review = order.filter((i) => i.kind === "review");
  const showReview = review.length > 0 || taskStatus === "Review";
  const addKind: ChecklistKind =
    kindOverride ?? (taskStatus === "Review" ? "review" : "implementation");
  const totalMinutes = order.reduce((sum, i) => sum + (i.minutesSpent ?? 0), 0);

  const submitToggle = useCallback(
    (id: string, completed: boolean, minutesSpent?: number | null, completionEvidence?: string) => {
      const fd = new FormData();
      fd.set("taskId", taskId);
      fd.set("projectSlug", projectSlug);
      fd.set("subTaskId", id);
      fd.set("completed", completed ? "1" : "0");
      if (completionEvidence) fd.set("completionEvidence", completionEvidence);
      if (minutesSpent !== undefined) fd.set("minutesSpent", String(minutesSpent ?? 0));
      startTransition(async () => {
        try { await toggleAction(fd); } catch (error) { setOrder(items); toast.show({ message: error instanceof Error ? error.message : "Could not save checklist change." }); }
      });
    },
    [taskId, projectSlug, toggleAction, items, toast],
  );

  // Drags are section-local. Persist a full-task order (implementation block
  // then review block) so a within-section reorder keeps global ranks
  // consistent for both phases.
  const reorderSection = useCallback(
    (kind: ChecklistKind, next: ChecklistItem[]) => {
      const other = order.filter((i) =>
        kind === "review" ? i.kind !== "review" : i.kind === "review",
      );
      const full = kind === "review" ? [...other, ...next] : [...next, ...other];
      setOrder(full);
      startTransition(() => {
        void reorderAction(full.map((t) => t.id));
      });
    },
    [order, reorderAction],
  );

  const toggle = useCallback(
    (item: ChecklistItem) => {
      const completed = !item.completedAt;
      const evidence = item.reviewFinding && completed ? window.prompt("Describe the correction and verification evidence:")?.trim() : undefined;
      if (item.reviewFinding && completed && !evidence) return;
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
      submitToggle(item.id, completed, undefined, evidence);
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
    fd.set("kind", addKind);
    setText("");
    startTransition(() => {
      void addAction(fd);
    });
    inputRef.current?.focus();
  }, [text, taskId, projectSlug, addKind, addAction]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-body font-semibold tracking-wide text-text">
          Sub-tasks
        </h2>
        {totalMinutes > 0 ? (
          <span
            className="inline-flex items-center gap-1 text-caption text-text-muted"
            title="Total self-reported time across completed sub-tasks"
          >
            <ClockIcon />
            {formatMinutes(totalMinutes)}
          </span>
        ) : null}
      </div>

      <p className="mb-3 text-micro text-text-muted">
        Implementation steps are the assignee&rsquo;s In&nbsp;Progress breakdown;
        review topics are the reviewer&rsquo;s points to address. Tick items off
        as they land and record the minutes — the board card shows whichever
        list matches its column.
      </p>

      <div className="space-y-5">
        <ChecklistSection
          title="Implementation"
          emptyLabel="No implementation steps yet."
          items={implementation}
          onReorder={(next) => reorderSection("implementation", next)}
          onToggle={toggle}
          onRemove={remove}
          onSetMinutes={setMinutes}
        />
        {showReview ? (
          <ChecklistSection
            title="Review"
            emptyLabel="No review topics yet."
            items={review}
            onReorder={(next) => reorderSection("review", next)}
            onToggle={toggle}
            onRemove={remove}
            onSetMinutes={setMinutes}
          />
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
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
          placeholder={addKind === "review" ? "Add a review topic…" : "Add a step…"}
          className="min-h-11 min-w-40 flex-1 rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent md:min-h-0"
        />
        <div
          role="group"
          aria-label="Checklist phase for the new item"
          className="flex divide-x divide-line overflow-hidden rounded-lg border border-line"
        >
          <KindButton
            active={addKind === "implementation"}
            onClick={() => setKindOverride("implementation")}
          >
            Implementation
          </KindButton>
          <KindButton
            active={addKind === "review"}
            onClick={() => setKindOverride("review")}
          >
            Review
          </KindButton>
        </div>
        <button
          type="button"
          onClick={add}
          className="min-h-11 rounded-lg bg-accent px-4 text-body font-medium text-bg hover:opacity-90 md:min-h-0 md:px-3"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// One checklist phase: a titled section with its own progress summary
// (minutes, bar, done/total) and its own drag-to-reorder scope.
function ChecklistSection({
  title,
  emptyLabel,
  items,
  onReorder,
  onToggle,
  onRemove,
  onSetMinutes,
}: {
  title: string;
  emptyLabel: string;
  items: ChecklistItem[];
  onReorder: (next: ChecklistItem[]) => void;
  onToggle: (item: ChecklistItem) => void;
  onRemove: (id: string) => void;
  onSetMinutes: (item: ChecklistItem, minutes: number | null) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );
  const total = items.length;
  const done = items.filter((i) => i.completedAt).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const minutes = items.reduce((sum, i) => sum + (i.minutesSpent ?? 0), 0);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((t) => t.id === active.id);
    const newIndex = items.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(items, oldIndex, newIndex));
  };

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
          {title}
        </h3>
        <div className="flex items-center gap-3">
          {minutes > 0 ? (
            <span
              className="inline-flex items-center gap-1 text-caption text-text-muted"
              title={`Total self-reported time across completed ${title.toLowerCase()} items`}
            >
              <ClockIcon />
              {formatMinutes(minutes)}
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
              <span className="tabular-nums text-caption text-text-muted">
                {done}/{total}
              </span>
            </div>
          ) : null}
        </div>
      </div>
      {total === 0 ? (
        <p className="text-caption text-text-muted">{emptyLabel}</p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={items.map((t) => t.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              aria-label={`${title} sub-tasks`}
              className="divide-y divide-line rounded-lg border border-line bg-panel-soft"
            >
              {items.map((item) => (
                <ChecklistRow
                  key={item.id}
                  item={item}
                  onToggle={() => onToggle(item)}
                  onRemove={() => onRemove(item.id)}
                  onSetMinutes={(m) => onSetMinutes(item, m)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

function KindButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-11 px-3 text-caption font-medium transition md:min-h-0 ${
        active ? "bg-accent-soft text-accent" : "bg-bg text-text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
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
      className={`flex min-h-11 items-center gap-2 px-3 py-2 text-body ${isDragging ? "opacity-50" : ""}`}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        className="grid h-11 w-11 cursor-grab select-none place-items-center rounded text-text-muted hover:text-text active:cursor-grabbing md:h-auto md:w-auto md:px-1"
      >
        ⋮⋮
      </button>
      <input
        type="checkbox"
        checked={done}
        onChange={onToggle}
        aria-label={done ? `Mark "${item.text}" not done` : `Mark "${item.text}" done`}
        className="h-6 w-6 shrink-0 accent-text-accent md:h-4 md:w-4"
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
        disabled={!!item.reviewFinding}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-text-muted hover:bg-crit/10 hover:text-crit md:h-auto md:w-auto md:px-1.5 md:py-1"
        aria-label={`Remove "${item.text}"`}
        title={item.reviewFinding ? "Review corrections require an explicit reviewer supersession decision; they cannot be deleted." : "Remove"}
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
    <label className="flex shrink-0 items-center gap-1 text-nano text-text-muted" title="Minutes spent on this step">
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
