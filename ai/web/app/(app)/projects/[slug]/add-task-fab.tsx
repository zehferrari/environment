"use client";

import { useState } from "react";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import PrivateToggle from "@/components/private-toggle";

type Principal = {
  id: string;
  username: string;
  name: string;
  kind: string;
  avatarUpdatedAt?: string | Date | null;
  agentSlug?: string | null;
  agentAvatar?: string | null;
};
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
  canManageAssignments = false,
  canSetPrivate = false,
  createTaskAction,
}: {
  projectId: string;
  projectSlug: string;
  principals: Principal[];
  epics: EpicOption[];
  defaultAssigneeId: string | null;
  defaultReviewerId: string | null;
  canManageAssignments?: boolean;
  canSetPrivate?: boolean;
  createTaskAction: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const principalOptions: AvatarComboboxOption[] = principals.map((p) => ({
    value: p.id,
    label: p.name,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt ?? null,
      agent: p.kind === "agent"
        ? { slug: p.agentSlug ?? null, name: p.name, avatar: p.agentAvatar ?? null }
        : null,
    },
  }));

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-card"
          onClick={() => setOpen(false)}
        >
          <form
            id="newTaskForm"
            action={createTaskAction}
            onSubmit={() => setOpen(false)}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[calc(100vh-2rem)] w-full max-w-lg space-y-3 overflow-y-auto rounded-panel border border-line bg-panel p-card-lg shadow-2xl"
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <div className="flex items-center justify-between">
              <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                New task
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

            <input
              name="title"
              required
              autoFocus
              maxLength={200}
              placeholder="Task title"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent"
            />
            <textarea
              name="description"
              rows={6}
              placeholder="Description (optional) — markdown supported"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body leading-relaxed outline-none focus:border-accent"
            />

            {canSetPrivate ? (
              <PrivateToggle />
            ) : null}

            <label className="block text-caption">
              <span className="mb-1 block text-text-muted">
                Epic
              </span>
              <select
                name="epicId"
                defaultValue=""
                className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 text-caption outline-none focus:border-accent"
              >
                <option value="">No epic</option>
                {epics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                  </option>
                ))}
              </select>
            </label>

            {canManageAssignments ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-caption">
                  <span className="mb-1 block text-text-muted">
                    Assignee
                  </span>
                  <AvatarCombobox
                    formId="newTaskForm"
                    name="assigneeId"
                    defaultValue={defaultAssigneeId ?? ""}
                    options={principalOptions}
                    emptyLabel="Unassigned"
                    ariaLabel="Assignee"
                  />
                </label>
                <label className="text-caption">
                  <span className="mb-1 block text-text-muted">
                    Reviewer
                  </span>
                  <AvatarCombobox
                    formId="newTaskForm"
                    name="actingManagerId"
                    defaultValue={defaultReviewerId ?? ""}
                    options={principalOptions}
                    emptyLabel="No reviewer"
                    ariaLabel="Reviewer"
                  />
                </label>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-body font-medium hover:border-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg hover:opacity-90"
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
        className="fixed bottom-[calc(6.25rem+env(safe-area-inset-bottom))] right-4 z-40 flex h-14 items-center justify-center gap-2 rounded-2xl bg-accent px-4 text-bg shadow-[var(--shadow-float)] transition-[transform,background-color,box-shadow] hover:-translate-y-0.5 hover:bg-accent-strong md:bottom-6 md:right-6 md:h-12"
      >
        <span className="text-2xl leading-none" aria-hidden="true">+</span>
        <span className="text-body font-semibold">New task</span>
      </button>
    </>
  );
}
