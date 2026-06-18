"use client";

import { useState } from "react";
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
  const [open, setOpen] = useState(false);
  const selected = new Set(selectedStatuses);
  const label = selectedStatuses.length === OPTIONS.length
    ? "Backlog, In Progress, Ready to Deploy, Done"
    : selectedStatuses.length === 0
      ? "No statuses"
      : selectedStatuses.join(", ");

  function updateStatus(status: string, checked: boolean) {
    const next = new Set(selectedStatuses);
    if (checked) next.add(status);
    else next.delete(status);
    const statuses = OPTIONS.filter((option) => next.has(option));
    const query = statuses.length > 0
      ? `?view=board&statuses=${encodeURIComponent(statuses.join(","))}`
      : "?view=board&statuses=";
    router.push(`/projects/${projectSlug}/epics${query}`);
  }

  return (
    <div className="relative inline-block text-body">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex min-w-64 items-center justify-between gap-3 rounded-card border border-line bg-panel px-3 py-2 text-left text-body text-text shadow-sm transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-45"
        aria-expanded={open}
      >
        <span className="min-w-0">
          <span className="block text-nano font-semibold uppercase tracking-wider text-text-muted">
            Status filter
          </span>
          <span className="block truncate">{label}</span>
        </span>
        <span className="shrink-0 text-text-muted" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && !disabled ? (
        <div className="absolute left-0 z-30 mt-2 w-full rounded-card border border-line bg-panel p-2 shadow-2xl">
          {OPTIONS.map((status) => (
            <label
              key={status}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-caption text-text transition hover:bg-panel-soft"
            >
              <input
                type="checkbox"
                checked={selected.has(status)}
                onChange={(event) => updateStatus(status, event.currentTarget.checked)}
                className="h-4 w-4 accent-accent"
              />
              <span>{status}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
