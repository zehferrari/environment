"use client";

import { useRouter } from "next/navigation";

const OPTIONS = ["Backlog", "In Progress", "Ready to Deploy", "Done"] as const;

export default function EpicStatusFilter({
  projectSlug,
  selectedStatuses,
  disabled = false,
}: {
  projectSlug: string;
  selectedStatuses: string[];
  disabled?: boolean;
}) {
  const router = useRouter();
  const selected = new Set(selectedStatuses);

  function toggleStatus(status: string) {
    const next = new Set(selectedStatuses);
    if (next.has(status)) next.delete(status);
    else next.add(status);
    const statuses = OPTIONS.filter((option) => next.has(option));
    const query = statuses.length > 0
      ? `?view=board&statuses=${encodeURIComponent(statuses.join(","))}`
      : "?view=board&statuses=";
    router.push(`/projects/${projectSlug}/epics${query}`);
  }

  return (
    <fieldset className="min-w-0 text-body" disabled={disabled}>
      <legend className="mb-1.5 text-nano font-semibold uppercase tracking-wider text-text-muted">
        Status filter
      </legend>
      <div className="flex flex-wrap gap-2" aria-label="Filter epics by status">
        {OPTIONS.map((status) => {
          const active = selected.has(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() => toggleStatus(status)}
              className={
                active
                  ? "min-h-9 rounded-lg border border-accent bg-accent px-3 py-1.5 text-caption font-semibold text-bg shadow-[var(--shadow-xs)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                  : "min-h-9 rounded-lg border border-line bg-panel px-3 py-1.5 text-caption font-semibold text-text-muted shadow-[var(--shadow-xs)] transition hover:border-line-strong hover:bg-panel-soft hover:text-text disabled:cursor-not-allowed disabled:opacity-45"
              }
            >
              {status}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
