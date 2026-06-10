"use client";

import { useMemo, useState, useTransition } from "react";

type ProfileFile = {
  file: string;
  content: string;
  sha: string;
  bytes: number;
  modifiedAt: string | null;
  symlinkTarget?: string | null;
};

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "ok"; message: string } | { kind: "error"; message: string };

function diffLines(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const max = Math.max(a.length, b.length);
  const out: string[] = [];
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) continue;
    if (out.length === 0) out.push(`@@ line ${i + 1} @@`);
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    if (out.join("\n").length > 3000) {
      out.push("… diff preview truncated …");
      break;
    }
  }
  return out.join("\n");
}

export default function ProfileEditor({ agent, files, canEdit }: { agent: string; files: ProfileFile[]; canEdit: boolean }) {
  const [items, setItems] = useState(files);
  const [active, setActive] = useState(files[0]?.file ?? "SOUL.md");
  const [draft, setDraft] = useState(files[0]?.content ?? "");
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const current = items.find((f) => f.file === active) ?? items[0];
  const changed = Boolean(current && draft !== current.content);
  const preview = useMemo(() => (current ? diffLines(current.content, draft) : ""), [current, draft]);

  function switchFile(file: string) {
    const next = items.find((f) => f.file === file);
    if (!next) return;
    setActive(file);
    setDraft(next.content);
    setState({ kind: "idle" });
  }

  function reload() {
    if (!current) return;
    startTransition(async () => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/profile/${encodeURIComponent(current.file)}`, { cache: "no-store" });
      if (!res.ok) {
        setState({ kind: "error", message: `Reload failed (${res.status})` });
        return;
      }
      const fresh = (await res.json()) as ProfileFile;
      setItems((old) => old.map((f) => (f.file === fresh.file ? fresh : f)));
      setDraft(fresh.content);
      setState({ kind: "ok", message: "Reloaded from disk" });
    });
  }

  function save() {
    if (!current || !canEdit) return;
    setState({ kind: "saving" });
    startTransition(async () => {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/profile/${encodeURIComponent(current.file)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft, sha: current.sha }),
      });
      if (res.status === 412) {
        setState({ kind: "error", message: "File changed elsewhere. Reload before saving." });
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setState({ kind: "error", message: body.error ?? `Save failed (${res.status})` });
        return;
      }
      const fresh = (await res.json()) as ProfileFile;
      setItems((old) => old.map((f) => (f.file === fresh.file ? fresh : f)));
      setDraft(fresh.content);
      setState({ kind: "ok", message: "Saved and audited" });
    });
  }

  if (!current) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-[180px_minmax(0,1fr)]">
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-2">
        {items.map((f) => (
          <button
            key={f.file}
            type="button"
            onClick={() => switchFile(f.file)}
            className={`block w-full rounded-lg px-3 py-2 text-left font-mono text-xs ${f.file === active ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-soft)]"}`}
          >
            {f.file}
          </button>
        ))}
      </div>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          <span><strong className="text-[var(--color-text)]">{current.file}</strong> · {current.bytes} bytes · sha {current.sha.slice(0, 12)}</span>
          <span>{current.modifiedAt ? new Date(current.modifiedAt).toLocaleString() : "not on disk yet"}</span>
        </div>
        {current.symlinkTarget ? (
          <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
            Shared file: <code>{current.symlinkTarget}</code>
          </div>
        ) : null}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          readOnly={!canEdit}
          rows={24}
          className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)] disabled:opacity-70"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={save} disabled={!canEdit || !changed || pending} className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">Save</button>
          <button type="button" onClick={reload} disabled={pending} className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm hover:border-[var(--color-accent)]">Reload</button>
          {!canEdit ? <span className="text-xs text-[var(--color-warn)]">Read-only: agents can edit only themselves; zeh can edit all.</span> : null}
          {state.kind !== "idle" ? <span className={`text-xs ${state.kind === "error" ? "text-[var(--color-crit)]" : "text-[var(--color-text-muted)]"}`}>{state.kind === "saving" ? "Saving…" : state.message}</span> : null}
        </div>
        <details className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-3" open={changed}>
          <summary className="cursor-pointer text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Diff preview</summary>
          <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--color-bg)] p-3 text-xs">{preview || "No changes"}</pre>
        </details>
      </div>
    </div>
  );
}
