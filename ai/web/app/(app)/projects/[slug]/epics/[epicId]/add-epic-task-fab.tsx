"use client";

import { useState } from "react";

export default function AddEpicTaskFab({
  projectSlug,
  epicId,
  createTaskAction,
}: {
  projectSlug: string;
  epicId: string;
  createTaskAction: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <form
            action={createTaskAction}
            onSubmit={() => setOpen(false)}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-lg space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-2xl"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <input type="hidden" name="epicId" value={epicId} />
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                New epic task
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
              placeholder="Task title"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <textarea
              name="description"
              rows={6}
              placeholder="Description (optional) — markdown supported"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed outline-none focus:border-[var(--color-accent)]"
            />
            <p className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
              This task will be linked to the current Epic and inherit the Epic branch / commit prefix defaults.
            </p>
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
                Add task
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add task to epic"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-3xl leading-none text-[var(--color-bg)] shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
