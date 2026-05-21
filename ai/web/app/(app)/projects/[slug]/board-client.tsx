"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
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
  const router = useRouter();
  const [items, setItems] = useState<Task[]>(tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // Keyboard selection: the focused card's id, plus an explicit "show
  // ring" flag so we only paint the selection indicator after the user
  // has actually interacted with a hotkey. Avoids a stray ring appearing
  // on first render before the user knows hotkeys exist.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSelection, setShowSelection] = useState(false);
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

  // Pre-bucket the visible board into [column][sorted tasks] so the
  // hotkey handler can index into it in O(1) without re-filtering on
  // every keypress. Memoised against the same inputs the render uses so
  // navigation always agrees with what's on screen.
  const columnLanes = useMemo(
    () =>
      visibleColumns.map((col) => ({
        col,
        tasks: items
          .filter((t) => t.status === col.id)
          .sort((a, b) => a.rank - b.rank),
      })),
    [visibleColumns, items],
  );

  // If the currently-selected card disappears (deleted, filtered out by
  // hiding Backlog, moved off-screen by another agent), drop the
  // selection rather than leaving a stale invisible target. The ring
  // also disappears since there is nothing to draw it on.
  useEffect(() => {
    if (!selectedId) return;
    const stillVisible = columnLanes.some((lane) =>
      lane.tasks.some((t) => t.id === selectedId),
    );
    if (!stillVisible) {
      setSelectedId(null);
      setShowSelection(false);
    }
  }, [columnLanes, selectedId]);

  // Keep a ref to the selected card so we can scroll it into view when
  // the user hops between columns (the target may be outside the
  // viewport on tall boards).
  const selectedCardRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showSelection) return;
    selectedCardRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId, showSelection]);

  const moveSelection = useCallback(
    (dx: number, dy: number) => {
      if (columnLanes.length === 0) return;
      // Find current (col, row); if nothing is selected yet, seed at
      // the first card of the first non-empty column.
      let colIdx = -1;
      let rowIdx = -1;
      if (selectedId) {
        for (let c = 0; c < columnLanes.length; c++) {
          const r = columnLanes[c].tasks.findIndex((t) => t.id === selectedId);
          if (r !== -1) {
            colIdx = c;
            rowIdx = r;
            break;
          }
        }
      }
      if (colIdx === -1) {
        const seedCol = columnLanes.findIndex((lane) => lane.tasks.length > 0);
        if (seedCol === -1) return;
        setSelectedId(columnLanes[seedCol].tasks[0].id);
        setShowSelection(true);
        return;
      }

      if (dy !== 0) {
        const lane = columnLanes[colIdx].tasks;
        const next = rowIdx + dy;
        if (next < 0 || next >= lane.length) return;
        setSelectedId(lane[next].id);
        setShowSelection(true);
        return;
      }

      if (dx !== 0) {
        // Step across columns until we hit one with at least one card;
        // clamp the row to that column's length so the selection lands
        // on a real card instead of an empty index.
        let target = colIdx + dx;
        while (target >= 0 && target < columnLanes.length && columnLanes[target].tasks.length === 0) {
          target += dx;
        }
        if (target < 0 || target >= columnLanes.length) return;
        const lane = columnLanes[target].tasks;
        const clamped = Math.min(rowIdx, lane.length - 1);
        setSelectedId(lane[clamped].id);
        setShowSelection(true);
      }
    },
    [columnLanes, selectedId],
  );

  // Window-scoped hotkeys: J/K move within column, H/L move across
  // columns, Enter opens the selected task. The first qualifying key
  // also seeds the selection if none exists.
  //
  // Suppress when the user is typing into a text field or contenteditable
  // surface so the title input / future inline editors are not hijacked.
  // Modifier-bearing keystrokes are ignored too (Ctrl-J, Cmd-K, etc.)
  // so we do not collide with browser/OS shortcuts.
  useEffect(() => {
    function isEditableTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      if (t.isContentEditable) return true;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const k = e.key;
      if (k === "j" || k === "J" || k === "ArrowDown") {
        moveSelection(0, 1);
        e.preventDefault();
      } else if (k === "k" || k === "K" || k === "ArrowUp") {
        moveSelection(0, -1);
        e.preventDefault();
      } else if (k === "h" || k === "H" || k === "ArrowLeft") {
        moveSelection(-1, 0);
        e.preventDefault();
      } else if (k === "l" || k === "L" || k === "ArrowRight") {
        moveSelection(1, 0);
        e.preventDefault();
      } else if (k === "Enter" && selectedId) {
        router.push(`/projects/${projectSlug}/tasks/${selectedId}`);
        e.preventDefault();
      } else if (k === "Escape" && showSelection) {
        setShowSelection(false);
        setSelectedId(null);
        e.preventDefault();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moveSelection, projectSlug, router, selectedId, showSelection]);

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

      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--color-text-muted)]">
          <kbd className="rounded border border-[var(--color-line)] px-1">J</kbd>
          /<kbd className="rounded border border-[var(--color-line)] px-1">K</kbd> move within column ·{" "}
          <kbd className="rounded border border-[var(--color-line)] px-1">H</kbd>
          /<kbd className="rounded border border-[var(--color-line)] px-1">L</kbd> across columns ·{" "}
          <kbd className="rounded border border-[var(--color-line)] px-1">Enter</kbd> open
        </p>
        <button
          type="button"
          onClick={() => setBacklogVisible((v) => !v)}
          aria-pressed={backlogVisible}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {backlogVisible
            ? "Hide Backlog"
            : `Show Backlog${backlogCount ? ` (${backlogCount})` : ""}`}
        </button>
      </div>

      <div className={`grid ${gridColsClass} gap-3`}>
        {columnLanes.map(({ col, tasks: colTasks }) => (
          <ColumnDroppable key={col.id} id={col.id} label={col.label} count={colTasks.length}>
            {colTasks.map((t) => {
              const isSelected = showSelection && t.id === selectedId;
              return (
                <TaskCard
                  key={t.id}
                  task={t}
                  projectSlug={projectSlug}
                  isSelected={isSelected}
                  cardRef={isSelected ? selectedCardRef : null}
                />
              );
            })}
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
  isSelected,
  cardRef,
}: {
  task: Task;
  projectSlug: string;
  isSelected: boolean;
  cardRef: React.RefObject<HTMLDivElement | null> | null;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  // Combine the dnd-kit ref with our scroll-into-view ref. dnd-kit owns
  // the real DOM node; we just observe it through cardRef.
  function refCallback(node: HTMLDivElement | null) {
    setNodeRef(node);
    if (cardRef) cardRef.current = node;
  }
  return (
    <div
      ref={refCallback}
      {...attributes}
      {...listeners}
      aria-selected={isSelected || undefined}
      className={`rounded-lg border bg-[var(--color-panel)] px-3 py-2 text-sm cursor-grab select-none flex items-start justify-between gap-2 ${
        isSelected
          ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]"
          : "border-[var(--color-line)]"
      } ${isDragging ? "opacity-30" : ""}`}
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
