"use client";

import { useState } from "react";

type Principal = { id: string; name: string };

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

// Floating "+" button + modal for creating a project. Mirrors the New Task /
// New Epic modals (HOMELAB-41) but the fields are the project's own settings
// (repo path, project key, git identity, picker defaults, auto archive age).
export default function AddProjectFab({
  principals,
  createProjectAction,
}: {
  principals: Principal[];
  createProjectAction: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [key, setKey] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [keyTouched, setKeyTouched] = useState(false);

  const labelCls =
    "mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]";
  const inputCls =
    "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]";

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <form
            action={createProjectAction}
            onSubmit={() => setOpen(false)}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                New project
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
                  placeholder="patricia"
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
                  placeholder="PH"
                  className={`${inputCls} font-mono`}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Repository folder</span>
                <input
                  name="repositoryPath"
                  required
                  placeholder="/srv/Code/environment"
                  className={`${inputCls} font-mono`}
                />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>Default git user</span>
                <input
                  name="defaultGitUserName"
                  placeholder="Zeh Ferrari"
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className={labelCls}>Default git email</span>
                <input
                  type="email"
                  name="defaultGitUserEmail"
                  placeholder="e@zeh.me"
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
                className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Create project
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add project"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-3xl leading-none text-[var(--color-bg)] shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
