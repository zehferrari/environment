"use client";

import React, { useActionState, useEffect, useRef, useState } from "react";

export type AddEpicTaskState = {
  ok: boolean;
  error: string | null;
};

const initialState: AddEpicTaskState = { ok: false, error: null };

export function addEpicTaskDisabledReason(actingManagerName: string | null): string {
  return actingManagerName
    ? `Only ${actingManagerName} can create the initial Epic task breakdown.`
    : "Only the Epic acting manager can create the initial Epic task breakdown.";
}

export default function AddEpicTaskFab({
  projectSlug,
  epicId,
  createTaskAction,
  canCreateTask,
  actingManagerName,
  canSetPrivate = false,
}: {
  projectSlug: string;
  epicId: string;
  createTaskAction: (state: AddEpicTaskState, formData: FormData) => Promise<AddEpicTaskState>;
  canCreateTask: boolean;
  actingManagerName: string | null;
  canSetPrivate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(createTaskAction, initialState);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.ok) return;
    setOpen(false);
    formRef.current?.reset();
  }, [state.ok]);

  const disabledReason = addEpicTaskDisabledReason(actingManagerName);

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <form
            ref={formRef}
            action={formAction}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-lg space-y-3 rounded-panel border border-line bg-panel p-card-lg shadow-2xl"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <input type="hidden" name="epicId" value={epicId} />
            <div className="flex items-center justify-between">
              <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                New epic task
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-heading leading-none text-text-muted hover:text-text"
              >
                ×
              </button>
            </div>
            {state.error ? (
              <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-body text-red-300">
                {state.error}
              </p>
            ) : null}
            <input
              name="title"
              required
              autoFocus
              maxLength={200}
              placeholder="Task title"
              disabled={isPending}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent disabled:cursor-wait disabled:opacity-70"
            />
            <textarea
              name="description"
              rows={6}
              placeholder="Description (optional) — markdown supported"
              disabled={isPending}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body leading-relaxed outline-none focus:border-accent disabled:cursor-wait disabled:opacity-70"
            />
            {canSetPrivate ? (
              <label className="flex items-center justify-between gap-3 rounded-lg border border-line bg-bg px-3 py-2 text-caption">
                <span>Private</span>
                <input type="checkbox" name="private" className="h-4 w-4 accent-accent" disabled={isPending} />
              </label>
            ) : null}
            <p className="rounded-lg border border-line bg-panel-soft px-3 py-2 text-caption text-text-muted">
              This task will be linked to the current Epic and inherit the Epic branch / commit prefix defaults.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={isPending}
                className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-body font-medium hover:border-accent disabled:cursor-wait disabled:opacity-70"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg hover:opacity-90 disabled:cursor-wait disabled:opacity-70"
              >
                {isPending ? "Adding…" : "Add task"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => canCreateTask && setOpen(true)}
        disabled={!canCreateTask}
        title={canCreateTask ? "Add task to epic" : disabledReason}
        aria-label={canCreateTask ? "Add task to epic" : disabledReason}
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-3xl leading-none text-bg shadow-lg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
