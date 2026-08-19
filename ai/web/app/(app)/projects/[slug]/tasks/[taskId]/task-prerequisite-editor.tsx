"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

/**
 * ENV-159 Step 8: Multi-prerequisite task editor.
 *
 * Replaces the single-value blockedById combobox with a searchable
 * multi-select backed by the task_dependencies API route.
 *
 * - Shows current prerequisites as removable items (work-item key, title, status)
 * - Search and select multiple without closing/resetting
 * - Excludes task itself, deleted/private/inaccessible, duplicates, cycles
 * - Manager-created/cross-project edges rendered read-only and preserved
 * - Full add/remove diff applied transactionally via POST
 */

interface DependencyItem {
  id: string;
  title: string;
  workItemKey: string | null;
  status: string;
  projectId: string | null;
  private: boolean;
  source: "dependency" | "legacy";
}

interface SearchResult {
  id: string;
  title: string;
  workItemKey: string | null;
  status: string;
  project: { name: string; slug: string } | null;
}

interface TaskPrerequisiteEditorProps {
  taskId: string;
  projectSlug: string;
  /** Tasks already shown as non-editable (manager-created/cross-project) */
  readOnlyDependencies?: DependencyItem[];
  /** Whether the current user can edit dependencies */
  canEdit: boolean;
}

export function TaskPrerequisiteEditor({
  taskId,
  projectSlug,
  readOnlyDependencies = [],
  canEdit,
}: TaskPrerequisiteEditorProps) {
  const [dependencies, setDependencies] = useState<DependencyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch current dependencies on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchDeps() {
      try {
        const res = await fetch(`/api/tasks/${taskId}/dependencies`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setDependencies(data.dependencies ?? []);
        }
      } catch {
        // Non-fatal — editor starts empty
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetchDeps();
    return () => { cancelled = true; };
  }, [taskId]);

  // Debounced search
  useEffect(() => {
    if (searchQuery.trim().length < 1) {
      setSearchResults([]);
      setShowResults(false);
      return;
    }
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ q: searchQuery, exclude: taskId });
        const res = await fetch(`/api/tasks/search?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        setSearchResults(data.results ?? []);
        setShowResults(true);
      } catch {
        // Non-fatal
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery, taskId]);

  // Close results on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedIds = new Set(dependencies.map((d) => d.id));
  const readOnlyIds = new Set(readOnlyDependencies.map((d) => d.id));

  const addPrerequisite = useCallback(async (task: SearchResult) => {
    setError(null);
    setSaving(true);
    try {
      const newIds = [...selectedIds, task.id];
      const res = await fetch(`/api/tasks/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prerequisiteTaskIds: [...newIds] }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to add prerequisite");
      }
      // Refetch dependencies to get full details
      const depsRes = await fetch(`/api/tasks/${taskId}/dependencies`);
      if (depsRes.ok) {
        const depsData = await depsRes.json();
        setDependencies(depsData.dependencies ?? []);
      }
      setSearchQuery("");
      setShowResults(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add prerequisite");
    } finally {
      setSaving(false);
    }
  }, [taskId, selectedIds]);

  const removePrerequisite = useCallback(async (depId: string) => {
    if (readOnlyIds.has(depId)) return; // Can't remove read-only
    setError(null);
    setSaving(true);
    try {
      const newIds = dependencies.filter((d) => d.id !== depId).map((d) => d.id);
      const res = await fetch(`/api/tasks/${taskId}/dependencies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prerequisiteTaskIds: newIds }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to remove prerequisite");
      }
      // Refetch dependencies
      const depsRes = await fetch(`/api/tasks/${taskId}/dependencies`);
      if (depsRes.ok) {
        const depsData = await depsRes.json();
        setDependencies(depsData.dependencies ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove prerequisite");
    } finally {
      setSaving(false);
    }
  }, [taskId, dependencies, readOnlyIds]);

  if (loading) {
    return (
      <div className="space-y-1 rounded-card border border-line bg-panel-soft p-card">
        <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
          Prerequisites
        </div>
        <div className="text-caption text-text-muted">Loading…</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-1.5 rounded-card border border-line bg-panel-soft p-card">
      <div className="flex items-center gap-1.5 text-micro font-semibold uppercase tracking-wider text-text-muted">
        <LockIcon />
        Prerequisites
      </div>

      {/* Current prerequisites as removable items */}
      {dependencies.length > 0 ? (
        <div className="space-y-1 text-caption">
          {dependencies.map((dep) => {
            const isReadOnly = readOnlyIds.has(dep.id);
            return (
              <div
                key={dep.id}
                className="flex items-center justify-between gap-2 rounded-md px-1.5 py-1 bg-bg/50"
              >
                <Link
                  href={`/projects/${projectSlug}/tasks/${dep.id}`}
                  className="min-w-0 truncate hover:underline"
                  >
                  {dep.workItemKey ?? dep.title}
                  <span className="ml-1 text-nano text-text-muted">
                    {dep.status}
                  </span>
                </Link>
                {canEdit && !isReadOnly ? (
                  <button
                    type="button"
                    onClick={() => removePrerequisite(dep.id)}
                    disabled={saving}
                    className="shrink-0 text-text-muted hover:text-danger disabled:opacity-50"
                    aria-label={`Remove ${dep.workItemKey ?? dep.title}`}
                  >
                    ✕
                  </button>
                ) : isReadOnly ? (
                  <span className="shrink-0 text-nano text-text-muted" title="Manager-created — read only">
                    🔒
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="text-caption text-text-muted">No prerequisites set.</div>
      )}

      {/* Search and add */}
      {canEdit ? (
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => searchResults.length > 0 && setShowResults(true)}
            placeholder="Search tasks to add as prerequisite…"
            disabled={saving}
            className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption outline-none focus:border-accent disabled:opacity-50"
            aria-label="Search prerequisite tasks"
          />
          {showResults && searchResults.length > 0 ? (
            <div className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-bg shadow-lg">
              {searchResults
                .filter((r) => !selectedIds.has(r.id))
                .map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => addPrerequisite(result)}
                    disabled={saving}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-caption hover:bg-panel-soft disabled:opacity-50"
                  >
                    <span className="min-w-0 truncate">
                      {result.workItemKey ? `${result.workItemKey} — ` : ""}
                      {result.title}
                    </span>
                    <span className="shrink-0 text-nano text-text-muted">
                      {result.project?.name ?? ""}
                      {" · "}
                      {result.status}
                    </span>
                  </button>
                ))}
              {searchResults.filter((r) => !selectedIds.has(r.id)).length === 0 ? (
                <div className="px-2 py-1.5 text-caption text-text-muted">
                  All matches already selected.
                </div>
              ) : null}
            </div>
          ) : null}
          {searching ? (
            <div className="absolute right-2 top-1.5 text-nano text-text-muted">
              searching…
            </div>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="text-caption text-danger">{error}</div>
      ) : null}

      <p className="text-nano text-text-muted">
        Assignment and start unlock only after every prerequisite is Done.
      </p>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 7V5a4 4 0 1 1 8 0v2M2 7h12v7H2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}