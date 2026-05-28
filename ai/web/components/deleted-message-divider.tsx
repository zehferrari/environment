"use client";

// Collapsed-by-default placeholder for a soft-deleted comment / chat
// bubble / direct-chat message (HOMELAB-41 / item 2).
//
// Shown to humans in place of the original row when row.deletedAt is set.
// Renders as a horizontal dotted line with a [+] button at the right; the
// button toggles the children body open (full original markdown / text
// rendered by whichever caller passes in the JSX). Toggle state is
// component-local — a page reload re-collapses.
//
// Agents never see this component: agent context builders filter
// deletedAt: null at the data layer (see lib/agents/context/task.ts and
// lib/agents/context/epic.ts).

import { useState } from "react";

export interface DeletedMessageDividerProps {
  deletedAt: Date | string | null;
  deletedBy?: {
    username?: string | null;
    name?: string | null;
    kind?: string | null;
  } | null;
  /** Original row body, rendered when the user expands the divider. */
  children?: React.ReactNode;
  /** Optional label suffix shown next to "Deleted". Defaults to the deletedBy username. */
  label?: string;
}

function formatDeletedAt(value: Date | string | null) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function DeletedMessageDivider({
  deletedAt,
  deletedBy,
  children,
  label,
}: DeletedMessageDividerProps) {
  const [open, setOpen] = useState(false);
  const stamp = formatDeletedAt(deletedAt);
  const authorLabel = label
    ?? (deletedBy?.username ? `@${deletedBy.username}` : null);

  return (
    <div className="my-1.5">
      <div className="flex items-center gap-2">
        <div
          aria-hidden="true"
          className="flex-1 border-t border-dotted border-[var(--color-text-muted)]/40"
        />
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]/70">
          deleted{authorLabel ? ` by ${authorLabel}` : ""}{stamp ? ` · ${stamp}` : ""}
        </span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide deleted content" : "Show deleted content"}
          title={open ? "Hide deleted content" : "Show deleted content"}
          className="grid h-5 w-5 place-items-center rounded border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[10px] font-mono leading-none text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer"
        >
          {open ? "−" : "+"}
        </button>
      </div>
      {open && children ? (
        <div className="mt-1.5 rounded-lg border border-dotted border-[var(--color-line)] bg-[var(--color-panel-soft)]/60 px-3 py-2 text-xs text-[var(--color-text-muted)] line-through decoration-[var(--color-text-muted)]/40">
          {children}
        </div>
      ) : null}
    </div>
  );
}
