"use client";

import React, { useState } from "react";
import { Button, Surface } from "@/components/ui/primitives";

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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <Surface
            as="form"
            action={uploadAction}
            encType="multipart/form-data"
            onSubmit={() => setOpen(false)}
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
            elevated
            padding="lg"
            className="w-full max-w-md space-y-section-gap"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
            {epicId ? <input type="hidden" name="epicId" value={epicId} /> : null}
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                  Add attachments
                </div>
                <p className="mt-1 text-caption text-text-muted">
                  Max {maxLabel} per file. You can select multiple files.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                variant="icon"
                size="icon"
              >
                ×
              </Button>
            </div>
            <input
              type="file"
              name="files"
              multiple
              required
              className="w-full rounded-lg border border-dashed border-line bg-bg px-3 py-6 text-body file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-caption file:font-medium file:text-bg hover:file:opacity-90"
            />
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setOpen(false)} variant="ghost">
                Cancel
              </Button>
              <Button type="submit" variant="primary">
                Upload files
              </Button>
            </div>
          </Surface>
        </div>
      ) : null}

      <Button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Add attachment"
        variant="primary"
        className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full p-0 text-3xl leading-none shadow-lg"
      >
        <span className="-mt-0.5">+</span>
      </Button>
    </>
  );
}
