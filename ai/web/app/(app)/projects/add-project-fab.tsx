"use client";

import { useActionState, useEffect, useState } from "react";

type Principal = { id: string; name: string };
type Workspace = { id: string; name: string };

export type CreateProjectState = {
  ok: boolean;
  error: string | null;
};

const initialState: CreateProjectState = { ok: false, error: null };

function slugFromName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function keyFromName(value: string) {
  const tokens = value.match(/[A-Za-z][A-Za-z0-9]*/g) ?? [];
  const candidate = tokens.length === 1
    ? tokens[0]!.slice(0, 3)
    : tokens.map((token) => token[0]).join("").slice(0, 4);
  const key = candidate.toUpperCase();
  return /^[A-Z][A-Z0-9]{1,9}$/.test(key) ? key : "";
}

// Project creation modal. The visible trigger lives in the dashboard header
// so owners do not need to discover a floating action button.
export default function AddProjectFab({
  principals,
  workspaces,
  createProjectAction,
}: {
  principals: Principal[];
  workspaces: Workspace[];
  createProjectAction: (state: CreateProjectState, formData: FormData) => Promise<CreateProjectState>;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(createProjectAction, initialState);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [key, setKey] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("newProject") !== "1") return;
    setOpen(true);
    params.delete("newProject");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }, []);

  const labelCls =
    "mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted";
  const inputCls =
    "w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent";

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card"
          onClick={() => setOpen(false)}
        >
          <form
            action={formAction}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-panel border border-line bg-panel p-card-lg shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                New project
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
              <p role="alert" className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-body text-crit">
                {state.error}
              </p>
            ) : null}

            <label className="block">
              <span className={labelCls}>Name</span>
              <input
                name="name"
                required
                maxLength={200}
                autoFocus
                placeholder="Project name"
                value={name}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setName(next);
                  if (!slugTouched) setSlug(slugFromName(next));
                  if (!keyTouched) setKey(keyFromName(next));
                }}
                className={inputCls}
              />
            </label>

            <label className="block">
              <span className={labelCls}>Description</span>
              <textarea
                name="description"
                rows={2}
                placeholder="Optional"
                className={inputCls}
              />
            </label>

            {workspaces.length === 1 ? (
              <input type="hidden" name="workspaceId" value={workspaces[0]!.id} />
            ) : workspaces.length > 1 ? (
              <label className="block">
                <span className={labelCls}>Workspace</span>
                <select name="workspaceId" required defaultValue={workspaces[0]!.id} className={inputCls}>
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-caption text-amber-700">
                Create an active workspace before adding a project.
              </p>
            )}

            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[35fr_15fr_50fr]">
              <label className="block">
                <span className={labelCls}>Project slug</span>
                <input
                  name="slug"
                  required
                  value={slug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setSlug(event.currentTarget.value.toLowerCase());
                  }}
                  pattern="[a-zA-Z0-9\-_]+"
                  title="Only letters, numbers, hyphens, and underscores are allowed"
                  placeholder="my-project"
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Project key</span>
                <input
                  name="workItemKeyPrefix"
                  required
                  value={key}
                  onChange={(event) => {
                    setKeyTouched(true);
                    setKey(event.currentTarget.value.toUpperCase());
                  }}
                  pattern="[a-zA-Z][a-zA-Z0-9]{1,9}"
                  title="Start with a letter; use 2-10 letters or numbers"
                  placeholder="PRJ"
                  className={`${inputCls} font-mono`}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Repository folder</span>
                <input
                  name="repositoryPath"
                  required
                  placeholder="/path/to/repository"
                  className={`${inputCls} font-mono`}
                />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>Default git user</span>
                <input
                  name="defaultGitUserName"
                  placeholder="Your Name"
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Default git email</span>
                <input
                  type="email"
                  name="defaultGitUserEmail"
                  placeholder="you@example.com"
                  className={inputCls}
                />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>Default assignee</span>
                <select name="defaultAssigneeId" defaultValue="" className={inputCls}>
                  <option value="">None</option>
                  {principals.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={labelCls}>Default reviewer</span>
                <select name="defaultReviewerId" defaultValue="" className={inputCls}>
                  <option value="">None</option>
                  {principals.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="block">
              <span className={labelCls}>Automatic Archive (days)</span>
              <input
                type="number"
                name="doneTtlDays"
                min={1}
                max={365}
                placeholder="Leave blank for the system default"
                className={inputCls}
              />
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={isPending}
                className="rounded-lg border border-line px-control-x py-control-y text-body font-medium text-text-muted hover:text-text"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending || workspaces.length === 0}
                className="rounded-lg bg-accent px-4 py-1.5 text-body font-medium text-bg hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {isPending ? "Creating..." : "Create project"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-accent px-control-x py-control-y text-caption font-semibold text-white shadow-sm hover:opacity-90"
      >
        <span aria-hidden="true" className="text-lg leading-none">+</span>
        <span>New project</span>
      </button>
    </>
  );
}
