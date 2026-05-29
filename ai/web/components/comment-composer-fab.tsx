"use client";

import { useState } from "react";
import MaximizableTextarea from "@/components/maximizable-textarea";

export default function CommentComposerFab({
  projectSlug,
  taskId,
  epicId,
  action,
  title,
  placeholder,
}: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  action: (formData: FormData) => Promise<void>;
  title: string;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const canSubmit = body.trim().length > 0;

  const submit = async (formData: FormData) => {
    await action(formData);
    setBody("");
    setOpen(false);
  };

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/10 p-4 backdrop-blur-[1px]"
          onClick={() => setOpen(false)}
        >
          <form
            action={submit}
            onClick={(event) => event.stopPropagation()}
            className="absolute bottom-24 right-4 w-[calc(100vw-2rem)] max-w-xl space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-2xl sm:right-6"
          >
            {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
            {epicId ? <input type="hidden" name="epicId" value={epicId} /> : null}
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {title}
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Markdown and mentions are supported.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close comment composer"
                className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
              >
                &times;
              </button>
            </div>
            <MaximizableTextarea
              name="body"
              required
              rows={4}
              value={body}
              onValueChange={setBody}
              placeholder={placeholder}
              expandedTitle={title}
              className="w-full resize-none rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!canSubmit}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Add comment
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add comment"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-3xl leading-none text-[var(--color-bg)] shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
