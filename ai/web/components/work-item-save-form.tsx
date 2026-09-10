"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import TaskDirtyGuard from "./task-dirty-guard";
import { EDITOR_SAVED_EVENT, snapshotEditor, sameEditorSnapshot } from "@/lib/client/editor-state";

export default function WorkItemSaveForm({ formId, kind, itemId }: { formId: string; kind: "task" | "epic"; itemId: string }) {
  const router = useRouter();
  const saving = useRef(false);
  const savedStatus = useRef<string | null>(null);
  useEffect(() => {
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (form) savedStatus.current = new FormData(form).get("status") as string | null;
  }, [formId]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const submitted = snapshotEditor(data);
    const submittedStatus = data.get("status") as string | null;
    // A workflow may move the record while an editor tab is open. Saving a
    // title/description must not move it back to the originally displayed status.
    if (submittedStatus === savedStatus.current) data.set("status", "");
    saving.current = true; setPending(true); setMessage(""); setFailed(false);
    try {
      const response = await fetch(`/api/work-items/${kind}/${encodeURIComponent(itemId)}/save`, {
        method: "POST", body: data, headers: { "X-PM-Editor": "1" },
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.error || "Save failed. Your edits are still here; please try again.");
      savedStatus.current = submittedStatus;
      form.dispatchEvent(new CustomEvent(EDITOR_SAVED_EVENT, { detail: submitted }));
      const unchanged = sameEditorSnapshot(submitted, snapshotEditor(new FormData(form)));
      setMessage(unchanged ? "Saved" : "Saved. Newer edits still need saving.");
      // Do not replace a newer local edit with the submitted server version.
      if (unchanged) router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Save failed. Your edits are still here.");
    } finally { saving.current = false; setPending(false); }
  }
  return <TaskDirtyGuard formId={formId}>
    <form id={formId} onSubmit={submit} className="flex max-w-md flex-wrap items-center justify-end gap-2" aria-busy={pending}>
      <button type="submit" disabled={pending} className="h-9 rounded-lg bg-accent px-3 text-body font-medium text-bg hover:opacity-90 disabled:opacity-50">{pending ? "Saving…" : "Save changes"}</button>
      {message && <span role={failed ? "alert" : "status"} className={failed ? "text-caption text-red-500" : "text-caption text-text-muted"}>{message}</span>}
    </form>
  </TaskDirtyGuard>;
}
