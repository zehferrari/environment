"use client";

import { useRouter } from "next/navigation";
import { useState, useEffect, useTransition } from "react";
import SortableTaskList from "@/components/sortable-task-list";
import { bulkBinTasks } from "@/lib/bin/actions";
import ConfirmPopup from "@/components/confirm-popup";

export default function EpicTasksClient({
  initialTasks,
  projectSlug,
  reorderEpicTasks,
  epicId,
}: {
  initialTasks: any[];
  projectSlug: string;
  reorderEpicTasks: (orderedIds: string[]) => Promise<void>;
  epicId: string;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  useEffect(() => {
    setTasks(initialTasks);
    setSelectedIds((current) => {
      const liveIds = new Set(initialTasks.map((t) => t.id));
      return new Set([...current].filter((id) => liveIds.has(id)));
    });
  }, [initialTasks]);

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

  function toggleTaskSelection(taskId: string, selected: boolean, shiftKey?: boolean) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    setSelectedIds((current) => {
      const next = new Set(current);

      if (shiftKey && lastCheckedId) {
        const lastIdx = tasks.findIndex((t) => t.id === lastCheckedId);
        const currIdx = tasks.findIndex((t) => t.id === taskId);

        if (lastIdx !== -1 && currIdx !== -1) {
          const start = Math.min(lastIdx, currIdx);
          const end = Math.max(lastIdx, currIdx);
          for (let i = start; i <= end; i++) {
            if (selected) {
              next.add(tasks[i].id);
            } else {
              next.delete(tasks[i].id);
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

  function toggleSelectAll(checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      tasks.forEach((t) => {
        if (checked) next.add(t.id);
        else next.delete(t.id);
      });
      return next;
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
    const previousTasks = tasks;
    setTasks((prev) => prev.filter((t) => !selectedIds.has(t.id)));
    setError(null);

    startTransition(async () => {
      try {
        await bulkBinTasks(ids, projectSlug);
        setSelectedIds(new Set());
        setConfirmDeleteOpen(false);
      } catch (err) {
        setTasks(previousTasks);
        setError((err as Error).message);
        setConfirmDeleteOpen(false);
      }
    });
  }

  const selectedCount = selectedIds.size;
  const allSelected = tasks.length > 0 && tasks.every((t) => selectedIds.has(t.id));

  return (
    <div className="space-y-section-gap">
      {error && (
        <div role="alert" className="rounded-card border border-crit bg-panel-soft px-3 py-2 text-body text-crit">
          {error}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-panel border border-accent/30 bg-accent/[0.08] px-4 py-3 text-body shadow-sm">
          <span className="font-semibold text-text">
            {selectedCount} selected
          </span>
          <div className="flex items-center gap-2">
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
      )}

      <ConfirmPopup
        open={confirmDeleteOpen}
        title="Delete selected tasks"
        description={`Move ${selectedCount} task${selectedCount === 1 ? "" : "s"} to the bin? They'll be permanently deleted after the bin TTL elapses.`}
        confirmLabel="Move to bin"
        danger
        busy={isPending}
        onConfirm={performBulkDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />

      <div className="space-y-1">
        <div className="flex items-center justify-between text-micro font-semibold uppercase tracking-wider text-text-muted">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => toggleSelectAll(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
              aria-label="Select all tasks"
            />
            <span>Implementation order ({tasks.length})</span>
          </div>
        </div>
        <SortableTaskList
          ariaLabel="Epic tasks in implementation order"
          reorderAction={reorderEpicTasks}
          tableLayout
          showStatusBadge
          showReporterAvatar
          showAssignee
          showReviewer
          showCreated
          showUpdated
          projectSlug={projectSlug}
          items={tasks}
          selectedIds={selectedIds}
          onSelectionChange={toggleTaskSelection}
        />
      </div>
    </div>
  );
}
