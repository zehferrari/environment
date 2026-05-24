"use client";

import { useState } from "react";
import { createEpic } from "@/lib/epics/actions";

type Principal = { id: string; username: string; kind: string };

// Floating "+" button + modal for creating an epic. Title is the only
// mandatory field; description, acting manager and assignee are optional
// (HOMELAB-41). createEpic redirects into the new epic on success, so the
// modal simply unmounts on navigation.
export default function NewEpicFab({
  projectSlug,
  principals,
}: {
  projectSlug: string;
  principals: Principal[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <form
            action={createEpic}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-2xl"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                New epic
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-lg leading-none text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                ×
              </button>
            </div>

            <input
              name="title"
              required
              autoFocus
              maxLength={200}
              placeholder="Epic title"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <textarea
              name="description"
              rows={8}
              placeholder="Description (optional) — markdown supported"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-xs">
                <span className="mb-1 block text-[var(--color-text-muted)]">
                  Assignee
                </span>
                <select
                  name="assigneeId"
                  defaultValue=""
                  className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">Unassigned</option>
                  {principals.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.username}
                      {p.kind === "agent" ? " (agent)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-[var(--color-text-muted)]">
                  Acting manager
                </span>
                <select
                  name="actingManagerId"
                  defaultValue=""
                  className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">No acting manager</option>
                  {principals.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.username}
                      {p.kind === "agent" ? " (agent)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-sm font-medium hover:border-[var(--color-accent)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Create epic
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="New epic"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-3xl leading-none text-[var(--color-bg)] shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
