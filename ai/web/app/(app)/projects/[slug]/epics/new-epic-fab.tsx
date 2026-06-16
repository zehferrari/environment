"use client";

import { useState } from "react";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";

type Principal = {
  id: string;
  username: string;
  name: string;
  kind: string;
  avatarUpdatedAt?: string | Date | null;
  agentSlug?: string | null;
  agentAvatar?: string | null;
};

// Floating "+" button + modal for creating an epic. Title is the only
// mandatory field; description, acting manager and assignee are optional
// (HOMELAB-41). createEpic redirects into the new epic on success, so the
// modal simply unmounts on navigation.
export default function NewEpicFab({
  projectSlug,
  principals,
  createEpicAction,
}: {
  projectSlug: string;
  principals: Principal[];
  createEpicAction: (formData: FormData) => Promise<void>;
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
  const workerOptions = principalOptions.filter((option) => option.actor?.kind === "agent");

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card"
          onClick={() => setOpen(false)}
        >
          <form
            id="newEpicForm"
            action={createEpicAction}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg space-y-3 rounded-panel border border-line bg-panel p-card-lg shadow-2xl"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <div className="flex items-center justify-between">
              <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                New epic
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
              placeholder="Epic title"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent"
            />
            <textarea
              name="description"
              rows={8}
              placeholder="Description (optional) — markdown supported"
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body leading-relaxed outline-none focus:border-accent"
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-caption">
                <span className="mb-1 block text-text-muted">
                  Branch
                </span>
                <input
                  name="branchName"
                  maxLength={200}
                  placeholder="feature/HOMELAB-99"
                  className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 font-mono text-caption outline-none focus:border-accent"
                />
              </label>
              <label className="text-caption">
                <span className="mb-1 block text-text-muted">
                  Commit prefix
                </span>
                <input
                  name="commitPrefix"
                  maxLength={200}
                  placeholder="HOMELAB-99"
                  className="w-full rounded-lg border border-line bg-bg px-2 py-1.5 font-mono text-caption outline-none focus:border-accent"
                />
              </label>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="text-caption">
                <span className="mb-1 block text-text-muted">
                  Worker pool
                </span>
                <AvatarCombobox
                  formId="newEpicForm"
                  name="assigneeId"
                  defaultValues={[]}
                  options={workerOptions}
                  emptyLabel="No workers"
                  ariaLabel="Worker pool"
                  multiple
                />
              </label>
              <label className="text-caption">
                <span className="mb-1 block text-text-muted">
                  Acting manager
                </span>
                <AvatarCombobox
                  formId="newEpicForm"
                  name="actingManagerId"
                  defaultValue=""
                  options={principalOptions}
                  emptyLabel="No acting manager"
                  ariaLabel="Acting manager"
                />
              </label>
            </div>

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
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-3xl leading-none text-bg shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
