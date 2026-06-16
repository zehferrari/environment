"use client";

// Collapsed-by-default placeholder for a soft-deleted comment / chat
// bubble / direct-chat message (HOMELAB-41 / item 2).
//
// Shown to humans in place of the original row when row.deletedAt is set.
// Renders as a horizontal dotted line with a [+] toggle and an optional
// ↺ restore button. The [+] reveals the original body (rendered by the
// caller via children). Restore is wired by callers that pass `restore`
// — it runs a ConfirmPopup, then invokes the server action which clears
// deletedAt/deletedById so the row is human-visible AND eligible for
// agent context again.
//
// Agents never see this component: agent context builders filter
// deletedAt: null at the data layer (see lib/agents/context/task.ts and
// lib/agents/context/epic.ts).

import { useState, useTransition } from "react";
import ConfirmPopup from "@/components/confirm-popup";

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
  /** Optional restore handler. If passed, the divider shows an ↺ button
   *  next to [+] that pops a confirmation and then runs `restore.action`
   *  with FormData built from `restore.fields`. Restoring clears
   *  deletedAt/deletedById on the row (server-side), so the row becomes
   *  human-visible AND included in agent context again. */
  restore?: {
    action: (formData: FormData) => Promise<void>;
    fields: Record<string, string>;
  };
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
  restore,
}: DeletedMessageDividerProps) {
  const [open, setOpen] = useState(false);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const stamp = formatDeletedAt(deletedAt);
  const authorLabel = label
    ?? (deletedBy?.username ? `@${deletedBy.username}` : null);

  const runRestore = () => {
    if (!restore) return;
    const fd = new FormData();
    for (const [k, v] of Object.entries(restore.fields)) fd.append(k, v);
    startTransition(async () => {
      try {
        await restore.action(fd);
      } finally {
        setConfirmRestoreOpen(false);
      }
    });
  };

  return (
    <div className="my-1.5">
      <div className="flex items-center gap-2">
        <div
          aria-hidden="true"
          className="flex-1 border-t border-dotted text-text-muted/40"
        />
        <span className="text-[10px] uppercase tracking-wider text-text-muted/70">
          deleted{authorLabel ? ` by ${authorLabel}` : ""}{stamp ? ` · ${stamp}` : ""}
        </span>
        {restore ? (
          <button
            type="button"
            disabled={isPending}
            onClick={() => setConfirmRestoreOpen(true)}
            aria-label="Restore deleted content"
            title="Restore — makes the row visible again and re-includes it in agent context"
            className="grid h-5 w-5 place-items-center rounded border border-line bg-panel-soft text-[10px] leading-none text-text-muted hover:border-accent hover:text-accent cursor-pointer disabled:opacity-50"
          >
            ↺
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide deleted content" : "Show deleted content"}
          title={open ? "Hide deleted content" : "Show deleted content"}
          className="grid h-5 w-5 place-items-center rounded border border-line bg-panel-soft text-[10px] font-mono leading-none text-text-muted hover:border-accent hover:text-accent cursor-pointer"
        >
          {open ? "−" : "+"}
        </button>
      </div>
      {open && children ? (
        <div className="mt-1.5 rounded-lg border border-dotted border-line bg-panel-soft/60 px-3 py-2 text-xs text-text-muted line-through text-text-muted/40">
          {children}
        </div>
      ) : null}
      {restore ? (
        <ConfirmPopup
          open={confirmRestoreOpen}
          title="Restore deleted content"
          description="Restoring makes this message visible again to humans AND re-includes it in the context sent to agents. Continue?"
          confirmLabel="Restore"
          busy={isPending}
          onConfirm={runRestore}
          onCancel={() => setConfirmRestoreOpen(false)}
        />
      ) : null}
    </div>
  );
}
