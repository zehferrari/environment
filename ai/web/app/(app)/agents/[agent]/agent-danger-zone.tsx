"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AgentDeletionSummary } from "@/lib/agents/deletion-summary";

/**
 * Admin-only "remove agent" control. Deletion is irreversible — it deprovisions
 * the Linux user, workspace, and config via /api/agents/remove — so the action
 * is gated behind a modal that shows exactly what gets removed vs kept, and
 * requires typing the agent's slug to confirm.
 */
export default function AgentDangerZone({
  agent,
  name,
  summary,
}: {
  agent: string;
  name: string;
  summary: AgentDeletionSummary;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = confirmText.trim() === agent;

  const close = () => {
    if (busy) return;
    setOpen(false);
    setConfirmText("");
    setError(null);
  };

  const remove = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/agents/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: agent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed with status ${res.status}`);
      }
      // The agent no longer exists; leave the (now-404) detail page.
      router.push("/agents");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-[var(--color-crit)]/40 bg-[var(--color-crit)]/5 p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--color-crit)]">Danger Zone</h3>
      <p className="mt-2 text-sm text-[var(--color-text-muted)]">
        Permanently remove <span className="font-mono text-[var(--color-text)]">@{agent}</span>. This deletes the
        Linux user, their workspace, and their config. This cannot be undone.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 cursor-pointer rounded-lg bg-[var(--color-crit)] px-4 py-2 text-xs font-semibold text-white transition hover:opacity-90"
      >
        Remove agent
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onClick={close}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-2xl"
          >
            <h4 className="text-base font-semibold text-[var(--color-text)]">Remove agent {name}?</h4>
            <p className="mt-2 text-sm text-[var(--color-text-muted)]">
              This is exactly what removing{" "}
              <span className="font-mono text-[var(--color-text)]">@{agent}</span> does. This cannot be undone.
            </p>

            <div className="mt-3 max-h-[40vh] space-y-3 overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3 text-sm">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-crit)]">Removed</div>
                <ul className="mt-1 space-y-0.5 text-[var(--color-text-muted)]">
                  {summary.removed.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span className="text-[var(--color-crit)]">✕</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {summary.account && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-warn)]">Login</div>
                  <p className="mt-1 text-[var(--color-text-muted)]">
                    <span className="font-mono text-[var(--color-text)]">@{summary.account.username}</span> — {summary.account.note}
                  </p>
                </div>
              )}

              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ok)]">
                  Kept (under the deactivated account)
                </div>
                <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[var(--color-text-muted)]">
                  {summary.preserved.map((row) => (
                    <li key={row.label} className="flex justify-between gap-2">
                      <span>{row.label}</span>
                      <span className="font-mono text-[var(--color-text)]">{row.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {error && (
              <div className="mt-3 rounded-xl border border-[var(--color-crit)] bg-[var(--color-crit)]/10 p-3 text-xs text-[var(--color-crit)]">
                {error}
              </div>
            )}

            <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Type <span className="font-mono text-[var(--color-text)]">{agent}</span> to confirm
            </label>
            <input
              type="text"
              autoFocus
              disabled={busy}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={agent}
              className="mt-1 w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 font-mono text-[var(--color-text)] focus:border-[var(--color-crit)] focus:outline-none disabled:opacity-60"
            />

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={close}
                className="cursor-pointer rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !matches}
                onClick={remove}
                className="cursor-pointer rounded-lg bg-[var(--color-crit)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Removing…" : "Remove agent"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
