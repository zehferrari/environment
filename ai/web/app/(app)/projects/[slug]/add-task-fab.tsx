"use client";

import { useState } from "react";

type Principal = { id: string; username: string; kind: string };
type EpicOption = { id: string; title: string };

// Floating "+" button + modal for creating a top-level task. Mirrors the
// New Epic modal (HOMELAB-41) and adds an Epic combobox. Title is the only
// required field; assignee/reviewer pre-select the project defaults so the
// submitted value is authoritative. Title is still validated server-side.
export default function AddTaskFab({
  projectId,
  projectSlug,
  principals,
  epics,
  defaultAssigneeId,
  defaultReviewerId,
  createTaskAction,
}: {
  projectId: string;
  projectSlug: string;
  principals: Principal[];
  epics: EpicOption[];
  defaultAssigneeId: string | null;
  defaultReviewerId: string | null;
  createTaskAction: (formData: FormData) => Promise<void>;
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
            action={createTaskAction}
            onSubmit={() => setOpen(false)}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-2xl"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                New task
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

            <label className="block text-xs">
              <span className="mb-1 block text-[var(--color-text-muted)]">
                Epic
              </span>
              <select
                name="epicId"
                defaultValue=""
                className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
              >
                <option value="">No epic</option>
                {epics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-xs">
                <span className="mb-1 block text-[var(--color-text-muted)]">
                  Assignee
                </span>
                <select
                  name="assigneeId"
                  defaultValue={defaultAssigneeId ?? ""}
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
                  Reviewer
                </span>
                <select
                  name="actingManagerId"
                  defaultValue={defaultReviewerId ?? ""}
                  className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">No reviewer</option>
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
                Add task
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add task"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-3xl leading-none text-[var(--color-bg)] shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
