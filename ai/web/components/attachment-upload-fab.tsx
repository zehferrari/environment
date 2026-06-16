"use client";

import { useState } from "react";

export default function AttachmentUploadFab({
  projectSlug,
  taskId,
  epicId,
  maxLabel,
  uploadAction,
}: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  maxLabel: string;
  uploadAction: (formData: FormData) => Promise<void>;
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
            action={uploadAction}
            encType="multipart/form-data"
            onSubmit={() => setOpen(false)}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md space-y-4 rounded-2xl border border-line bg-panel p-5 shadow-2xl"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
            {epicId ? <input type="hidden" name="epicId" value={epicId} /> : null}
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                  Add attachments
                </div>
                <p className="mt-1 text-xs text-text-muted">
                  Max {maxLabel} per file. You can select multiple files.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-lg leading-none text-text-muted hover:text-text"
              >
                ×
              </button>
            </div>
            <input
              type="file"
              name="files"
              multiple
              required
              className="w-full rounded-lg border border-dashed border-line bg-bg px-3 py-6 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-bg hover:file:opacity-90"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line bg-panel-soft px-3 py-1.5 text-sm font-medium hover:border-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:opacity-90"
              >
                Upload files
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add attachment"
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-3xl leading-none text-bg shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
