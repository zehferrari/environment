"use client";

import React, { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button, Surface } from "@/components/ui/primitives";

type UploadState = { ok: boolean; error: string | null };

export type AttachmentUploadTarget = {
  value: "task" | "epic" | "project";
  label: string;
  taskId?: string;
  epicId?: string;
};

const IDLE_STATE: UploadState = { ok: false, error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" disabled={pending}>
      {pending ? "Uploading…" : "Upload files"}
    </Button>
  );
}

export default function AttachmentUploadFab({
  projectSlug,
  taskId,
  epicId,
  maxLabel,
  uploadAction,
  targets: targetOptions,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  maxLabel: string;
  uploadAction: (formData: FormData) => Promise<void>;
  targets?: AttachmentUploadTarget[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selectedTargetValue, setSelectedTargetValue] = useState<AttachmentUploadTarget["value"]>(
    targetOptions?.[0]?.value ?? (taskId ? "task" : epicId ? "epic" : "project"),
  );
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (next) setUploadError(null);
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const targets: AttachmentUploadTarget[] = targetOptions?.length
    ? targetOptions
    : taskId
      ? [{ value: "task", label: "Current task", taskId }]
      : epicId
        ? [{ value: "epic", label: "Current epic", epicId }]
        : [{ value: "project", label: "Current project" }];
  const selectedTarget = targets.find((target) => target.value === selectedTargetValue) ?? targets[0]!;
  const defaultTargetValue = targets[0]!.value;

  useEffect(() => {
    if (!open) return;
    setUploadError(null);
    setSelectedTargetValue(defaultTargetValue);
  }, [defaultTargetValue, open]);

  const [, formAction] = useActionState<UploadState, FormData>(
    async (_prev, formData) => {
      setUploadError(null);
      try {
        await uploadAction(formData);
        if (controlledOpen === undefined) setInternalOpen(false);
        onOpenChange?.(false);
        return { ok: true, error: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed";
        setUploadError(message);
        return {
          ok: false,
          error: message,
        };
      }
    },
    IDLE_STATE,
  );

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <Surface
            as="form"
            action={formAction}
            encType="multipart/form-data"
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
            elevated
            padding="lg"
            className="w-full max-w-md space-y-section-gap"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            {selectedTarget.taskId ? <input type="hidden" name="taskId" value={selectedTarget.taskId} /> : null}
            {selectedTarget.epicId ? <input type="hidden" name="epicId" value={selectedTarget.epicId} /> : null}
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
            {targets.length > 1 ? (
              <label className="block text-caption">
                <span className="mb-1 block font-semibold text-text-muted">Attach to</span>
                <select
                  value={selectedTarget.value}
                  onChange={(event) => setSelectedTargetValue(event.currentTarget.value as AttachmentUploadTarget["value"])}
                  className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent"
                  aria-label="Attachment destination"
                >
                  {targets.map((target) => (
                    <option key={target.value} value={target.value}>{target.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            <input
              type="file"
              name="files"
              multiple
              required
              className="w-full rounded-lg border border-dashed border-line bg-bg px-3 py-6 text-body file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-caption file:font-medium file:text-bg hover:file:opacity-90"
            />
            {uploadError ? (
              <p
                role="alert"
                className="rounded-lg border border-crit/40 bg-crit/10 px-3 py-2 text-caption text-crit"
              >
                {uploadError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" onClick={() => setOpen(false)} variant="ghost">
                Cancel
              </Button>
              <SubmitButton />
            </div>
          </Surface>
        </div>
      ) : null}

      {!hideTrigger ? (
        <Button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Add attachment"
          data-task-local-fab
          variant="primary"
          className="fixed bottom-6 right-6 z-40 h-14 w-14 rounded-full p-0 text-3xl leading-none shadow-lg"
        >
          <span className="-mt-0.5">+</span>
        </Button>
      ) : null}
    </>
  );
}
