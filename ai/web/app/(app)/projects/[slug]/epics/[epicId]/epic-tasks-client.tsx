"use client";

import { useState, useEffect, useTransition } from "react";
import SortableTaskList from "@/components/sortable-task-list";
import { bulkBinTasks } from "@/lib/bin/actions";

const TASK_STATUS_ORDER = ["Backlog", "To Do", "In Progress", "Review", "Done"];

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
  const [, startTransition] = useTransition();

  useEffect(() => {
    setTasks(initialTasks);
    setSelectedIds((current) => {
      const liveIds = new Set(initialTasks.map((t) => t.id));
      return new Set([...current].filter((id) => liveIds.has(id)));
    });
  }, [initialTasks]);

  const tasksByStatus = new Map<string, any[]>();
  for (const s of TASK_STATUS_ORDER) tasksByStatus.set(s, []);
  for (const t of tasks) {
    const status = t.status || "Backlog";
    const list = tasksByStatus.get(status) ?? [];
    list.push(t);
    tasksByStatus.set(status, list);
  }

  function toggleTaskSelection(taskId: string, selected: boolean, shiftKey?: boolean) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    setSelectedIds((current) => {
      const next = new Set(current);

      if (shiftKey && lastCheckedId) {
        const status = task.status || "Backlog";
        const list = tasksByStatus.get(status) ?? [];

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

  function toggleSelectAllStatus(status: string, checked: boolean) {
    const list = tasksByStatus.get(status) ?? [];
    setSelectedIds((current) => {
      const next = new Set(current);
      list.forEach((t) => {
        if (checked) next.add(t.id);
        else next.delete(t.id);
      });
      return next;
    });
  }

  function bulkDeleteSelected() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Are you sure you want to delete these ${selectedIds.size} task(s)?`)) return;

    const ids = Array.from(selectedIds);
    const previousTasks = tasks;
    setTasks((prev) => prev.filter((t) => !selectedIds.has(t.id)));
    setError(null);

    startTransition(async () => {
      try {
        await bulkBinTasks(ids, projectSlug);
        setSelectedIds(new Set());
      } catch (err) {
        setTasks(previousTasks);
        setError((err as Error).message);
      }
    });
  }

  const selectedCount = selectedIds.size;

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

      <div className="space-y-3">
        {TASK_STATUS_ORDER.map((s) => {
          const list = tasksByStatus.get(s) ?? [];
          if (list.length === 0) return null;

          const allSelected = list.every((t) => selectedIds.has(t.id));

          return (
            <div key={s} className="space-y-1">
              <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) => toggleSelectAllStatus(s, e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                    aria-label={`Select all in ${s}`}
                  />
                  <span>
                    {s} ({list.length})
                  </span>
                </div>
              </div>
              <SortableTaskList
                ariaLabel={`Tasks in ${s}`}
                reorderAction={reorderEpicTasks}
                tableLayout
                showReporterAvatar
                showAssignee
                showReviewer
                showCreated
                showUpdated
                projectSlug={projectSlug}
                items={list}
                selectedIds={selectedIds}
                onSelectionChange={toggleTaskSelection}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
