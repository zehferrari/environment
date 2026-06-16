"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import {
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";
import { formatGridDate } from "@/lib/date-format";
import { bulkBinTasks } from "@/lib/bin/actions";
import ConfirmPopup from "@/components/confirm-popup";
import { canShowDeploymentForTask, deploymentStatusIcon } from "@/lib/deploy/deployment-status";

type BoardActor = MessageActor & { id: string };

type Task = {
  id: string;
  workItemKey: string | null;
  title: string;
  status: string;
  rank: number;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
  approvedOn: string | null;
  deploymentStatus: string;
  epicId: string | null;
  reporter: BoardActor | null;
  assignee: BoardActor | null;
  reviewer: BoardActor | null;
  manager: BoardActor | null;
  createdBy: BoardActor | null;
  updatedBy: BoardActor | null;
  epicTitle: string | null;
  subtaskTotal: number;
  subtaskDone: number;
  subtaskMinutes: number;
  blockedByKey: string | null;
  activeWorking: boolean;
};
type Column = { id: string; label: string; description?: string };

// Bottom-right lock badge (ENV-62): shown when the task is blocked by another
// task that isn't Done yet. The key is the blocker's work-item id.
function BlockedBadge({ task }: { task: Task }) {
  if (!task.blockedByKey) return null;
  return (
    <span
      className="ml-auto inline-flex items-center gap-1 text-nano font-semibold text-crit"
      title={`Blocked by ${task.blockedByKey} — it must be Done first`}
    >
      <LockGlyph />
      {task.blockedByKey}
    </span>
  );
}

function LockGlyph() {
  return (
    <svg aria-hidden="true" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

function formatMinutes(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0m";
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

// Sub-task progress for a board card (ENV-60/61): a segmented bar with one node
// per sub-task. Completed nodes fill on an orange→green gradient driven by
// overall completion (greener nearer 100%); unfinished nodes are a solid dark
// node, so a not-yet-started (To Do) task reads as a row of dark nodes. Hidden
// when the task has no checklist. Numeric count + rolled-up time live in the
// tooltip.
function SubtaskProgress({ task }: { task: Task }) {
  const n = task.subtaskTotal;
  if (!n) return null;
  const d = task.subtaskDone;
  const ratio = d / n;
  // hue 28 (orange) → 135 (green) as completion rises.
  const fill = `hsl(${Math.round(28 + 107 * ratio)} 85% 45%)`;
  const time = task.subtaskMinutes > 0 ? ` · ${formatMinutes(task.subtaskMinutes)}` : "";
  return (
    <span
      role="img"
      aria-label={`${d} of ${n} sub-tasks done`}
      title={`${d}/${n} sub-tasks done${time}`}
      className="inline-flex h-1.5 w-16 shrink-0 items-center gap-[2px]"
    >
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className="h-full min-w-0 flex-1 rounded-pixel"
          style={{ backgroundColor: i < d ? fill : "var(--color-text-muted)" }}
        />
      ))}
    </span>
  );
}

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
  deleteTaskAction: (formData: FormData) => Promise<void>;
};

// Per Stage 0 sign-off (HOMELAB-44 description): the Backlog column has a
// show/hide toggle, defaults to hidden. Preference persists per project in
// localStorage so each board remembers its own state across reloads.
const BACKLOG_VISIBLE_KEY_PREFIX = "pm.board.backlogVisible.";

// Workflow Focus mirrors the Backlog toggle: hidden by default, with the
// preference persisted per project so each board remembers its own state.
const FOCUS_VISIBLE_KEY_PREFIX = "pm.board.focusVisible.";

// Backlog rows are full-width while the four workflow columns are
// quarter-width. closestCorners can't disambiguate here: a full-width drag
// rect ties across all four columns (their summed corner-distance is the
// same constant) and the full-width Backlog droppable wins outright because
// it x-aligns with the dragged row. The result was that a backlog→To Do
// drop resolved its `over` back to "Backlog", hit the same-status no-op, and
// snapped the card back. Pointer-based detection targets whatever sits under
// the cursor, which is unambiguous regardless of element width; fall back to
// rectIntersection for the rare frame where the pointer is over a gap.
// Pointer-only is safe because the board uses just the PointerSensor.
const boardCollisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  return pointer.length > 0 ? pointer : rectIntersection(args);
};

export default function Board({ projectSlug, columns, tasks, moveTaskAction, reorderTasksAction, deleteTaskAction }: BoardProps) {
  const router = useRouter();
  const isMobileBoard = useIsMobileBoard();
  const [items, setItems] = useState<Task[]>(tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTarget, setBulkTarget] = useState("To Do");
  const [isPending, startTransition] = useTransition();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  // Server-render and first client-render both start hidden so React
  // hydration matches; the stored preference (if any) is applied in a
  // post-mount effect, which is a normal state update and not a
  // hydration mismatch.
  const [backlogVisible, setBacklogVisible] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const [prefsHydrated, setPrefsHydrated] = useState(false);

  // Server is the source of truth: when revalidatePath re-renders this
  // page with fresh tasks (status, rank), reset the local optimistic
  // copy. Without this, a successful server move keeps showing the
  // stale optimistic state until the user reloads.
  useEffect(() => {
    setItems(tasks);
    setSelectedIds((current) => {
      const liveIds = new Set(tasks.map((task) => task.id));
      return new Set([...current].filter((id) => liveIds.has(id)));
    });
  }, [tasks]);

  // Live board updates: an SSE stream emits `board.touch` whenever a task
  // in this project is moved/reordered/binned/etc. We debounce and call
  // router.refresh(), letting Next's revalidatePath path repaint the
  // board without a manual reload. Reconnects on network errors with
  // exponential backoff; pauses while the tab is hidden.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let source: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 1000;
    let closed = false;

    const scheduleRefresh = () => {
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (!document.hidden) router.refresh();
      }, 300);
    };

    const connect = () => {
      if (closed || document.hidden) return;
      try {
        source = new EventSource(`/api/projects/${projectSlug}/board/stream`);
      } catch {
        return;
      }
      source.addEventListener("open", () => {
        retryMs = 1000;
      });
      source.addEventListener("board.touch", () => {
        scheduleRefresh();
      });
      source.addEventListener("error", () => {
        source?.close();
        source = null;
        if (closed) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      });
    };

    const onVisibility = () => {
      if (document.hidden) {
        source?.close();
        source = null;
      } else if (!source) {
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (refreshTimer) clearTimeout(refreshTimer);
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [projectSlug, router]);

  // Polling safety net for live board updates. The SSE stream above gives
  // near-instant refreshes when the in-process board emitter delivers, but
  // status changes coming from a different process/path (e.g. an agent moving
  // a task to Review via the API) can miss that channel. A gentle poll while
  // the tab is visible guarantees the board catches up without a manual
  // reload; it piggybacks on Next's revalidation so it's cheap.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const interval = window.setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 12_000);
    return () => window.clearInterval(interval);
  }, [router]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(
        BACKLOG_VISIBLE_KEY_PREFIX + projectSlug,
      );
      if (stored === "true") setBacklogVisible(true);
      else if (stored === "false") setBacklogVisible(false);
      const storedFocus = window.localStorage.getItem(
        FOCUS_VISIBLE_KEY_PREFIX + projectSlug,
      );
      if (storedFocus === "true") setFocusVisible(true);
      else if (storedFocus === "false") setFocusVisible(false);
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

  useEffect(() => {
    if (!prefsHydrated) return;
    try {
      window.localStorage.setItem(
        FOCUS_VISIBLE_KEY_PREFIX + projectSlug,
        focusVisible ? "true" : "false",
      );
    } catch {
      // Same fallback as the read: ignore storage failures.
    }
  }, [focusVisible, projectSlug, prefsHydrated]);

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: isMobileBoard
        ? { delay: 180, tolerance: 8 }
        : { distance: 4 },
    }),
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
      prev.map((t) => (
        t.id === task.id
          ? { ...t, status: newStatus, statusChangedAt: new Date().toISOString() }
          : t
      )),
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

  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);

  function toggleTaskSelection(taskId: string, selected: boolean, shiftKey?: boolean) {
    const task = items.find((t) => t.id === taskId);
    if (!task) return;

    setSelectedIds((current) => {
      const next = new Set(current);

      if (shiftKey && lastCheckedId) {
        const list = task.status === "Backlog"
          ? items.filter((t) => t.status === "Backlog")
          : items.filter((t) => t.status === task.status).sort((a, b) => a.rank - b.rank);

        const lastIdx = list.findIndex((t) => t.id === lastCheckedId);
        const currIdx = list.findIndex((t) => t.id === taskId);

        if (lastIdx !== -1 && currIdx !== -1) {
          const start = Math.min(lastIdx, currIdx);
          const end = Math.max(lastIdx, currIdx);
          for (let i = start; i <= end; i++) {
            if (selected) {
              next.add(list[i].id);
            } else {
              next.delete(list[i].id);
            }
          }
        } else {
          if (selected) next.add(taskId);
          else next.delete(taskId);
        }
      } else {
        if (selected) next.add(taskId);
        else next.delete(taskId);
      }

      setLastCheckedId(taskId);
      return next;
    });
  }

  function bulkMoveSelected() {
    const movingTasks = items.filter((task) => selectedIds.has(task.id) && task.status !== bulkTarget);
    if (movingTasks.length === 0) return;

    const previousItems = items;
    setItems((prev) =>
      prev.map((task) =>
        selectedIds.has(task.id)
          ? { ...task, status: bulkTarget, statusChangedAt: new Date().toISOString() }
          : task,
      ),
    );
    setMoveError(null);
    startTransition(async () => {
      for (const task of movingTasks) {
        const result = await moveTaskAction(task.id, bulkTarget, projectSlug);
        if (!result.ok) {
          setItems(previousItems);
          setMoveError(result.message);
          return;
        }
      }
      setSelectedIds(new Set());
    });
  }

  function bulkDeleteSelected() {
    if (selectedIds.size === 0) return;
    setConfirmDeleteOpen(true);
  }

  function performBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setConfirmDeleteOpen(false);
      return;
    }
    const previousItems = items;
    setItems((prev) => prev.filter((task) => !selectedIds.has(task.id)));
    setMoveError(null);

    startTransition(async () => {
      try {
        await bulkBinTasks(ids, projectSlug);
        setSelectedIds(new Set());
        setConfirmDeleteOpen(false);
      } catch (err) {
        setItems(previousItems);
        setMoveError((err as Error).message);
        setConfirmDeleteOpen(false);
      }
    });
  }

  function toggleSelectAllBacklog(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      backlogTasks.forEach((t) => {
        if (checked) next.add(t.id);
        else next.delete(t.id);
      });
      return next;
    });
  }

  function toggleSelectAllColumn(columnId: string, checked: boolean) {
    const colTasks = items.filter((t) => t.status === columnId);
    setSelectedIds((current) => {
      const next = new Set(current);
      colTasks.forEach((t) => {
        if (checked) next.add(t.id);
        else next.delete(t.id);
      });
      return next;
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
  const selectedCount = selectedIds.size;

  const columnLanes = useMemo(
    () =>
      workflowColumns.map((col) => ({
        col,
        tasks: items
          .filter((t) => t.status === col.id)
          .sort((a, b) => {
            if (col.id === "Done") {
              return completedAtMs(b) - completedAtMs(a) || b.rank - a.rank;
            }
            return a.rank - b.rank;
          }),
        })),
    [workflowColumns, items],
  );
  const workflowFocus = useMemo(() => {
    const priority: Record<string, number> = {
      Review: 0,
      "To Do": 1,
      "In Progress": 2,
      Backlog: 3,
    };
    return items
      .filter((task) =>
        task.status === "Review" ||
        task.status === "To Do" ||
        task.status === "In Progress" ||
        (task.status === "Backlog" && Boolean(task.assignee)),
      )
      .sort((a, b) => {
        const byStatus = (priority[a.status] ?? 99) - (priority[b.status] ?? 99);
        if (byStatus !== 0) return byStatus;
        return a.rank - b.rank;
      })
      .slice(0, 6);
  }, [items]);
  const mobileBacklogLane = useMemo(
    () => ({ col: { id: "Backlog", label: "Backlog", description: "planning/opinions" }, tasks: backlogTasks }),
    [backlogTasks],
  );
  const mobileLanes = backlogVisible
    ? [...columnLanes, mobileBacklogLane]
    : columnLanes;

  return (
    <DndContext
      // Stable id keeps dnd-kit's generated aria ids deterministic across
      // SSR and hydration. Without it, dnd-kit falls back to a module-global
      // counter that drifts on the long-lived server (incrementing per
      // request) while the client starts from zero, producing a hydration
      // mismatch on the draggables' aria-describedby.
      id={`board-${projectSlug}`}
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <ConfirmPopup
        open={confirmDeleteOpen}
        title="Delete selected tasks"
        description={`Move ${selectedIds.size} task${selectedIds.size === 1 ? "" : "s"} to the bin? They'll be permanently deleted after the bin TTL elapses.`}
        confirmLabel="Move to bin"
        danger
        busy={isPending}
        onConfirm={performBulkDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
      {moveError ? (
        <div
          role="alert"
          className="mb-3 flex items-start justify-between gap-3 rounded border border-danger bg-panel-soft px-3 py-2 text-body"
        >
          <span>{moveError}</span>
          <button
            type="button"
            onClick={() => setMoveError(null)}
            className="text-caption uppercase tracking-wider text-text-muted hover:text-text"
          >
            dismiss
          </button>
        </div>
      ) : null}

      {selectedCount > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-panel border border-accent/30 bg-accent/[0.08] px-4 py-3 text-body shadow-sm">
          <span className="font-semibold text-text">
            {selectedCount} selected
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-caption font-semibold uppercase tracking-wider text-text-muted">
              <span>Move to</span>
              <select
                value={bulkTarget}
                onChange={(event) => setBulkTarget(event.currentTarget.value)}
                className="rounded-lg border border-line bg-bg px-2 py-1.5 text-caption text-text outline-none focus:border-accent"
              >
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={bulkMoveSelected}
              className="rounded-lg bg-accent px-control-x py-control-y text-caption font-semibold text-bg transition hover:opacity-90"
            >
              Move selected
            </button>
            <button
              type="button"
              onClick={bulkDeleteSelected}
              className="rounded-lg border border-crit bg-transparent px-control-x py-control-y text-caption font-semibold text-crit transition hover:bg-crit hover:text-bg"
            >
              Delete selected
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-semibold text-text-muted transition hover:border-accent hover:text-accent"
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}

      {focusVisible && workflowFocus.length > 0 ? (
        <section className="mb-5 rounded-lg border border-line bg-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setFocusVisible(false)}
                className="rounded-card border border-line bg-panel px-3 py-1 text-caption uppercase tracking-wider text-text-muted hover:text-text"
              >
                Hide Focus
              </button>
              <h2 className="text-caption font-semibold uppercase tracking-wider text-text-muted">
                Workflow focus
              </h2>
            </div>
            <span className="text-nano uppercase tracking-wider text-text-muted">
              feedback → review → start
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {workflowFocus.map((task) => (
              <WorkflowFocusCard
                key={task.id}
                task={task}
                projectSlug={projectSlug}
                now={now}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="mb-6">
        {/* When the Backlog is expanded, the Show Workflow Focus button gets
            its own row on top of the backlog banner rather than sharing the
            row with the Backlog heading / Hide Backlog control. */}
        {backlogVisible && !focusVisible && workflowFocus.length > 0 ? (
          <div className="mb-3 flex">
            <button
              type="button"
              onClick={() => setFocusVisible(true)}
              aria-pressed={focusVisible}
              className="rounded-card border border-line bg-panel px-3 py-1 text-caption uppercase tracking-wider text-text-muted hover:text-text"
            >
              Show Workflow Focus
            </button>
          </div>
        ) : null}
        <div className="mb-3 flex items-center justify-between gap-3">
          {/* When the Backlog is hidden, the Show Workflow Focus button sits
              inline at the left, level with the Show Backlog button. */}
          <div className="flex items-center gap-3">
            {!backlogVisible && !focusVisible && workflowFocus.length > 0 ? (
              <button
                type="button"
                onClick={() => setFocusVisible(true)}
                aria-pressed={focusVisible}
                className="rounded-card border border-line bg-panel px-3 py-1 text-caption uppercase tracking-wider text-text-muted hover:text-text"
              >
                Show Workflow Focus
              </button>
            ) : null}
            {backlogVisible ? (
              <h2 className="text-caption uppercase tracking-wider text-text-muted">
                Backlog{backlogCount ? ` (${backlogCount})` : ""} · planning/opinions
              </h2>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setBacklogVisible((v) => !v)}
            aria-pressed={backlogVisible}
            className="rounded-card border border-line bg-panel px-3 py-1 text-caption uppercase tracking-wider text-text-muted hover:text-text"
          >
            {backlogVisible ? "Hide Backlog" : "Show Backlog"}
          </button>
        </div>

        {backlogVisible && !isMobileBoard ? (
          <BacklogDroppable>
            {backlogTasks.length === 0 ? (
              <p className="px-1 py-6 text-center text-caption text-text-muted">
                Backlog is empty. Drag a row here or add a task.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <div className="grid min-w-[68rem] grid-cols-[minmax(14rem,1fr)_10rem_10rem_10rem_7rem_6rem_6rem_2rem] items-center gap-3 border-b border-line px-3 pb-2 text-nano font-semibold uppercase tracking-wider text-text-muted">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={backlogCount > 0 && backlogTasks.every((t) => selectedIds.has(t.id))}
                      onChange={(e) => toggleSelectAllBacklog(e.target.checked)}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="h-6 w-6 accent-accent md:h-3.5 md:w-3.5"
                      aria-label="Select all backlog tasks"
                    />
                    <span>Task</span>
                  </div>
                  <span>Epic</span>
                  <span>Assignee</span>
                  <span>Reviewer</span>
                  <span className="text-right">Elapsed</span>
                  <span className="text-right">Created At</span>
                  <span className="text-right">Updated</span>
                  <span className="sr-only">Bin</span>
                </div>
                <div className="max-h-[780px] overflow-y-auto pr-1">
                  <SortableContext
                    items={backlogTasks.map((t) => t.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    {backlogTasks.map((t) => (
                      <BacklogRow
                        key={t.id}
                        task={t}
                        projectSlug={projectSlug}
                        deleteTaskAction={deleteTaskAction}
                        selected={selectedIds.has(t.id)}
                        onSelectionChange={toggleTaskSelection}
                        now={now}
                      />
                    ))}
                  </SortableContext>
                </div>
              </div>
            )}
          </BacklogDroppable>
        ) : null}
      </section>

      {isMobileBoard ? (
        <div className="space-y-3 md:hidden">
          <div className="rounded-card border border-line bg-panel-soft px-3 py-2 text-caption text-text-muted">
            Long-press a card to drag or reorder. Swipe a card left for quick Move/Edit actions.
          </div>
          {mobileLanes.map(({ col, tasks: colTasks }) => {
            const colTaskIds = colTasks.map((t) => t.id);
            const allSelected = colTaskIds.length > 0 && colTaskIds.every((id) => selectedIds.has(id));
            return (
              <MobileStatusGroup
                key={col.id}
                id={col.id}
                label={col.label}
                description={col.description}
                count={colTasks.length}
                allSelected={allSelected}
                onSelectAll={(checked) => toggleSelectAllColumn(col.id, checked)}
              >
                <SortableContext
                  items={colTasks.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {colTasks.map((t) => (
                    <MobileTaskCard
                      key={t.id}
                      task={t}
                      projectSlug={projectSlug}
                      deleteTaskAction={deleteTaskAction}
                      now={now}
                      selected={selectedIds.has(t.id)}
                      onSelectionChange={toggleTaskSelection}
                      onMove={(task, status) => crossColumnMove(task, status)}
                      nextStatus={nextMobileStatus(t.status, columns)}
                    />
                  ))}
                </SortableContext>
              </MobileStatusGroup>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {columnLanes.map(({ col, tasks: colTasks }) => {
            const colTaskIds = colTasks.map((t) => t.id);
            const allSelected = colTaskIds.length > 0 && colTaskIds.every((id) => selectedIds.has(id));
            return (
              <ColumnDroppable
                key={col.id}
                id={col.id}
                label={col.label}
                description={col.description}
                count={colTasks.length}
                allSelected={allSelected}
                onSelectAll={(checked) => toggleSelectAllColumn(col.id, checked)}
              >
                <SortableContext
                  items={colTasks.map((t) => t.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {colTasks.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      projectSlug={projectSlug}
                      deleteTaskAction={deleteTaskAction}
                      now={now}
                      selected={selectedIds.has(t.id)}
                      onSelectionChange={toggleTaskSelection}
                    />
                  ))}
                </SortableContext>
              </ColumnDroppable>
            );
          })}
        </div>
      )}

      <DragOverlay>
        {active ? (
          <div className="rounded border border-accent bg-panel-soft px-3 py-2 text-body shadow-lg cursor-grabbing">
            {active.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function useIsMobileBoard() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return isMobile;
}

function nextMobileStatus(status: string, columns: ReadonlyArray<Column>) {
  const visible = columns.filter((column) => column.id !== "Backlog");
  const index = visible.findIndex((column) => column.id === status);
  const next = visible[index + 1] ?? visible[0] ?? columns[0];
  return next?.id ?? status;
}

function MobileStatusGroup({
  id,
  label,
  description,
  count,
  allSelected,
  onSelectAll,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  count: number;
  allSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <details
      ref={setNodeRef}
      open
      className={`rounded-xl border shadow-sm transition-colors ${columnSurfaceClass(id)} ${isOver ? "ring-2 ring-accent/50" : ""}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 [&::-webkit-details-marker]:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => onSelectAll(event.target.checked)}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            className="h-6 w-6 shrink-0 accent-accent md:h-4 md:w-4"
            aria-label={`Select all in ${label}`}
          />
          <span className={`rounded border px-2 py-1 text-caption font-semibold uppercase tracking-wider ${columnHeaderPillClass(id)}`}>
            {label}
          </span>
          {description ? (
            <span className="truncate text-caption text-text-muted">{description}</span>
          ) : null}
        </div>
        <span className="rounded-full border border-line bg-bg px-2 py-0.5 text-caption font-semibold text-text-muted">
          {count}
        </span>
      </summary>
      <div className="space-y-2 px-2 pb-3">{children}</div>
    </details>
  );
}

function MobileTaskCard({
  task,
  projectSlug,
  deleteTaskAction,
  now,
  selected,
  onSelectionChange,
  onMove,
  nextStatus,
}: {
  task: Task;
  projectSlug: string;
  deleteTaskAction: (formData: FormData) => Promise<void>;
  now: number | null;
  selected: boolean;
  onSelectionChange: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
  onMove: (task: Task, status: string) => void;
  nextStatus: string;
}) {
  const router = useRouter();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const actor = boardActorForTask(task);
  const nextLabel = nextStatus === task.status ? "Move" : `Move → ${nextStatus}`;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`overflow-x-auto rounded-lg ${isDragging ? "opacity-30" : ""}`}
    >
      <div className="flex min-w-[calc(100%+9rem)] items-stretch">
        <div
          {...attributes}
          {...listeners}
          onClick={() => router.push(`/projects/${projectSlug}/tasks/${task.id}`)}
          className={`${taskCardClass(task)} min-w-[calc(100%-9rem)] touch-pan-y active:cursor-grabbing`}
        >
          <div className="relative z-10 space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectionChange(task.id, !selected, event.shiftKey);
                  }}
                  onChange={() => {}}
                  onPointerDown={(event) => event.stopPropagation()}
                  aria-label={`Select ${task.title}`}
                  className="mt-0.5 h-6 w-6 shrink-0 accent-accent md:h-4 md:w-4"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5 text-nano text-text-muted">
                    {actor ? <MessageAvatar actor={actor} size="sm" busy={task.activeWorking} /> : null}
                    <span className="truncate font-mono uppercase tracking-wider">
                      {task.workItemKey ?? "—"}
                    </span>
                    {canShowTaskDeploymentIndicator(task) ? <DeploymentIndicator status={task.deploymentStatus} /> : null}
                  </div>
                  <div className="mt-1 line-clamp-2 text-body font-medium leading-snug">{task.title}</div>
                  {task.epicTitle ? (
                    <div className="mt-1 truncate text-caption text-text-muted">{task.epicTitle}</div>
                  ) : null}
                </div>
              </div>
              <form
                action={deleteTaskAction}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <input type="hidden" name="projectSlug" value={projectSlug} />
                <input type="hidden" name="taskId" value={task.id} />
                <button
                  type="submit"
                  className="grid h-11 w-11 place-items-center rounded-md text-text-muted hover:bg-crit/10 hover:text-crit md:h-auto md:w-auto md:p-1"
                  aria-label={`Move ${task.title} to bin`}
                  title="Move to bin"
                >
                  <TrashIcon />
                </button>
              </form>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-nano text-text-muted">
              <ElapsedClock task={task} now={now} />
              <SubtaskProgress task={task} />
              <time dateTime={task.updatedAt} title={task.updatedAt} className="tabular-nums" suppressHydrationWarning>
                {relativeUpdated(task.updatedAt)}
              </time>
              <BlockedBadge task={task} />
            </div>
          </div>
        </div>
        <div className="ml-2 flex w-36 shrink-0 flex-col gap-2 py-1 pr-1">
          <button
            type="button"
            onClick={() => onMove(task, nextStatus)}
            className="min-h-11 flex-1 rounded-lg bg-accent px-2 text-caption font-semibold text-bg shadow-sm"
          >
            {nextLabel}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/projects/${projectSlug}/tasks/${task.id}`)}
            className="min-h-11 flex-1 rounded-lg border border-line bg-panel px-2 text-caption font-semibold text-text"
          >
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

function ColumnDroppable({
  id,
  label,
  description,
  count,
  allSelected = false,
  onSelectAll,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  count: number;
  allSelected?: boolean;
  onSelectAll?: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-[60vh] rounded-lg border p-2 shadow-sm transition-colors ${columnSurfaceClass(id)} ${
        isOver
          ? "ring-2 ring-accent/50"
          : ""
      }`}
    >
      <div className="px-1 pb-2 text-nano uppercase tracking-wider text-text-muted flex justify-between items-center">
        <div className="flex items-center gap-1.5 min-w-0">
          {onSelectAll && (
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onSelectAll(e.target.checked)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-3.5 w-3.5 shrink-0 accent-accent"
              aria-label={`Select all in ${label}`}
            />
          )}
          <span className={`w-fit rounded border px-1.5 py-0.5 text-nano font-semibold uppercase tracking-wider ${columnHeaderPillClass(id)}`}>
            {label}
          </span>
          {description ? (
            <span className="hidden truncate normal-case tracking-normal text-text-muted xl:inline">
              · {description}
            </span>
          ) : null}
        </div>
        <span className="shrink-0">{count}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function TaskCard({
  task,
  projectSlug,
  deleteTaskAction,
  now,
  selected,
  onSelectionChange,
}: {
  task: Task;
  projectSlug: string;
  deleteTaskAction: (formData: FormData) => Promise<void>;
  now: number | null;
  selected: boolean;
  onSelectionChange: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
}) {
  const router = useRouter();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });
  const actor = boardActorForTask(task);
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => router.push(`/projects/${projectSlug}/tasks/${task.id}`)}
      className={taskCardClass(task, isDragging)}
    >
      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <input
            type="checkbox"
            checked={selected}
            onClick={(event) => {
              event.stopPropagation();
              onSelectionChange(task.id, !selected, event.shiftKey);
            }}
            onChange={() => {}}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={`Select ${task.title}`}
            className="h-6 w-6 shrink-0 accent-accent md:h-4 md:w-4"
          />
          {task.status === "Done" ? (
            <BoardReporterMarker task={task} />
          ) : actor ? (
            <MessageAvatar actor={actor} size="sm" busy={task.activeWorking} />
          ) : (
            <span className="text-nano text-text-muted">unassigned</span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-nano text-text-muted">
              {canShowTaskDeploymentIndicator(task) ? <DeploymentIndicator status={task.deploymentStatus} /> : null}
              <span className="truncate font-mono uppercase tracking-wider">
                {task.workItemKey ?? "—"}
              </span>
              {task.epicTitle ? <span className="ml-1 normal-case tracking-normal">· {task.epicTitle}</span> : null}
            </div>
            <div className="truncate">{task.title}</div>
            <div className="mt-1 flex items-center gap-2 text-nano text-text-muted">
              <ElapsedClock task={task} now={now} />
              <SubtaskProgress task={task} />
              <time
                dateTime={task.updatedAt}
                title={task.updatedAt}
                className="shrink-0 tabular-nums"
                // relativeUpdated() reads Date.now() at render, so server/client
                // can land in different buckets and throw a recoverable React
                // #418 hydration warning; suppress it (text is expected to differ).
                suppressHydrationWarning
              >
                {relativeUpdated(task.updatedAt)}
              </time>
              <BlockedBadge task={task} />
            </div>
          </div>
        </div>
        <form
          action={deleteTaskAction}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
        >
          <input type="hidden" name="projectSlug" value={projectSlug} />
          <input type="hidden" name="taskId" value={task.id} />
          <button
            type="submit"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-text-muted hover:bg-crit/10 hover:text-crit md:h-auto md:w-auto md:p-1"
            aria-label={`Move ${task.title} to bin`}
            title="Move to bin"
          >
            <TrashIcon />
          </button>
        </form>
      </div>
    </div>
  );
}

function WorkflowFocusCard({
  task,
  projectSlug,
  now,
}: {
  task: Task;
  projectSlug: string;
  now: number | null;
}) {
  const router = useRouter();
  const actor = boardActorForTask(task);

  return (
    <button
      type="button"
      onClick={() => router.push(`/projects/${projectSlug}/tasks/${task.id}`)}
      className={`${taskCardClass(task)} min-w-0 text-left`}
    >
      <div className="relative z-10 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {task.status === "Done" ? (
            <BoardReporterMarker task={task} />
          ) : actor ? (
            <MessageAvatar actor={actor} size="sm" busy={task.activeWorking} />
          ) : (
            <span className="text-nano text-text-muted">unassigned</span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5 text-nano text-text-muted">
              <span className={`shrink-0 rounded border px-1 py-0.5 text-pico font-semibold uppercase tracking-wider ${columnHeaderPillClass(task.status)}`}>
                {task.status}
              </span>
              {canShowTaskDeploymentIndicator(task) ? <DeploymentIndicator status={task.deploymentStatus} /> : null}
              <span className="truncate font-mono uppercase tracking-wider">
                {task.workItemKey ?? "—"}
              </span>
              {task.epicTitle ? <span className="ml-1 normal-case tracking-normal">· {task.epicTitle}</span> : null}
            </div>
            <div className="mt-0.5 truncate text-body">{task.title}</div>
            <div className="mt-1 flex items-center gap-2 text-nano text-text-muted">
              <ElapsedClock task={task} now={now} />
              <SubtaskProgress task={task} />
              <time
                dateTime={task.updatedAt}
                title={task.updatedAt}
                className="shrink-0 tabular-nums"
                suppressHydrationWarning
              >
                {relativeUpdated(task.updatedAt)}
              </time>
              <BlockedBadge task={task} />
            </div>
          </div>
        </div>
      </div>
    </button>
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
          ? "border-accent bg-panel-soft"
          : "border-line bg-panel"
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
  deleteTaskAction,
  selected,
  onSelectionChange,
  now,
}: {
  task: Task;
  projectSlug: string;
  deleteTaskAction: (formData: FormData) => Promise<void>;
  selected: boolean;
  onSelectionChange: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
  now: number | null;
}) {
  const router = useRouter();
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
      role="link"
      tabIndex={0}
      onClick={() => router.push(`/projects/${projectSlug}/tasks/${task.id}`)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          router.push(`/projects/${projectSlug}/tasks/${task.id}`);
        }
      }}
      className={`grid min-h-11 min-w-[68rem] cursor-pointer grid-cols-[minmax(14rem,1fr)_10rem_10rem_10rem_7rem_6rem_6rem_2rem] items-center gap-3 border-b border-line px-3 py-2 text-body transition last:border-b-0 hover:bg-panel-soft active:scale-[0.98] md:min-h-0 md:active:scale-100 ${
        isPlanningAssigned(task) ? "bg-yellow-300/[0.08]" : statusRowClass(task.status)
      } ${isDragging ? "bg-panel-soft opacity-40" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="checkbox"
          checked={selected}
          onClick={(event) => {
            event.stopPropagation();
            onSelectionChange(task.id, !selected, event.shiftKey);
          }}
          onChange={() => {}}
          onPointerDown={(event) => event.stopPropagation()}
          aria-label={`Select ${task.title}`}
          className="h-6 w-6 shrink-0 accent-accent md:h-4 md:w-4"
        />
        <button
          type="button"
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
          aria-label="Drag to reorder or move"
          className="grid h-11 w-11 shrink-0 cursor-grab touch-none select-none place-items-center text-text-muted hover:text-text md:h-auto md:w-auto md:px-0.5"
          title="Drag"
        >
          ⠿
        </button>
        <BoardReporterMarker task={task} />
        {canShowTaskDeploymentIndicator(task) ? <DeploymentIndicator status={task.deploymentStatus} /> : null}
        <span className="min-w-0 truncate">
          {task.workItemKey ? (
            <span className="mr-1 font-mono text-nano font-semibold text-text-muted">
              {task.workItemKey}
            </span>
          ) : null}
          {task.title}
        </span>
        <SubtaskProgress task={task} />
        <BlockedBadge task={task} />
      </div>
      <span className="truncate text-caption text-text-muted">
        {task.epicTitle ?? "—"}
      </span>
      <PersonCell actor={task.assignee} emptyLabel="unassigned" />
      <PersonCell actor={task.reviewer} emptyLabel="none" />
      <ElapsedClock task={task} now={now} align="right" />
      <DateActorCell iso={task.createdAt} actor={task.createdBy} dateOnly />
      <DateActorCell iso={task.updatedAt} actor={task.updatedBy} />
      <form
        action={deleteTaskAction}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        className="text-right"
      >
        <input type="hidden" name="projectSlug" value={projectSlug} />
        <input type="hidden" name="taskId" value={task.id} />
        <button
          type="submit"
          className="grid h-11 w-11 place-items-center rounded-md text-text-muted hover:bg-crit/10 hover:text-crit md:h-auto md:w-auto md:px-1.5 md:py-1"
          aria-label={`Move ${task.title} to bin`}
          title="Move to bin"
        >
          <TrashIcon />
        </button>
      </form>
    </div>
  );
}

function DeploymentIndicator({ status }: { status: string }) {
  const icon = deploymentStatusIcon(status);
  if (icon === "—") {
    return (
      <span
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-line text-pico text-text-muted transition hover:scale-110 hover:border-accent"
        title="Deployment: Not Required"
        aria-label="Deployment: Not Required"
      >
        —
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-nano leading-none transition hover:scale-110"
      title={`Deployment: ${status}`}
      aria-label={`Deployment: ${status}`}
    >
      {icon}
    </span>
  );
}

function canShowTaskDeploymentIndicator(task: Task) {
  return task.status === "Done" && canShowDeploymentForTask(task);
}

function BoardReporterMarker({ task }: { task: Task }) {
  return task.reporter ? <MessageAvatar actor={task.reporter} size="sm" /> : null;
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

function PersonCell({
  actor,
  emptyLabel,
}: {
  actor: BoardActor | null;
  emptyLabel: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-caption text-text-muted">
      {actor ? (
        <MessageAvatar actor={actor} size="sm" />
      ) : (
        <span className="truncate">{emptyLabel}</span>
      )}
    </span>
  );
}

function boardActorForTask(task: Task): BoardActor | null {
  if (task.status === "To Do") return task.assignee ?? task.reporter;
  if (task.status === "In Progress") {
    return task.assignee ?? task.reviewer ?? task.manager ?? task.reporter;
  }
  if (task.status === "Review") {
    return task.reviewer ?? task.manager ?? task.reporter;
  }
  if (task.status === "Done") return task.reporter ?? task.assignee;
  return task.reporter ?? task.assignee ?? task.reviewer ?? task.manager;
}

function completedAtMs(task: Task) {
  return parseTime(task.statusChangedAt ?? task.updatedAt) ?? 0;
}

function isPlanningAssigned(task: Task) {
  return Boolean(
    task.assignee &&
    !task.approvedOn &&
    (task.status === "Backlog" || task.status === "To Do"),
  );
}

function ElapsedClock({
  task,
  now,
  align = "compact",
}: {
  task: Task;
  now: number | null;
  align?: "compact" | "right";
}) {
  const elapsed = elapsedMsForTask(task, now);
  if (elapsed === null) {
    if (align === "right") {
      return <span className="text-right text-caption text-text-muted">—</span>;
    }
    return null;
  }
  return (
    <span
      title={elapsedTitle(task)}
      className={`shrink-0 items-center gap-1 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-nano tabular-nums text-text-muted ${
        align === "right" ? "ml-auto flex justify-end" : "inline-flex"
      }`}
    >
      <TimerIcon />
      {formatElapsed(elapsed)}
    </span>
  );
}

function elapsedMsForTask(task: Task, now: number | null) {
  const end =
    task.status === "Done"
      ? parseTime(task.statusChangedAt ?? task.updatedAt)
      : now;
  if (end === null) return null;

  const start =
    task.status === "Backlog"
      ? parseTime(task.createdAt)
      : parseTime(task.approvedOn ?? task.createdAt);
  if (start === null) return null;
  return Math.max(0, end - start);
}

function elapsedTitle(task: Task) {
  if (task.status === "Done") {
    return `Approved ${task.approvedOn ?? task.createdAt}; completed ${task.statusChangedAt ?? task.updatedAt}`;
  }
  if (task.status === "Backlog") return `Since creation: ${task.createdAt}`;
  return `Total since ${task.approvedOn ? `approval: ${task.approvedOn}` : `creation: ${task.createdAt}`}`;
}

function parseTime(iso: string | null | undefined) {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  return Number.isFinite(time) ? time : null;
}

function DateActorCell({
  iso,
  actor,
  dateOnly = false,
}: {
  iso: string;
  actor: BoardActor | null;
  dateOnly?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center justify-end gap-1.5 text-caption text-text-muted">
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

function formatElapsed(ms: number) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusRowClass(status: string) {
  if (status === "To Do") return "bg-sky-400/[0.06]";
  if (status === "In Progress") return "bg-emerald-400/[0.07]";
  if (status === "Review") return "bg-amber-400/[0.09]";
  if (status === "Done") return "bg-lime-400/[0.06]";
  if (status === "Backlog") return "bg-panel-soft";
  return "";
}

function taskCardClass(task: Task, isDragging = false) {
  return `group/card relative block w-full overflow-hidden rounded-lg border px-3 py-2 text-body cursor-pointer select-none shadow-[0_14px_34px_rgba(15,23,42,0.12)] ring-1 ring-white/10 backdrop-blur-xl transition-all active:scale-[0.98] md:active:scale-100 before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/80 before:to-transparent after:pointer-events-none after:absolute after:inset-0 after:-translate-x-full after:bg-[linear-gradient(110deg,transparent,rgba(255,255,255,0.16),transparent)] after:opacity-0 after:transition-all after:duration-700 hover:-translate-y-0.5 hover:border-white/55 hover:shadow-[0_18px_46px_rgba(15,23,42,0.18)] hover:after:translate-x-full hover:after:opacity-100 ${
    isPlanningAssigned(task)
      ? "border-yellow-200/70 bg-[linear-gradient(135deg,rgba(254,240,138,0.22),rgba(255,255,255,0.08))]"
      : "border-white/25 bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0.06))]"
  } ${isDragging ? "opacity-30" : ""}`;
}

function columnSurfaceClass(status: string) {
  if (status === "To Do") return "border-violet-200/35 bg-violet-300/[0.40]";
  if (status === "In Progress") return "border-sky-300/35 bg-sky-500/[0.11]";
  if (status === "Review") return "border-amber-300/40 bg-amber-500/[0.14]";
  if (status === "Done") return "border-lime-300/35 bg-lime-500/[0.10]";
  return "border-line bg-panel";
}

function columnHeaderPillClass(status: string) {
  if (status === "To Do") return "border-violet-500/70 bg-violet-100 text-violet-950 shadow-[inset_0_0_0_1px_rgba(124,58,237,0.2)]";
  if (status === "In Progress") return "border-sky-500/70 bg-sky-100 text-sky-950 shadow-[inset_0_0_0_1px_rgba(2,132,199,0.18)]";
  if (status === "Review") return "border-amber-500/80 bg-amber-100 text-amber-950 shadow-[inset_0_0_0_1px_rgba(217,119,6,0.22)]";
  if (status === "Done") return "border-lime-600/70 bg-lime-100 text-lime-950 shadow-[inset_0_0_0_1px_rgba(101,163,13,0.18)]";
  return "border-slate-500/60 bg-slate-100 text-slate-950 shadow-[inset_0_0_0_1px_rgba(71,85,105,0.16)]";
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

function relativeUpdated(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return iso.slice(0, 10);
}
