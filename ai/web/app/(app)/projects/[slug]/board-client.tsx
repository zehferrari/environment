"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { MoveTaskOptions, MoveTaskResult } from "@/lib/tasks/move-status";
import {
  actorDisplayName,
  MessageAvatar,
  type MessageActor,
} from "@/components/message-avatar";
import { useAgentPresenceMap } from "@/components/agent-presence-provider";
import { formatGridDate } from "@/lib/date-format";
import { bulkBinTasks } from "@/lib/bin/actions";
import { bulkUpdateTaskRole, type BulkTaskRoleField } from "@/lib/tasks/bulk-roles";
import ConfirmPopup from "@/components/confirm-popup";
import TaskBulkEditControls, { type BulkTaskEditField } from "@/components/task-bulk-edit-controls";
import type { AvatarComboboxOption } from "@/components/avatar-combobox";
import { canShowDeploymentForTask, deploymentStatusIcon } from "@/lib/deploy/deployment-status";
import { boardAvailableHeight, boardChromeSlotId, boardStickyTop } from "@/lib/board-chrome";

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
  subtaskImplTotal: number;
  subtaskImplDone: number;
  subtaskReviewTotal: number;
  subtaskReviewDone: number;
  subtaskMinutes: number;
  blockedByKey: string | null;
  executionState: string | null;
  executionReason: string | null;
  hasActiveBlocker: boolean;
  activeBlockerCommentId: string | null;
  activeWorking: boolean;
  project: { slug: string; name: string; workspace?: { slug: string; name: string } | null } | null;
  workspaceColor?: string | null;
  projectColor?: string | null;
};
type Column = { id: string; label: string; description?: string };
type BoardStats = {
  total: number;
  open: number;
  done: number;
  blocked: number;
  attention: number;
  completion: number;
  byStatus: Record<string, number>;
};

// Bottom-right lock badge (ENV-62): shown when the task is blocked by another
// task that isn't Done yet. The key is the blocker's work-item id.
// Which colour cues a board card paints, derived from the board's chrome scope.
type CardScope = "home" | "workspace" | "project";

function BlockedBadge({ task }: { task: Task }) {
  if (!task.blockedByKey) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-md bg-crit/[0.07] px-1.5 py-0.5 text-micro font-semibold text-crit"
      title={`Blocked by ${task.blockedByKey} — it must be Done first`}
    >
      <LockGlyph />
      {task.blockedByKey}
    </span>
  );
}

// Execution badge (ENV-123): the board's compact form of the task page's
// execution strip. Only the states an operator must act on are painted —
// "running" and "idle" are the normal case and would be pure noise on every
// card. Hovering gives the reason sentence, so a stalled card explains itself
// without a click.
const EXECUTION_BADGE_TONE: Record<string, string> = {
  stalled: "bg-crit/[0.07] text-crit",
  blocked: "bg-warn/[0.07] text-warn",
};

function ExecutionBadge({ task }: { task: Task }) {
  const tone = task.executionState ? EXECUTION_BADGE_TONE[task.executionState] : undefined;
  if (!task.executionState || !tone) return null;
  return (
    <span
      data-execution-badge={task.executionState}
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-micro font-semibold ${tone}`}
      title={
        task.executionReason
          ? `Execution: ${task.executionState} — ${task.executionReason}`
          : `Execution: ${task.executionState}`
      }
    >
      {task.executionState.replaceAll("_", " ")}
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

function ActiveBlockerButton({ task, projectSlug }: { task: Task; projectSlug: string }) {
  const router = useRouter();
  if (!task.hasActiveBlocker) return null;
  const href = blockerHref(task, projectSlug);
  return (
    <button
      type="button"
      data-active-task-blocker
      aria-label={`Open the active blocker comment for ${task.title}`}
      title="Open and focus the active blocker comment"
      onClick={(event) => {
        event.stopPropagation();
        router.push(href);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="inline-grid h-8 w-8 shrink-0 place-items-center rounded-full border border-crit/30 bg-crit/10 text-crit shadow-[var(--shadow-xs)] transition hover:border-crit/60 hover:bg-crit/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crit/60"
    >
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    </button>
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

// Sub-task progress for a board card (ENV-60/61): a solid bar whose colour
// names the phase — In Progress fills green against a dark track, Review fills
// orange against a grey one. Column-aware: In Progress cards track the
// assignee's implementation checklist; Review cards track the reviewer's
// topics-to-address list (a task freshly in Review shows no bar until the
// first review item exists). Other columns show no bar. The readout carries
// both the percentage and the raw count; rolled-up time stays in the tooltip.
function SubtaskProgress({ task }: { task: Task }) {
  const phase =
    task.status === "In Progress"
      ? {
          total: task.subtaskImplTotal,
          done: task.subtaskImplDone,
          noun: "sub-tasks done",
          fill: "var(--status-progress)",
          track: "var(--color-line-strong)",
        }
      : task.status === "Review"
        ? {
            total: task.subtaskReviewTotal,
            done: task.subtaskReviewDone,
            noun: "review topics addressed",
            fill: "var(--status-review)",
            track: "var(--color-line)",
          }
        : null;
  if (!phase) return null;
  const n = phase.total;
  if (!n) return null;
  const d = phase.done;
  const percent = Math.round((d / n) * 100);
  const time = task.subtaskMinutes > 0 ? ` · ${formatMinutes(task.subtaskMinutes)}` : "";
  return (
    <span
      data-board-card-progress
      role="img"
      aria-label={`${percent}% — ${d} of ${n} ${phase.noun}`}
      title={`${d}/${n} ${phase.noun}${time}`}
      className="inline-flex min-w-0 items-center gap-1.5"
    >
      <span
        className="block h-1.5 w-16 shrink-0 overflow-hidden rounded-full"
        style={{ backgroundColor: phase.track }}
        aria-hidden="true"
      >
        <span
          className="block h-full rounded-full transition-[width]"
          style={{ width: `${percent}%`, backgroundColor: phase.fill }}
        />
      </span>
      <span className="shrink-0 text-micro font-medium tabular-nums text-text-muted">
        {percent}% · {d}/{n}
      </span>
    </span>
  );
}

type BoardProps = {
  projectSlug: string;
  chromeSlotScope?: string;
  boardStreamUrl?: string | null;
  columns: ReadonlyArray<Column>;
  tasks: Task[];
  moveTaskAction: (
    taskId: string,
    status: string,
    slug: string,
    options?: MoveTaskOptions,
  ) => Promise<MoveTaskResult>;
  reorderTasksAction: (orderedIds: string[]) => Promise<void>;
  deleteTaskAction: (formData: FormData) => Promise<void>;
  roleOptions?: AvatarComboboxOption[];
  canManageTaskRoles?: boolean;
  /** Admin viewers may force a rejected drag as an audited operator override. */
  canOperatorOverride?: boolean;
};

// Per Stage 0 sign-off (HOMELAB-44 description): the Backlog column has a
// show/hide toggle, defaults to hidden. Preference persists per project in
// localStorage so each project/workspace board remembers its own state.
const BACKLOG_VISIBLE_KEY_PREFIX = "pm.board.backlogVisible.";

// Workflow Focus mirrors the Backlog toggle: hidden by default, with the
// preference persisted per board so each board remembers its own state.
const FOCUS_VISIBLE_KEY_PREFIX = "pm.board.focusVisible.";

const DONE_VISIBLE_KEY_PREFIX = "pm.board.doneVisible.";

// Backlog rows are full-width while the four workflow columns are
// quarter-width. closestCorners can't disambiguate here: a full-width drag
// rect ties across all four columns (their summed corner-distance is the
// same constant) and the full-width Backlog droppable wins outright because
// it x-aligns with the dragged row. The result was that a backlog→To Do
// drop resolved its `over` back to "Backlog", hit the same-status no-op, and
// snapped the card back. Pointer-based detection targets whatever sits under
// the cursor, which is unambiguous regardless of element width; fall back to
// rectIntersection for the rare pointer frame where the cursor is over a gap.
// Keyboard dragging has no pointer coordinates, so it uses closest-center.
const boardCollisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);
  const pointer = pointerWithin(args);
  return pointer.length > 0 ? pointer : rectIntersection(args);
};

export default function Board({ projectSlug, chromeSlotScope, boardStreamUrl, columns, tasks, moveTaskAction, reorderTasksAction, deleteTaskAction, roleOptions = [], canManageTaskRoles = false, canOperatorOverride = false }: BoardProps) {
  // Card colour context drives which identity cues a card shows:
  //   home  (aggregate landing) → workspace left border + project background
  //   workspace board           → project background only (no border)
  //   project board             → plain (no border, no background)
  const cardScope: CardScope = chromeSlotScope?.startsWith("project-")
    ? "project"
    : chromeSlotScope?.startsWith("workspace-")
      ? "workspace"
      : "home";
  const router = useRouter();
  const resolvedBoardStreamUrl = boardStreamUrl === undefined ? `/api/projects/${projectSlug}/board/stream` : boardStreamUrl;
  const preferenceKey = resolvedBoardStreamUrl ?? projectSlug;
  const legacyPreferenceKey = boardStreamUrl === undefined ? projectSlug : null;
  const isMobileBoard = useIsMobileBoard();
  const [items, setItems] = useState<Task[]>(tasks);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  // A rejected drag an admin may force: re-submitted with the explicit
  // operatorOverride flag only after the ConfirmPopup below is confirmed.
  const [overridePrompt, setOverridePrompt] = useState<
    { taskId: string; status: string; message: string } | null
  >(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [now, setNow] = useState<number | null>(null);
  // Server-render and first client-render both start hidden so React
  // hydration matches; the stored preference (if any) is applied in a
  // post-mount effect, which is a normal state update and not a
  // hydration mismatch.
  const [backlogVisible, setBacklogVisible] = useState(false);
  const [focusVisible, setFocusVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [doneVisible, setDoneVisible] = useState(true);
  const [preferencesScope, setPreferencesScope] = useState<string | null>(null);
  const [chromeTargets, setChromeTargets] = useState<{
    summary: HTMLElement | null;
    controls: HTMLElement | null;
  }>({ summary: null, controls: null });
  const boardSurfaceRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!chromeSlotScope) {
      setChromeTargets({ summary: null, controls: null });
      return;
    }
    setChromeTargets({
      summary: document.getElementById(boardChromeSlotId(chromeSlotScope, "summary")),
      controls: document.getElementById(boardChromeSlotId(chromeSlotScope, "controls")),
    });
  }, [chromeSlotScope]);

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
        if (!resolvedBoardStreamUrl) return;
        source = new EventSource(resolvedBoardStreamUrl);
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
  }, [resolvedBoardStreamUrl, projectSlug, router]);

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
        BACKLOG_VISIBLE_KEY_PREFIX + preferenceKey,
      ) ?? (legacyPreferenceKey ? window.localStorage.getItem(BACKLOG_VISIBLE_KEY_PREFIX + legacyPreferenceKey) : null);
      setBacklogVisible(stored === "true");
      const storedFocus = window.localStorage.getItem(
        FOCUS_VISIBLE_KEY_PREFIX + preferenceKey,
      ) ?? (legacyPreferenceKey ? window.localStorage.getItem(FOCUS_VISIBLE_KEY_PREFIX + legacyPreferenceKey) : null);
      setFocusVisible(storedFocus === "true");
      const storedDone = window.localStorage.getItem(DONE_VISIBLE_KEY_PREFIX + preferenceKey);
      setDoneVisible(storedDone !== "false");
    } catch {
      // localStorage can throw in private modes or sandboxed iframes —
      // fall back to the default (hidden) silently.
      setBacklogVisible(false);
      setFocusVisible(false);
      setDoneVisible(true);
    }
    setPreferencesScope(preferenceKey);
  }, [legacyPreferenceKey, preferenceKey]);

  useEffect(() => {
    if (preferencesScope !== preferenceKey) return;
    try {
      window.localStorage.setItem(
        BACKLOG_VISIBLE_KEY_PREFIX + preferenceKey,
        backlogVisible ? "true" : "false",
      );
    } catch {
      // Same fallback as the read: ignore storage failures.
    }
  }, [backlogVisible, preferenceKey, preferencesScope]);

  useEffect(() => {
    if (preferencesScope !== preferenceKey) return;
    try {
      window.localStorage.setItem(
        FOCUS_VISIBLE_KEY_PREFIX + preferenceKey,
        focusVisible ? "true" : "false",
      );
    } catch {
      // Same fallback as the read: ignore storage failures.
    }
  }, [focusVisible, preferenceKey, preferencesScope]);

  useEffect(() => {
    if (preferencesScope !== preferenceKey) return;
    try {
      window.localStorage.setItem(DONE_VISIBLE_KEY_PREFIX + preferenceKey, doneVisible ? "true" : "false");
    } catch {
      // Preferences are optional; keep the in-memory view if storage is unavailable.
    }
  }, [doneVisible, preferenceKey, preferencesScope]);

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
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
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
      // Done is intentionally newest-first rather than rank-sorted, so a
      // same-lane reorder would persist a rank change that cannot be seen.
      if (task.status === "Done") return;
      reorderWithinColumn(task, over);
    } else {
      crossColumnMove(task, over.status);
    }
  }

  function crossColumnMove(task: Task, newStatus: string, options?: MoveTaskOptions) {
    const previousStatus = task.status;
    const previousStatusChangedAt = task.statusChangedAt;
    const previousRank = task.rank;
    const destinationRank = items
      .filter((item) => item.status === newStatus && item.id !== task.id)
      .reduce((max, item) => Math.max(max, item.rank), -1) + 1;
    setItems((prev) =>
      prev.map((t) => (
        t.id === task.id
          ? { ...t, status: newStatus, rank: destinationRank, statusChangedAt: new Date().toISOString() }
          : t
      )),
    );
    setMoveError(null);
    startTransition(async () => {
      try {
        const result = await moveTaskAction(task.id, newStatus, projectSlug, options);
        if (result.ok) return;
        setItems((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? { ...t, status: previousStatus, rank: previousRank, statusChangedAt: previousStatusChangedAt }
              : t,
          ),
        );
        // A workflow rejection an admin can force: offer the explicit
        // operator-override confirm instead of the plain error banner.
        // Never re-prompt when the override itself was rejected.
        if (canOperatorOverride && !options?.operatorOverride && result.code !== "UNKNOWN_COLUMN") {
          setOverridePrompt({ taskId: task.id, status: newStatus, message: result.message });
          return;
        }
        setMoveError(result.message);
      } catch (error) {
        setItems((prev) =>
          prev.map((t) =>
            t.id === task.id
              ? { ...t, status: previousStatus, rank: previousRank, statusChangedAt: previousStatusChangedAt }
              : t,
          ),
        );
        setMoveError(error instanceof Error ? error.message : "Task could not be moved.");
      }
    });
  }

  function performOperatorOverride() {
    const prompt = overridePrompt;
    setOverridePrompt(null);
    if (!prompt) return;
    const task = items.find((t) => t.id === prompt.taskId);
    if (!task || task.status === prompt.status) return;
    crossColumnMove(task, prompt.status, { operatorOverride: true });
  }

  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);

  function toggleTaskSelection(taskId: string, selected: boolean, shiftKey?: boolean) {
    const task = items.find((t) => t.id === taskId);
    if (!task) return;

    setSelectedIds((current) => {
      const next = new Set(current);

      if (shiftKey && lastCheckedId) {
        const list = task.status === "Backlog"
          ? visibleItems.filter((t) => t.status === "Backlog")
          : visibleItems.filter((t) => t.status === task.status).sort((a, b) => a.rank - b.rank);

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

  function bulkMoveSelected(bulkTarget: string) {
    const movingTasks = items.filter((task) => selectedIds.has(task.id) && task.status !== bulkTarget);
    if (movingTasks.length === 0) return;

    const previousItems = items;
    let nextRank = items
      .filter((task) => task.status === bulkTarget && !selectedIds.has(task.id))
      .reduce((max, task) => Math.max(max, task.rank), -1) + 1;
    const optimisticRankById = new Map<string, number>();
    for (const task of movingTasks) {
      optimisticRankById.set(task.id, nextRank);
      nextRank += 1;
    }
    setItems((prev) =>
      prev.map((task) =>
        optimisticRankById.has(task.id)
          ? { ...task, status: bulkTarget, rank: optimisticRankById.get(task.id)!, statusChangedAt: new Date().toISOString() }
          : task,
      ),
    );
    setMoveError(null);
    startTransition(async () => {
      const succeededIds = new Set<string>();
      const restoreUnmoved = () => {
        const previousById = new Map(previousItems.map((task) => [task.id, task]));
        setItems((current) => current.map((task) => (
          succeededIds.has(task.id) ? task : previousById.get(task.id) ?? task
        )));
      };
      try {
        for (const task of movingTasks) {
          const result = await moveTaskAction(task.id, bulkTarget, projectSlug);
          if (!result.ok) {
            restoreUnmoved();
            setSelectedIds(new Set(movingTasks.filter((item) => !succeededIds.has(item.id)).map((item) => item.id)));
            // Bulk moves intentionally never offer the operator override —
            // forcing the state machine is a one-task-at-a-time decision.
            setMoveError(result.message);
            return;
          }
          succeededIds.add(task.id);
        }
        setSelectedIds(new Set());
      } catch (error) {
        restoreUnmoved();
        setSelectedIds(new Set(movingTasks.filter((item) => !succeededIds.has(item.id)).map((item) => item.id)));
        setMoveError(error instanceof Error ? error.message : "Selected tasks could not be moved.");
      }
    });
  }

  function applyBulkEdit(field: BulkTaskEditField, value: string | null) {
    if (field === "status") {
      if (value) bulkMoveSelected(value);
      return;
    }
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setMoveError(null);
    startTransition(async () => {
      try {
        await bulkUpdateTaskRole(ids, projectSlug, field as BulkTaskRoleField, value);
        setSelectedIds(new Set());
        router.refresh();
      } catch (error) {
        setMoveError(error instanceof Error ? error.message : "Selected tasks could not be updated.");
        router.refresh();
      }
    });
  }

  function bulkDeleteSelected() {
    if (selectedIds.size === 0) return;
    setConfirmDeleteOpen(true);
  }

  function performBulkDelete() {
    const selectedTasks = items.filter((task) => selectedIds.has(task.id));
    if (selectedTasks.length === 0) {
      setConfirmDeleteOpen(false);
      return;
    }
    const previousItems = items;
    setItems((prev) => prev.filter((task) => !selectedIds.has(task.id)));
    setMoveError(null);

    startTransition(async () => {
      const succeededIds = new Set<string>();
      try {
        const idsByProject = new Map<string, string[]>();
        for (const task of selectedTasks) {
          const slug = taskProjectSlug(task, projectSlug);
          idsByProject.set(slug, [...(idsByProject.get(slug) ?? []), task.id]);
        }
        for (const [slug, ids] of idsByProject) {
          await bulkBinTasks(ids, slug);
          ids.forEach((id) => succeededIds.add(id));
        }
        setSelectedIds(new Set());
        setConfirmDeleteOpen(false);
      } catch (err) {
        setItems(previousItems.filter((task) => !succeededIds.has(task.id)));
        setSelectedIds((current) => new Set([...current].filter((id) => !succeededIds.has(id))));
        setMoveError((err as Error).message);
        setConfirmDeleteOpen(false);
      }
    });
  }

  function performSingleDelete() {
    const target = deleteTarget;
    if (!target) return;
    const previousItems = items;
    const wasSelected = selectedIds.has(target.id);
    setItems((current) => current.filter((task) => task.id !== target.id));
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(target.id);
      return next;
    });
    setDeleteTarget(null);
    setMoveError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("projectSlug", taskProjectSlug(target, projectSlug));
      formData.set("taskId", target.id);
      try {
        await deleteTaskAction(formData);
      } catch (error) {
        setItems(previousItems);
        if (wasSelected) {
          setSelectedIds((current) => new Set(current).add(target.id));
        }
        setMoveError(error instanceof Error ? error.message : "Task could not be moved to the bin.");
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
    const colTasks = visibleItems.filter((t) => t.status === columnId);
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
    const previousRankByTask = new Map(colTasks.map((task) => [task.id, task.rank]));
    setItems((prev) =>
      prev.map((t) =>
        rankByTask.has(t.id) ? { ...t, rank: rankByTask.get(t.id)! } : t,
      ),
    );
    startTransition(async () => {
      try {
        await reorderTasksAction(reordered.map((t) => t.id));
      } catch (error) {
        setItems((current) => current.map((task) => (
          previousRankByTask.has(task.id)
            ? { ...task, rank: previousRankByTask.get(task.id)! }
            : task
        )));
        setMoveError(error instanceof Error ? error.message : "Task order could not be saved.");
      }
    });
  }

  const active = items.find((t) => t.id === activeId);

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleItems = useMemo(
    () => items.filter((task) => {
      if (!doneVisible && task.status === "Done") return false;
      if (attentionOnly && !taskNeedsAttention(task)) return false;
      if (!normalizedQuery) return true;
      const actors = [task.assignee, task.reviewer, task.manager, task.reporter]
        .filter((actor): actor is BoardActor => Boolean(actor))
        .map((actor) => actorDisplayName(actor));
      return [
        task.workItemKey,
        task.title,
        task.epicTitle,
        task.project?.name,
        task.project?.slug,
        task.project?.workspace?.name,
        task.project?.workspace?.slug,
        ...actors,
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
    }),
    [attentionOnly, doneVisible, items, normalizedQuery],
  );
  const boardStats = useMemo(() => {
    const byStatus = Object.fromEntries(columns.map((column) => [column.id, 0])) as Record<string, number>;
    let blocked = 0;
    let attention = 0;
    for (const task of items) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
      if (task.blockedByKey || task.hasActiveBlocker) blocked += 1;
      if (taskNeedsAttention(task)) attention += 1;
    }
    const done = byStatus.Done ?? 0;
    const total = items.length;
    return {
      total,
      open: total - done,
      done,
      blocked,
      attention,
      completion: total > 0 ? Math.round((done / total) * 100) : 0,
      byStatus,
    };
  }, [columns, items]);
  const filtersActive = Boolean(normalizedQuery || attentionOnly || !doneVisible);

  // Backlog is no longer a board column: it renders immediately before the
  // four workflow columns as its own task grid
  // (HOMELAB-41). Drag-and-drop still works across both because the move
  // logic keys off task status / droppable id, not layout.
  const workflowColumns = useMemo(
    () => columns.filter((c) => c.id !== "Backlog"),
    [columns],
  );
  const backlogTasks = useMemo(
    () =>
      visibleItems
        .filter((t) => t.status === "Backlog")
        .sort((a, b) => a.rank - b.rank),
    [visibleItems],
  );
  const backlogCount = backlogTasks.length;
  const selectedCount = selectedIds.size;
  const hiddenSelectedCount = selectedCount - visibleItems.filter((task) => selectedIds.has(task.id)).length;

  const columnLanes = useMemo(
    () =>
      workflowColumns.map((col) => ({
        col,
        tasks: visibleItems
          .filter((t) => t.status === col.id)
          .sort((a, b) => {
            if (col.id === "Done") {
              return completedAtMs(b) - completedAtMs(a) || b.rank - a.rank;
            }
            return a.rank - b.rank;
          }),
        })),
    [workflowColumns, visibleItems],
  );
  const workflowFocus = useMemo(() => {
    const priority: Record<string, number> = {
      Review: 0,
      "To Do": 1,
      "In Progress": 2,
      Backlog: 3,
    };
    return visibleItems
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
  }, [visibleItems]);
  // While the Workflow Focus block is visible the board narrows to the two
  // active lanes: To Do and Done are hidden (Backlog keeps its own toggle but
  // stays hidden too). Toggling focus off restores every column.
  const focusActive = focusVisible && workflowFocus.length > 0;
  const visibleColumnLanes = focusActive
    ? columnLanes.filter(({ col }) => col.id === "In Progress" || col.id === "Review")
    : columnLanes.filter(({ col }) => doneVisible || col.id !== "Done");
  const mobileBacklogLane = useMemo(
    () => ({ col: { id: "Backlog", label: "Backlog", description: "planning/opinions" }, tasks: backlogTasks }),
    [backlogTasks],
  );
  const mobileLanes = focusActive
    ? visibleColumnLanes
    : backlogVisible
      ? [mobileBacklogLane, ...columnLanes]
      : columnLanes;

  // Keep the desktop board surface inside the currently visible viewport. Its
  // starting position changes as the title/summary scroll away, the tabs
  // become sticky, or transient filter/selection/focus rows appear. Measuring
  // that real position avoids a brittle fixed header-height subtraction while
  // writing the result to shared layout variables keeps scroll updates out of
  // React and aligns an open task pane to the same sticky floor.
  useLayoutEffect(() => {
    const boardSurface = boardSurfaceRef.current;
    if (!boardSurface || isMobileBoard) return;

    let frame = 0;
    let active = true;
    const boardLayout = boardSurface.closest("[data-board-layout]") as HTMLElement | null;
    const controlsTarget = chromeSlotScope
      ? document.getElementById(boardChromeSlotId(chromeSlotScope, "controls"))
      : null;
    const toolbar = (controlsTarget?.closest("[data-board-toolbar]") ??
      boardLayout?.querySelector("[data-board-toolbar]")) as HTMLElement | null;
    const selectionToolbar = boardLayout?.querySelector("[data-board-selection-toolbar]") as HTMLElement | null;

    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (!active) return;
        const viewportHeight = window.innerHeight;
        const bottomGap = 16;
        const toolbarRect = toolbar?.getBoundingClientRect();
        const toolbarMargin = toolbar
          ? Number.parseFloat(window.getComputedStyle(toolbar).marginBottom) || 0
          : 0;
        const selectionRect = selectionToolbar?.getBoundingClientRect();
        const selectionStyles = selectionToolbar
          ? window.getComputedStyle(selectionToolbar)
          : null;
        const obstructionStickyTop = selectionStyles
          ? Number.parseFloat(selectionStyles.top) || 0
          : 0;
        const obstructionHeight = selectionRect?.height ?? 0;
        const obstructionMargin = selectionStyles
          ? Number.parseFloat(selectionStyles.marginBottom) || 0
          : 0;
        const stickyTop = boardStickyTop({
          toolbarHeight: toolbarRect?.height ?? 0,
          toolbarMargin,
          obstructionStickyTop,
          obstructionHeight,
          obstructionMargin,
        });
        const available = boardAvailableHeight({
          viewportHeight,
          columnsTop: boardSurface.getBoundingClientRect().top,
          toolbarHeight: toolbarRect?.height ?? 0,
          toolbarBottom: toolbarRect?.bottom ?? 0,
          toolbarMargin,
          obstructionStickyTop,
          obstructionHeight,
          obstructionBottom: selectionRect?.bottom ?? 0,
          obstructionMargin,
          bottomGap,
        });
        const nextHeight = `${available}px`;
        const nextTop = `${stickyTop}px`;
        if (boardLayout?.style.getPropertyValue("--board-available-height") !== nextHeight) {
          boardLayout?.style.setProperty("--board-available-height", nextHeight);
        }
        if (boardLayout?.style.getPropertyValue("--board-sticky-top") !== nextTop) {
          boardLayout?.style.setProperty("--board-sticky-top", nextTop);
        }
      });
    };

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    const sizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(measure)
      : null;
    if (toolbar && sizeObserver) sizeObserver.observe(toolbar);
    if (selectionToolbar && sizeObserver) sizeObserver.observe(selectionToolbar);
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });

    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
      sizeObserver?.disconnect();
      boardLayout?.style.removeProperty("--board-available-height");
      boardLayout?.style.removeProperty("--board-sticky-top");
    };
  }, [
    chromeSlotScope,
    filtersActive,
    focusActive,
    hiddenSelectedCount,
    isMobileBoard,
    items,
    moveError,
    searchQuery,
    selectedCount,
    workflowFocus,
  ]);

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
      onDragCancel={() => setActiveId(null)}
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
      <ConfirmPopup
        open={Boolean(deleteTarget)}
        title="Move task to bin"
        description={deleteTarget ? `Move “${deleteTarget.title}” to the bin? You can restore it before the bin TTL elapses.` : ""}
        confirmLabel="Move to bin"
        danger
        busy={isPending}
        onConfirm={performSingleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
      <ConfirmPopup
        open={Boolean(overridePrompt)}
        title="Move blocked"
        description={overridePrompt
          ? `Move blocked: ${overridePrompt.message} Force as operator override? The forced move skips workflow gates and automation and is recorded in the workflow history.`
          : ""}
        confirmLabel="Force move"
        danger
        busy={isPending}
        onConfirm={performOperatorOverride}
        onCancel={() => setOverridePrompt(null)}
      />
      {chromeTargets.controls
        ? createPortal(
            <BoardControls
              placement="toolbar"
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              attentionOnly={attentionOnly}
              onToggleAttention={() => setAttentionOnly((value) => !value)}
              doneVisible={doneVisible}
              onToggleDone={() => setDoneVisible((value) => !value)}
              focusVisible={focusVisible}
              showFocus={workflowFocus.length > 0}
              focusCount={workflowFocus.length}
              onToggleFocus={() => setFocusVisible((value) => !value)}
              backlogVisible={backlogVisible}
              backlogCount={boardStats.byStatus.Backlog ?? 0}
              onToggleBacklog={() => setBacklogVisible((value) => !value)}
              filtersActive={filtersActive}
              onReset={() => {
                setSearchQuery("");
                setAttentionOnly(false);
                setDoneVisible(true);
              }}
              boardStats={boardStats}
            />,
            chromeTargets.controls,
          )
        : null}
      {moveError ? (
        <div
          role="alert"
          className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-crit/40 bg-crit/[0.07] px-4 py-3 text-body text-crit shadow-[var(--shadow-xs)]"
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

      {/* Below xl the controls live in this stacked card; at xl+ they portal
          into the top toolbar (with the tabs) and this card is hidden. */}
      <section className="mb-5 overflow-hidden rounded-2xl border border-line bg-panel/95 shadow-[var(--shadow-sm)] backdrop-blur xl:hidden">
        <BoardControls
          placement="stacked"
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          attentionOnly={attentionOnly}
          onToggleAttention={() => setAttentionOnly((value) => !value)}
          doneVisible={doneVisible}
          onToggleDone={() => setDoneVisible((value) => !value)}
          focusVisible={focusVisible}
          showFocus={workflowFocus.length > 0}
          focusCount={workflowFocus.length}
          onToggleFocus={() => setFocusVisible((value) => !value)}
          backlogVisible={backlogVisible}
          backlogCount={boardStats.byStatus.Backlog ?? 0}
          onToggleBacklog={() => setBacklogVisible((value) => !value)}
          filtersActive={filtersActive}
          onReset={() => {
            setSearchQuery("");
            setAttentionOnly(false);
            setDoneVisible(true);
          }}
          boardStats={boardStats}
        />
        {filtersActive ? (
          <BoardFilterStatus
            visibleCount={visibleItems.length}
            totalCount={items.length}
            backlogVisible={backlogVisible}
            backlogCount={backlogCount}
            onShowBacklog={() => setBacklogVisible(true)}
          />
        ) : null}
      </section>

      {filtersActive ? (
        <div className="mb-4 hidden rounded-xl border border-line bg-panel/90 shadow-[var(--shadow-xs)] xl:block">
          <BoardFilterStatus
            visibleCount={visibleItems.length}
            totalCount={items.length}
            backlogVisible={backlogVisible}
            backlogCount={backlogCount}
            onShowBacklog={() => setBacklogVisible(true)}
          />
        </div>
      ) : null}

      {selectedCount > 0 ? (
        <div
          data-board-selection-toolbar
          className="sticky top-16 z-20 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-panel border border-accent/30 bg-panel/95 px-4 py-3 text-body shadow-[var(--shadow-md)] backdrop-blur"
        >
          <span className="font-semibold text-text">
            {selectedCount} selected
            {hiddenSelectedCount > 0 ? (
              <span className="ml-2 text-caption font-medium text-text-muted">({hiddenSelectedCount} hidden by filters)</span>
            ) : null}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <TaskBulkEditControls
              statusOptions={columns.map((column) => ({ value: column.id, label: column.label }))}
              roleOptions={roleOptions}
              canManageRoles={canManageTaskRoles}
              disabled={isPending}
              onApply={applyBulkEdit}
            />
            <button
              type="button"
              onClick={bulkDeleteSelected}
              disabled={isPending}
              className="rounded-lg border border-crit bg-transparent px-control-x py-control-y text-caption font-semibold text-crit transition hover:bg-crit hover:text-on-crit disabled:cursor-wait disabled:opacity-50"
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

      {focusActive ? (
        <section className="mb-5 rounded-2xl border border-accent/20 bg-accent/[0.045] p-3 shadow-[var(--shadow-xs)]">
          <div className="mb-3 flex items-center justify-between gap-3 px-1">
            <div>
              <h2 className="flex items-center gap-2 text-body font-semibold text-text">
                <span className="text-accent"><FocusIcon /></span>
                Workflow focus
              </h2>
              <p className="mt-0.5 text-caption text-text-muted">Work that needs a decision, review, or next action.</p>
            </div>
            <button
              type="button"
              onClick={() => setFocusVisible(false)}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-panel hover:text-text"
              aria-label="Hide workflow focus"
            >
              ×
            </button>
          </div>
          {/* Wide bands key off the board container (@container/board in the
              project layout), not the viewport: the sidebar, main padding,
              split-workspace pane, and 5xl command-deck rail all consume
              width first. auto-fill keeps every track >=284px; the fixed
              six-column grid only engages once the container fits six
              284px tracks plus gaps (6*284 + 5*8 = 1744px = 109rem). */}
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4 @min-[75rem]/board:grid-cols-[repeat(auto-fill,minmax(284px,1fr))] @min-[109rem]/board:grid-cols-6">
            {workflowFocus.map((task) => (
              <WorkflowFocusCard
                key={task.id}
                task={task}
                projectSlug={projectSlug}
                now={now}
                cardScope={cardScope}
              />
            ))}
          </div>
        </section>
      ) : null}

      <div className="contents md:flex md:flex-col">
      {isMobileBoard ? (
        <div className="space-y-3 md:hidden">
          <div className="rounded-card border border-line bg-panel-soft px-3 py-2 text-caption text-text-muted">
            Drag with the grip to reorder. Swipe a card left for quick Move/Edit actions.
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
                totalCount={boardStats.byStatus[col.id] ?? 0}
                filtered={filtersActive}
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
                      onDeleteRequest={() => setDeleteTarget(t)}
                      now={now}
                      selected={selectedIds.has(t.id)}
                      onSelectionChange={toggleTaskSelection}
                      onMove={(task, status) => crossColumnMove(task, status)}
                      nextStatus={nextMobileStatus(t.status, columns)}
                      cardScope={cardScope}
                    />
                  ))}
                </SortableContext>
              </MobileStatusGroup>
            );
          })}
        </div>
      ) : (
        <div
          data-board-sticky-track
          className="4xl:min-h-[calc(100dvh-var(--board-sticky-top))]"
        >
          {/* Backlog before board in ultra-wide */}
          {backlogVisible && !focusActive ? (
            <section className="mb-5 hidden rounded-2xl border border-line bg-panel/95 shadow-[var(--shadow-sm)] backdrop-blur 4xl:block 4xl:mb-3 4xl:max-h-[35%] 4xl:overflow-hidden">
              <div className="flex items-center justify-between gap-3 border-b border-line bg-panel-soft/70 px-4 py-2">
                <h2 className="flex items-center gap-2 text-subheading font-semibold text-text">
                  Backlog
                  <span className="rounded-full border border-line bg-panel px-2 py-0.5 text-caption font-semibold tabular-nums text-text-muted">
                    {backlogCount}
                  </span>
                </h2>
                <button
                  type="button"
                  onClick={() => setBacklogVisible(false)}
                  className="rounded-lg border border-line bg-panel px-3 py-1.5 text-caption font-semibold text-text-muted shadow-[var(--shadow-xs)] hover:border-line-strong hover:text-text"
                >
                  Collapse backlog
                </button>
              </div>
              <div className="overflow-x-auto">
                <div className="sticky top-0 z-10 grid min-w-[68rem] grid-cols-[minmax(14rem,1fr)_10rem_10rem_10rem_7rem_6rem_6rem_2rem] items-center gap-3 border-b border-line bg-panel-soft px-3 py-2.5 text-caption font-semibold text-text-muted">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={backlogCount > 0 && backlogTasks.every((task) => selectedIds.has(task.id))}
                      onChange={(event) => toggleSelectAllBacklog(event.target.checked)}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      className="h-6 w-6 accent-accent md:h-4 md:w-4"
                      aria-label="Select all backlog tasks"
                    />
                    <span>Task</span>
                  </div>
                  <span>Epic</span>
                  <span>Assignee</span>
                  <span>Reviewer</span>
                  <span className="text-right">Elapsed</span>
                  <span className="text-right">Created</span>
                  <span className="text-right">Updated</span>
                  <span className="sr-only">Actions</span>
                </div>
                <div className="max-h-[320px] overflow-y-auto">
                  <SortableContext items={backlogTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                    {backlogTasks.map((task) => (
                      <BacklogRow
                        key={task.id}
                        task={task}
                        projectSlug={projectSlug}
                        onDeleteRequest={() => setDeleteTarget(task)}
                        selected={selectedIds.has(task.id)}
                        onSelectionChange={toggleTaskSelection}
                        now={now}
                        cardScope={cardScope}
                      />
                    ))}
                  </SortableContext>
                </div>
              </div>
            </section>
          ) : null}
          <div
            ref={boardSurfaceRef}
            data-board-surface
            className="-mx-4 hidden min-h-0 overflow-x-auto px-4 pb-3 sm:-mx-page-x sm:px-page-x md:block lg:-mx-page-x-lg lg:px-page-x-lg xl:mx-0 xl:px-0 4xl:sticky 4xl:top-[var(--board-sticky-top)] 4xl:h-[var(--board-available-height)] 4xl:max-h-[var(--board-available-height)]"
          >
            <div
              data-board-columns
              className={`grid gap-3 4xl:h-full 4xl:min-h-0 ${focusActive ? "min-w-[34rem] grid-cols-2" : doneVisible ? "min-w-[68rem] grid-cols-4" : "min-w-[51rem] grid-cols-3"}`}
            >
              {visibleColumnLanes.map(({ col, tasks: colTasks }) => {
                const colTaskIds = colTasks.map((t) => t.id);
                const allSelected = colTaskIds.length > 0 && colTaskIds.every((id) => selectedIds.has(id));
                return (
                  <ColumnDroppable
                    key={col.id}
                    id={col.id}
                    label={col.label}
                    description={col.description}
                    count={colTasks.length}
                    totalCount={boardStats.byStatus[col.id] ?? 0}
                    filtered={filtersActive}
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
                          onDeleteRequest={() => setDeleteTarget(t)}
                          now={now}
                          selected={selectedIds.has(t.id)}
                          onSelectionChange={toggleTaskSelection}
                          cardScope={cardScope}
                        />
                      ))}
                    </SortableContext>
                  </ColumnDroppable>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Backlog is ordered before the board on non-ultra-wide desktop. */}
      {backlogVisible && !isMobileBoard && !focusActive ? (
        <section className="mb-5 hidden md:order-first md:block 4xl:hidden">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-subheading font-semibold text-text">
                Backlog
                <span className="rounded-full border border-line bg-panel px-2 py-0.5 text-caption font-semibold tabular-nums text-text-muted">
                  {backlogCount}
                </span>
              </h2>
              <p className="mt-0.5 text-caption text-text-muted">Planning, ideas, and work awaiting approval.</p>
            </div>
            <button
              type="button"
              onClick={() => setBacklogVisible(false)}
              className="rounded-lg border border-line bg-panel px-3 py-1.5 text-caption font-semibold text-text-muted shadow-[var(--shadow-xs)] hover:border-line-strong hover:text-text"
            >
              Collapse backlog
            </button>
          </div>
          <BacklogDroppable>
            {backlogTasks.length === 0 ? (
              <BoardEmptyState title={filtersActive ? "No backlog tasks match" : "Backlog is empty"} detail={filtersActive ? "Try clearing a filter or changing your search." : "New tasks will appear here until they are approved."} />
            ) : (
              <div className="overflow-x-auto">
                <div className="sticky top-0 z-10 grid min-w-[68rem] grid-cols-[minmax(14rem,1fr)_10rem_10rem_10rem_7rem_6rem_6rem_2rem] items-center gap-3 border-b border-line bg-panel-soft px-3 py-2.5 text-caption font-semibold text-text-muted">
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={backlogCount > 0 && backlogTasks.every((task) => selectedIds.has(task.id))}
                      onChange={(event) => toggleSelectAllBacklog(event.target.checked)}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      className="h-6 w-6 accent-accent md:h-4 md:w-4"
                      aria-label="Select all backlog tasks"
                    />
                    <span>Task</span>
                  </div>
                  <span>Epic</span>
                  <span>Assignee</span>
                  <span>Reviewer</span>
                  <span className="text-right">Elapsed</span>
                  <span className="text-right">Created</span>
                  <span className="text-right">Updated</span>
                  <span className="sr-only">Actions</span>
                </div>
                <div className="max-h-[780px] overflow-y-auto">
                  <SortableContext items={backlogTasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
                    {backlogTasks.map((task) => (
                      <BacklogRow
                        key={task.id}
                        task={task}
                        projectSlug={projectSlug}
                        onDeleteRequest={() => setDeleteTarget(task)}
                        selected={selectedIds.has(task.id)}
                        onSelectionChange={toggleTaskSelection}
                        now={now}
                        cardScope={cardScope}
                      />
                    ))}
                  </SortableContext>
                </div>
              </div>
            )}
          </BacklogDroppable>
        </section>
      ) : null}
      </div>

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

function BoardSummary({
  boardStats,
  placement,
}: {
  boardStats: BoardStats;
  placement: "header" | "stacked";
}) {
  const summary = (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-subheading font-semibold tracking-tight text-text">Workflow board</h2>
        <span className="rounded-full border border-line bg-panel-soft px-2 py-0.5 text-caption font-semibold tabular-nums text-text-muted">
          {boardStats.open} open
        </span>
        {boardStats.blocked > 0 ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-crit/30 bg-crit/[0.07] px-2 py-0.5 text-caption font-semibold text-crit">
            <LockGlyph /> {boardStats.blocked} blocked
          </span>
        ) : null}
      </div>
      <div className={`mt-2 flex items-center gap-3 ${placement === "header" ? "max-w-2xl" : "max-w-xl"}`}>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-elev" aria-hidden="true">
          <div
            className="h-full rounded-full bg-gradient-to-r from-accent to-ok transition-[width]"
            style={{ width: `${boardStats.completion}%` }}
          />
        </div>
        <span
          className="shrink-0 text-caption font-medium tabular-nums text-text-muted"
          title="Completion among the tasks currently loaded on this board"
        >
          {boardStats.completion}% current board
        </span>
      </div>
    </div>
  );
  const metrics = (
    <div className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-xl border border-line bg-panel-soft">
      <BoardMetric label="To do" value={boardStats.byStatus["To Do"] ?? 0} tone="todo" />
      <BoardMetric label="Doing" value={boardStats.byStatus["In Progress"] ?? 0} tone="progress" />
      <BoardMetric label="Review" value={boardStats.byStatus.Review ?? 0} tone="review" />
    </div>
  );

  if (placement === "header") {
    return (
      <section
        data-board-summary
        aria-label="Workflow board summary"
        className="grid w-full min-w-0 grid-cols-[minmax(24rem,1fr)_auto] items-center gap-8"
      >
        {summary}
        {metrics}
      </section>
    );
  }

  return (
    <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(15rem,1fr)_auto] lg:items-center lg:px-5">
      {summary}
      {metrics}
    </div>
  );
}

function BoardControls({
  placement,
  searchQuery,
  onSearchChange,
  attentionOnly,
  onToggleAttention,
  doneVisible,
  onToggleDone,
  focusVisible,
  showFocus,
  focusCount,
  onToggleFocus,
  backlogVisible,
  backlogCount,
  onToggleBacklog,
  filtersActive,
  onReset,
  boardStats,
}: {
  placement: "toolbar" | "stacked";
  searchQuery: string;
  onSearchChange: (value: string) => void;
  attentionOnly: boolean;
  onToggleAttention: () => void;
  doneVisible: boolean;
  onToggleDone: () => void;
  focusVisible: boolean;
  showFocus: boolean;
  focusCount: number;
  onToggleFocus: () => void;
  backlogVisible: boolean;
  backlogCount: number;
  onToggleBacklog: () => void;
  filtersActive: boolean;
  onReset: () => void;
  boardStats: BoardStats;
}) {
  const toolbar = placement === "toolbar";
  return (
    <div
      data-board-controls
      className={toolbar
        ? "flex min-w-0 flex-1 items-center justify-end gap-2"
        : "flex flex-col gap-3 border-t border-line bg-panel-soft/70 px-3 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-4"}
    >
      <div className={toolbar ? "relative w-[clamp(6rem,8vw,8rem)] shrink-0" : "relative block min-w-0 flex-1 lg:max-w-md"}>
        <span className="pointer-events-none absolute inset-y-0 left-3 grid place-items-center text-text-dim">
          <SearchIcon />
        </span>
        <input
          type="text"
          role="searchbox"
          aria-label="Search board"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Search key, task, epic, project or person…"
          className="min-h-11 w-full rounded-lg border border-line bg-panel py-2 pl-9 pr-10 text-body text-text shadow-[var(--shadow-xs)] outline-none transition focus:border-accent focus:shadow-[var(--focus-ring)] md:min-h-0"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            aria-label="Clear board search"
            className="absolute inset-y-0 right-1 grid w-9 place-items-center rounded-md text-text-muted hover:bg-accent-soft hover:text-accent"
          >
            ×
          </button>
        ) : null}
      </div>

      <div className={`flex min-w-0 items-center gap-2 ${toolbar ? "shrink-0" : "flex-wrap"}`}>
        <BoardToggle
          active={attentionOnly}
          onClick={onToggleAttention}
          label="Attention"
          count={boardStats.attention}
          icon={<SparkIcon />}
        />
        <BoardToggle
          active={!doneVisible}
          onClick={onToggleDone}
          label={doneVisible ? "Hide Done" : "Done Hidden"}
          count={boardStats.done}
          icon={<EyeIcon crossed={!doneVisible} />}
        />
        {showFocus ? (
          <BoardToggle
            active={focusVisible}
            onClick={onToggleFocus}
            label="Focus"
            count={focusCount}
            icon={<FocusIcon />}
          />
        ) : null}
        <BoardToggle
          active={backlogVisible}
          onClick={onToggleBacklog}
          label="Backlog"
          count={backlogCount}
          icon={<BacklogIcon />}
        />
        {filtersActive ? (
          <button
            type="button"
            onClick={onReset}
            className="min-h-11 rounded-lg px-2.5 py-2 text-caption font-semibold text-accent hover:bg-accent-soft md:min-h-0"
          >
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

function BoardFilterStatus({
  visibleCount,
  totalCount,
  backlogVisible,
  backlogCount,
  onShowBacklog,
}: {
  visibleCount: number;
  totalCount: number;
  backlogVisible: boolean;
  backlogCount: number;
  onShowBacklog: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-caption text-text-muted" role="status">
      <span>Showing <span className="font-semibold text-text">{visibleCount}</span> of {totalCount} tasks</span>
      {!backlogVisible && backlogCount > 0 ? (
        <button type="button" onClick={onShowBacklog} className="font-semibold text-accent hover:underline">
          {backlogCount} matching {backlogCount === 1 ? "task is" : "tasks are"} in the collapsed Backlog · Show
        </button>
      ) : null}
    </div>
  );
}

function BoardMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "todo" | "progress" | "review";
}) {
  const color = tone === "todo"
    ? "var(--status-todo)"
    : tone === "progress"
      ? "var(--status-progress)"
      : "var(--status-review)";
  return (
    <div className="flex min-w-[5.5rem] items-center gap-2 px-3 py-2.5">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-heading font-semibold leading-none tabular-nums text-text">{value}</span>
        <span className="mt-1 block text-micro font-medium text-text-muted">{label}</span>
      </span>
    </div>
  );
}

function BoardToggle({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 py-2 text-caption font-semibold shadow-[var(--shadow-xs)] transition-[background-color,border-color,color,box-shadow] md:min-h-0 ${
        active
          ? "border-accent/35 bg-accent-soft text-accent shadow-[var(--focus-ring)]"
          : "border-line bg-panel text-text-muted hover:border-line-strong hover:text-text"
      }`}
    >
      {icon}
      <span>{label}</span>
      {count != null ? (
        <span className={`rounded-full px-1.5 py-0.5 text-micro tabular-nums ${active ? "bg-panel/70" : "bg-bg-elev"}`}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

function BoardEmptyState({
  title,
  detail,
  compact = false,
}: {
  title: string;
  detail: string;
  compact?: boolean;
}) {
  return (
    <div className={`grid place-items-center rounded-xl border border-dashed border-line-strong/70 bg-panel/40 px-4 text-center ${compact ? "min-h-28 py-4" : "min-h-36 py-6"}`}>
      <div>
        <span className="mx-auto mb-2 grid h-8 w-8 place-items-center rounded-full bg-bg-elev text-text-dim" aria-hidden="true">
          <BacklogIcon />
        </span>
        <p className="text-caption font-semibold text-text">{title}</p>
        <p className="mt-1 text-micro leading-relaxed text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

function SparkIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3-1.6 4.2a5 5 0 0 1-3.1 3.1L3 12l4.3 1.7a5 5 0 0 1 3.1 3.1L12 21l1.6-4.2a5 5 0 0 1 3.1-3.1L21 12l-4.3-1.7a5 5 0 0 1-3.1-3.1L12 3Z" />
    </svg>
  );
}

function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
      {crossed ? <path d="m4 4 16 16" /> : null}
    </svg>
  );
}

function FocusIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function BacklogIcon() {
  return (
    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="3.5" cy="6" r=".5" fill="currentColor" />
      <circle cx="3.5" cy="12" r=".5" fill="currentColor" />
      <circle cx="3.5" cy="18" r=".5" fill="currentColor" />
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" />
    </svg>
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
  totalCount,
  filtered,
  allSelected,
  onSelectAll,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  count: number;
  totalCount: number;
  filtered: boolean;
  allSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <details
      ref={setNodeRef}
      open
      data-over={isOver ? "true" : "false"}
      style={{ "--board-status": boardStatusColor(id) } as React.CSSProperties}
      className="board-lane relative overflow-hidden rounded-xl border pt-1 transition-[background-color,border-color,box-shadow]"
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
          <span
            style={{ "--board-status": boardStatusColor(id) } as React.CSSProperties}
            className="board-status-pill rounded-md border px-2 py-1 text-caption font-semibold"
          >
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
      <div className="space-y-2 px-2 pb-3">
        {children}
        {count === 0 ? (
          <BoardEmptyState
            title={filtered && totalCount > 0 ? `${totalCount} ${totalCount === 1 ? "card" : "cards"} hidden` : filtered ? "No matching tasks" : "No tasks here"}
            detail={filtered ? "Change or reset the board filters to see more." : "Drop a task into this lane."}
            compact
          />
        ) : null}
      </div>
    </details>
  );
}

function MobileTaskCard({
  task,
  projectSlug,
  onDeleteRequest,
  now,
  selected,
  onSelectionChange,
  onMove,
  nextStatus,
  cardScope,
}: {
  task: Task;
  projectSlug: string;
  onDeleteRequest: () => void;
  now: number | null;
  selected: boolean;
  onSelectionChange: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
  onMove: (task: Task, status: string) => void;
  nextStatus: string;
  cardScope: CardScope;
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
  const nextLabel = nextStatus === task.status ? "Move" : `Move → ${nextStatus}`;

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        "--board-status": boardStatusColor(task.status),
      } as React.CSSProperties}
      className={`scrollbar-none overflow-x-auto rounded-lg ${isDragging ? "opacity-30" : ""}`}
    >
      <div className="flex min-w-[calc(100%+9rem)] items-stretch">
        <div
          data-board-card-mobile
          data-selected={selected ? "true" : "false"}
          className={`${taskCardClass(task, false, false, cardScope)} min-w-[calc(100%-9rem)] touch-auto`}
          style={taskCardStyle(task, cardScope)}
          title={waitingOnHumanReview(task) ? HUMAN_REVIEW_LABEL : undefined}
        >
          <BoardCardBody
            task={task}
            projectSlug={projectSlug}
            now={now}
            selected={selected}
            onSelectionChange={onSelectionChange}
            onDeleteRequest={onDeleteRequest}
            dragAttributes={attributes}
            dragListeners={listeners}
          />
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
            onClick={() => router.push(taskHref(task, projectSlug))}
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
  totalCount,
  filtered,
  allSelected = false,
  onSelectAll,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  count: number;
  totalCount: number;
  filtered: boolean;
  allSelected?: boolean;
  onSelectAll?: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-board-lane
      data-over={isOver ? "true" : "false"}
      style={{ "--board-status": boardStatusColor(id) } as React.CSSProperties}
      className="board-lane relative flex min-h-[30rem] flex-col rounded-xl border p-2 pt-3 transition-[background-color,border-color,box-shadow] 4xl:h-full 4xl:min-h-0 4xl:overflow-hidden"
    >
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2 rounded-lg bg-panel/75 px-2 py-2 shadow-[var(--shadow-xs)] backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          {onSelectAll && (
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => onSelectAll(e.target.checked)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className="h-4 w-4 shrink-0 accent-accent"
              aria-label={`Select all in ${label}`}
            />
          )}
          <span
            style={{ "--board-status": boardStatusColor(id) } as React.CSSProperties}
            className="board-status-pill w-fit rounded-md border px-2 py-1 text-caption font-semibold"
          >
            {label}
          </span>
          {description ? (
            <span className="hidden truncate text-caption text-text-muted xl:inline">
              {description}
            </span>
          ) : null}
        </div>
        <span className="grid h-6 min-w-6 shrink-0 place-items-center rounded-full border border-line bg-panel px-1.5 text-caption font-semibold tabular-nums text-text-muted">
          {count}
        </span>
      </div>
      <div
        data-board-lane-scroll
        className="min-h-0 flex-1 space-y-2.5 overflow-x-hidden pr-1 4xl:overflow-y-auto 4xl:overscroll-contain"
      >
        {children}
        {count === 0 ? (
          <BoardEmptyState
            title={filtered && totalCount > 0 ? `${totalCount} ${totalCount === 1 ? "card" : "cards"} hidden` : filtered ? "No matching tasks" : "No tasks here"}
            detail={filtered ? "Change or reset the board filters to see more." : "Drop a task into this lane."}
            compact
          />
        ) : null}
      </div>
    </div>
  );
}

// Every board card on every surface renders through this one body: the
// desktop lanes, and the mobile swipe list. The layout is a fixed two-column
// grid — a 42px identity rail and the task content beside it. Rows are placed
// explicitly, so a card with no scope line and no epic collapses those tracks
// without shifting the rail.
//
//   [x]      ENV-12  12h  3m  BLOCKED-BY              [::]
//   (av)     Task title
//   (rev)    workspace / project · epic name
//   [!]      ▬▬▬▬▭▭ 66% · 2/3                        [bin]
//
// Scope line visibility is data-driven and needs no extra prop: a project
// board serialises `project: null` (no scope line at all), a workspace board
// serialises the project without its workspace (project slug only), and the
// /workspaces landing board serialises both.
function BoardCardBody({
  task,
  projectSlug,
  now,
  selected,
  onSelectionChange,
  onDeleteRequest,
  dragAttributes,
  dragListeners,
}: {
  task: Task;
  projectSlug: string;
  now: number | null;
  selected: boolean;
  onSelectionChange: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
  onDeleteRequest: () => void;
  dragAttributes: React.HTMLAttributes<HTMLButtonElement>;
  dragListeners: Record<string, unknown> | undefined;
}) {
  const actor = boardActorForTask(task);
  const presence = useAgentPresenceMap();
  const avatarPulse = boardAvatarPulse(task, actor, presence);
  // Done is the only column that credits a reviewer, resolved through the
  // same chain the task detail uses: task reviewer, then the epic's acting
  // manager, then the reporter.
  const reviewer =
    task.status === "Done" ? task.reviewer ?? task.manager ?? task.reporter : null;
  const href = taskHref(task, projectSlug);
  const cardProjectSlug = taskProjectSlug(task, projectSlug);
  const workspaceSlug = task.project?.workspace?.slug ?? null;
  const scopeProjectSlug = task.project?.slug ?? null;
  const hasScope = Boolean(workspaceSlug || scopeProjectSlug);
  // The epic rides along on the scope line only on a per-workspace board, where
  // the scope is just the project slug. On the aggregate landing board (which
  // also carries the workspace slug) and on a project board (no scope at all)
  // the epic keeps its own row.
  const epicInline = Boolean(scopeProjectSlug && !workspaceSlug);
  // Selection and dragging are card affordances, not always-on chrome: on a
  // pointer device they fade in with the card (like the bin button), while
  // touch screens — which have no hover — always show them. A selected card
  // keeps its box visible so the selection stays legible.
  const hoverOnly = selected
    ? "opacity-100"
    : "opacity-100 md:opacity-0 md:group-hover/card:opacity-100 md:focus-visible:opacity-100";

  // The epic rides along on the scope line when there is one (a workspace
  // board reads "project · epic" on a single row) and only claims its own row
  // on a project board, where no scope line is rendered at all.
  const epicNode = task.epicTitle ? (
    task.epicId ? (
      <Link
        data-board-card-epic
        href={`/projects/${cardProjectSlug}/epics/${task.epicId}`}
        title={task.epicTitle}
        className="min-w-0 truncate font-sans normal-case tracking-normal text-text-muted outline-none transition hover:text-accent hover:underline"
      >
        {task.epicTitle}
      </Link>
    ) : (
      <span data-board-card-epic className="min-w-0 truncate font-sans normal-case tracking-normal text-text-muted" title={task.epicTitle}>
        {task.epicTitle}
      </span>
    )
  ) : null;

  return (
    <div className="relative z-10">
      <HumanReviewSrLabel task={task} />
      <div data-board-card-grid className="grid grid-cols-[2.625rem_minmax(0,1fr)] gap-x-2.5">
        <div className="col-start-1 row-start-1 flex min-h-7 items-center justify-center">
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
            className={`h-6 w-6 shrink-0 accent-accent transition-opacity md:h-4 md:w-4 ${hoverOnly}`}
          />
        </div>

        <div className="col-start-2 row-start-1 flex min-h-7 min-w-0 items-center gap-1.5 overflow-hidden text-micro text-text-muted">
          <Link
            href={href}
            className="min-w-0 truncate font-mono font-semibold tracking-wide outline-none transition hover:text-accent"
          >
            {task.workItemKey ?? "—"}
          </Link>
          <ElapsedClock task={task} now={now} />
          <time
            dateTime={task.updatedAt}
            title={`Updated ${task.updatedAt}`}
            className="shrink-0 tabular-nums"
            suppressHydrationWarning
          >
            {relativeUpdated(task.updatedAt)}
          </time>
          <ExecutionBadge task={task} />
          <BlockedBadge task={task} />
          {canShowTaskDeploymentIndicator(task) ? (
            <DeploymentIndicator status={task.deploymentStatus} />
          ) : null}
          <button
            type="button"
            {...dragAttributes}
            {...dragListeners}
            onClick={(event) => event.stopPropagation()}
            className={`ml-auto grid h-9 w-9 shrink-0 cursor-grab touch-none place-items-center rounded-md text-text-dim transition hover:bg-bg-elev hover:text-text active:cursor-grabbing md:h-7 md:w-7 ${hoverOnly}`}
            aria-label={`Drag ${task.title}`}
            title="Drag to reorder or move"
          >
            <DragHandleIcon />
          </button>
        </div>

        {/* Both identities share the rail cell: the builder at full size with
            the resolved reviewer riding its bottom-right corner, so a Done
            card gains a second face without gaining a row. */}
        <div
          data-board-card-avatar
          className="col-start-1 row-start-2 row-span-3 -mt-1 flex justify-center"
        >
          {/* The whole identity group is nudged a few px down/right off the
              rail edge so it doesn't hug the card border. */}
          <span className="relative inline-flex h-fit translate-x-[5px] translate-y-[5px]">
            {/* On a Done card the builder shifts a quarter-width left so the
                larger reviewer badge on its bottom-right corner still reads. */}
            <span className={reviewer ? "-translate-x-1/4" : ""}>
              <BoardAvatar actor={actor} busy={task.activeWorking} pulse={avatarPulse} emptyLabel="Unassigned" />
            </span>
            {reviewer ? (
              // Extra nudge (left 5px, down 10px) tucks the reviewer toward the
              // builder's lower-left so both faces stay distinct.
              <span
                data-board-card-reviewer
                className="absolute -bottom-1 -right-2 translate-x-[-5px] translate-y-[10px] rounded-full ring-2 ring-panel"
              >
                <BoardAvatar actor={reviewer} emptyLabel="No reviewer" size="sm" />
              </span>
            ) : null}
          </span>
        </div>

        <Link href={href} className="col-start-2 row-start-2 min-w-0 rounded-md pt-0.5 outline-none">
          <span className="line-clamp-2 font-medium leading-snug text-text">{task.title}</span>
        </Link>

        {hasScope ? (
          <div
            data-board-card-scope
            className="col-start-2 row-start-3 flex min-w-0 flex-wrap items-center gap-x-1.5 pt-1 font-mono text-micro font-semibold text-text-muted"
          >
            {workspaceSlug ? (
              <Link
                href={`/workspaces/${workspaceSlug}`}
                title={task.project?.workspace?.name ?? workspaceSlug}
                className="min-w-0 truncate outline-none transition hover:text-accent hover:underline"
              >
                {workspaceSlug}
              </Link>
            ) : null}
            {workspaceSlug && scopeProjectSlug ? (
              <span className="shrink-0 text-text-dim" aria-hidden="true">/</span>
            ) : null}
            {scopeProjectSlug ? (
              <Link
                href={`/projects/${scopeProjectSlug}`}
                title={task.project?.name ?? scopeProjectSlug}
                className="min-w-0 truncate outline-none transition hover:text-accent hover:underline"
              >
                {scopeProjectSlug}
              </Link>
            ) : null}
            {epicInline && epicNode ? (
              <>
                <span className="shrink-0 text-text-dim" aria-hidden="true">·</span>
                {epicNode}
              </>
            ) : null}
          </div>
        ) : null}
        {!epicInline && epicNode ? (
          <div className="col-start-2 row-start-4 flex min-w-0 pt-1 text-micro">
            {epicNode}
          </div>
        ) : null}

        {task.hasActiveBlocker ? (
          <div
            data-board-card-blocker-slot
            className="col-start-1 row-start-5 flex items-center justify-center pt-2"
          >
            <ActiveBlockerButton task={task} projectSlug={projectSlug} />
          </div>
        ) : null}

        <div className="col-start-2 row-start-5 flex min-w-0 items-center gap-2 pt-2 text-caption text-text-muted">
          <SubtaskProgress task={task} />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteRequest();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            className="ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-md text-text-dim opacity-100 transition hover:bg-crit/10 hover:text-crit md:opacity-0 md:group-hover/card:opacity-100 md:focus-visible:opacity-100"
            aria-label={`Move ${task.title} to bin`}
            title="Move to bin"
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

// Board identity avatar with an on-hover name popup. The popup opens to the
// right so it stays inside the card's own (overflow-hidden) box; the native
// title is suppressed so hovering shows one tooltip, not two.
function BoardAvatar({
  actor,
  busy = false,
  pulse,
  emptyLabel,
  size = "lg",
}: {
  actor: BoardActor | null;
  busy?: boolean;
  pulse?: boolean;
  emptyLabel: string;
  size?: "lg" | "sm" | "xs";
}) {
  const label = actor ? actorDisplayName(actor) : emptyLabel;
  const box =
    size === "xs"
      ? "h-[1.625rem] w-[1.625rem] text-nano"
      : size === "sm"
        ? "h-8 w-8 text-micro"
        : "h-[2.625rem] w-[2.625rem] text-caption";
  return (
    <span className="group/avatar relative inline-flex">
      {actor ? (
        <MessageAvatar actor={actor} size={size} busy={busy} pulse={pulse} title="" />
      ) : (
        <span
          aria-label={emptyLabel}
          className={`grid shrink-0 place-items-center rounded-full border border-dashed border-line-strong bg-panel text-text-muted ${box}`}
        >
          ?
        </span>
      )}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-30 ml-1.5 hidden -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-panel px-2 py-1 text-micro font-semibold text-text shadow-[var(--shadow-md)] group-hover/avatar:block"
      >
        {label}
      </span>
    </span>
  );
}

function TaskCard({
  task,
  projectSlug,
  onDeleteRequest,
  now,
  selected,
  onSelectionChange,
  cardScope,
}: {
  task: Task;
  projectSlug: string;
  onDeleteRequest: () => void;
  now: number | null;
  selected: boolean;
  onSelectionChange: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
  cardScope: CardScope;
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
      data-board-card
      // Scope tags let the sidebar dim non-matching cards on hover (landing
      // board only; harmless elsewhere).
      data-scope-ws={task.project?.workspace?.slug ?? undefined}
      data-scope-proj={taskProjectSlug(task, projectSlug)}
      data-selected={selected ? "true" : "false"}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        "--board-status": boardStatusColor(task.status),
        ...taskCardStyle(task, cardScope),
      } as React.CSSProperties}
      className={taskCardClass(task, isDragging, false, cardScope)}
      title={waitingOnHumanReview(task) ? HUMAN_REVIEW_LABEL : undefined}
    >
      <BoardCardBody
        task={task}
        projectSlug={projectSlug}
        now={now}
        selected={selected}
        onSelectionChange={onSelectionChange}
        onDeleteRequest={onDeleteRequest}
        dragAttributes={attributes}
        dragListeners={listeners}
      />
    </div>
  );
}

function WorkflowFocusCard({
  task,
  projectSlug,
  now,
  cardScope,
}: {
  task: Task;
  projectSlug: string;
  now: number | null;
  cardScope: CardScope;
}) {
  const router = useRouter();
  const actor = boardActorForTask(task);
  const presence = useAgentPresenceMap();
  const avatarPulse = boardAvatarPulse(task, actor, presence);

  return (
    <div
      style={{ "--board-status": boardStatusColor(task.status), ...taskCardStyle(task, cardScope) } as React.CSSProperties}
      className={`${taskCardClass(task, false, true, cardScope)} relative min-w-0 text-left`}
      title={waitingOnHumanReview(task) ? HUMAN_REVIEW_LABEL : undefined}
    >
      <button
        type="button"
        onClick={() => router.push(taskHref(task, projectSlug))}
        className="absolute inset-0 z-[5] rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        aria-label={`Open ${task.workItemKey ?? "task"}: ${task.title}`}
      />
      <HumanReviewSrLabel task={task} />
      <div className="pointer-events-none relative z-10 flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {task.status === "Done" ? (
            <BoardReporterMarker task={task} />
          ) : actor ? (
            <MessageAvatar actor={actor} size="sm" busy={task.activeWorking} pulse={avatarPulse} />
          ) : (
            <span className="text-caption text-text-muted">unassigned</span>
          )}
          <div className="min-w-0 flex-1">
            <ProjectMetaLine task={task} />
            <div className="flex min-w-0 items-center gap-1.5 text-caption text-text-muted">
              <span
                style={{ "--board-status": boardStatusColor(task.status) } as React.CSSProperties}
                className="board-status-pill shrink-0 rounded-md border px-1.5 py-0.5 text-micro font-semibold"
              >
                {task.status}
              </span>
              {canShowTaskDeploymentIndicator(task) ? <DeploymentIndicator status={task.deploymentStatus} /> : null}
              <span className="truncate font-mono uppercase tracking-wider">
                {task.workItemKey ?? "—"}
              </span>
              {task.epicTitle ? <span className="ml-1 normal-case tracking-normal">· {task.epicTitle}</span> : null}
            </div>
            <div className="mt-0.5 truncate text-body">{task.title}</div>
            <div className="mt-1 flex items-center gap-2 text-caption text-text-muted">
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
              <ExecutionBadge task={task} />
              <BlockedBadge task={task} />
            </div>
          </div>
        </div>
      </div>
      {task.hasActiveBlocker ? (
        <div className="absolute bottom-2 left-2 z-20">
          <ActiveBlockerButton task={task} projectSlug={projectSlug} />
        </div>
      ) : null}
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
      data-over={isOver ? "true" : "false"}
      style={{ "--board-status": boardStatusColor("Backlog") } as React.CSSProperties}
      className="board-lane relative overflow-hidden rounded-2xl border pt-1 transition-[background-color,border-color,box-shadow]"
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
  onDeleteRequest,
  selected,
  onSelectionChange,
  now,
  cardScope,
}: {
  task: Task;
  projectSlug: string;
  onDeleteRequest: () => void;
  selected: boolean;
  onSelectionChange: (taskId: string, selected: boolean, shiftKey?: boolean) => void;
  now: number | null;
  cardScope: CardScope;
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
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        ...(cardScope === "home" && task.workspaceColor
          ? { borderLeftWidth: "3px", borderLeftColor: task.workspaceColor }
          : {}),
      }}
      className={`grid min-h-11 min-w-[68rem] grid-cols-[minmax(14rem,1fr)_10rem_10rem_10rem_7rem_6rem_6rem_2rem] items-center gap-3 border-b border-line px-3 py-2.5 text-body transition last:border-b-0 hover:bg-panel-soft ${
        isPlanningAssigned(task) ? "bg-yellow-300/[0.08]" : statusRowClass(task.status)
      } ${selected ? "bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]" : ""} ${isDragging ? "bg-panel-soft opacity-40" : ""}`}
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
        <Link href={taskHref(task, projectSlug)} className="min-w-0 truncate rounded-sm font-medium text-text hover:text-accent hover:underline">
          {task.workItemKey ? (
            <span className="mr-1 font-mono text-micro font-semibold text-text-muted">
              {task.workItemKey}
            </span>
          ) : null}
          {task.title}
        </Link>
        <SubtaskProgress task={task} />
        <ExecutionBadge task={task} />
        <BlockedBadge task={task} />
        <ActiveBlockerButton task={task} projectSlug={projectSlug} />
      </div>
      <span className="truncate text-caption text-text-muted">
        {task.epicTitle ?? "—"}
      </span>
      <PersonCell actor={task.assignee} emptyLabel="unassigned" />
      <PersonCell actor={task.reviewer} emptyLabel="none" />
      <ElapsedClock task={task} now={now} align="right" />
      <DateActorCell iso={task.createdAt} actor={task.createdBy} dateOnly />
      <DateActorCell iso={task.updatedAt} actor={task.updatedBy} />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDeleteRequest();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        className="grid h-11 w-11 place-items-center rounded-md text-text-muted hover:bg-crit/10 hover:text-crit md:h-auto md:w-auto md:px-1.5 md:py-1"
        aria-label={`Move ${task.title} to bin`}
        title="Move to bin"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function taskHref(task: Task, fallbackProjectSlug: string) {
  return `/projects/${taskProjectSlug(task, fallbackProjectSlug)}/tasks/${task.id}`;
}

function blockerHref(task: Task, fallbackProjectSlug: string) {
  const base = `${taskHref(task, fallbackProjectSlug)}?tab=comments`;
  return task.activeBlockerCommentId
    ? `${base}&comment=${encodeURIComponent(task.activeBlockerCommentId)}`
    : base;
}

function taskProjectSlug(task: Task, fallbackProjectSlug: string) {
  return task.project?.slug ?? fallbackProjectSlug;
}

function projectDisplayName(project: NonNullable<Task["project"]>) {
  return project.workspace ? `${project.workspace.name} / ${project.name}` : project.name;
}

function ProjectMetaLine({ task }: { task: Task }) {
  if (!task.project) return null;
  return (
    <div className="mb-0.5 truncate text-micro font-semibold text-text-muted">
      {projectDisplayName(task.project)}
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
  return task.status === "Done" && canShowDeploymentForTask(task) && task.deploymentStatus !== "Not Required";
}

function BoardReporterMarker({ task }: { task: Task }) {
  return task.reporter ? <MessageAvatar actor={task.reporter} size="sm" pulse={false} /> : null;
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
        <MessageAvatar actor={actor} size="sm" pulse={false} />
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
  // Done credits the builder in the rail; the resolved reviewer gets its own
  // avatar slot on the card, so it must not also win the primary slot.
  if (task.status === "Done") return task.assignee ?? task.reporter;
  return task.reporter ?? task.assignee ?? task.reviewer ?? task.manager;
}

// Live, task-scoped pulse for a board card: the shown identity
// (boardActorForTask) pulses only while it is the agent actively working
// (In Progress → assignee) or reviewing (Review → reviewer) THIS task, driven by
// the live presence store so a busy flip pulses without a board refresh. Falls
// back to the server's render-time flag until the presence stream has reported.
function boardAvatarPulse(
  task: Task,
  actor: BoardActor | null,
  presence: Record<string, string>,
): boolean {
  if (task.status !== "In Progress" && task.status !== "Review") return false;
  const slug = actor?.agent?.slug ?? null;
  if (!slug) return false;
  if (Object.keys(presence).length === 0) return task.activeWorking;
  return presence[slug] === "busy";
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

function taskNeedsAttention(task: Task) {
  return Boolean(
    task.blockedByKey ||
    task.hasActiveBlocker ||
    task.status === "Review" ||
    isPlanningAssigned(task),
  );
}

// A Review card is waiting on a HUMAN when its resolved reviewer (task
// reviewer ?? acting manager ?? reporter — the same chain Done cards credit)
// is a human rather than an agent. Those tasks need the PM owner's personal
// attention, so the card gets a red attention treatment.
function waitingOnHumanReview(task: Task) {
  if (task.status !== "Review") return false;
  const reviewer = task.reviewer ?? task.manager ?? task.reporter;
  return reviewer?.kind === "human";
}

const HUMAN_REVIEW_LABEL = "Waiting on human review";

// Screen-reader counterpart of the red human-review card treatment.
function HumanReviewSrLabel({ task }: { task: Task }) {
  if (!waitingOnHumanReview(task)) return null;
  return <span className="sr-only">{HUMAN_REVIEW_LABEL}</span>;
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
      className={`shrink-0 items-center gap-1 rounded-md border border-line bg-bg-elev px-1.5 py-0.5 font-mono text-micro tabular-nums text-text-muted ${
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
      {actor ? <MessageAvatar actor={actor} size="sm" pulse={false} /> : null}
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

function taskCardClass(task: Task, isDragging = false, interactive = true, scope: CardScope = "home") {
  // The workspace-hue left rail is only meaningful on the aggregate home board;
  // the colour itself is applied inline (taskCardStyle) — this just reserves the
  // 3px width so it isn't painted with the default border colour elsewhere.
  const borderStyle = scope === "home" && task.workspaceColor ? "border-l-[3px]" : "";
  return `board-task-card group/card relative block w-full select-none overflow-hidden rounded-xl border p-3 text-body transition-[transform,border-color,box-shadow,background-color,opacity] active:scale-[0.99] ${interactive ? "cursor-pointer" : ""} ${isPlanningAssigned(task) ? "board-task-card--planning" : ""} ${
    waitingOnHumanReview(task) ? "board-task-card--human-review" : ""
  } ${isDragging ? "opacity-30" : "hover:-translate-y-px"} ${borderStyle}`;
}

function taskCardStyle(task: Task, scope: CardScope = "home"): React.CSSProperties {
  const style: React.CSSProperties = {};
  // Workspace left border: home board only. Project background tint: home and
  // per-workspace boards; a project board's own cards stay plain white.
  if (scope === "home" && task.workspaceColor) {
    style.borderLeftWidth = "3px";
    style.borderLeftColor = task.workspaceColor;
  }
  if (scope !== "project" && task.projectColor) {
    style.backgroundColor = `${task.projectColor}18`;
  }
  return style;
}

function boardStatusColor(status: string) {
  if (status === "To Do") return "var(--status-todo)";
  if (status === "In Progress") return "var(--status-progress)";
  if (status === "Review") return "var(--status-review)";
  if (status === "Done") return "var(--status-done)";
  return "var(--status-backlog)";
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
