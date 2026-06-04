"use client";

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
    <div className="space-y-4">
      {error && (
        <div role="alert" className="rounded-xl border border-[var(--color-crit)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm text-[var(--color-crit)]">
          {error}
        </div>
      )}

      {selectedCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/[0.08] px-4 py-3 text-sm shadow-sm">
          <span className="font-semibold text-[var(--color-text)]">
            {selectedCount} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={bulkDeleteSelected}
              className="rounded-lg border border-[var(--color-crit)] bg-transparent px-3 py-1.5 text-xs font-semibold text-[var(--color-crit)] transition hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
            >
              Delete selected
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
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
        <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => toggleSelectAll(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-accent)]"
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
