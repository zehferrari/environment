"use client";

import React, { useEffect, useRef, useState } from "react";
import MaximizableTextarea from "@/components/maximizable-textarea";
import { Button, Surface } from "@/components/ui/primitives";

export default function CommentComposerFab({
  projectSlug,
  taskId,
  epicId,
  action,
  title,
  placeholder,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  action: (formData: FormData) => Promise<void>;
  title: string;
  placeholder: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [body, setBody] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const canSubmit = body.trim().length > 0;

  // Focus the textarea whenever the composer opens (the (+) button) so the user
  // can type straight away — matching the chat / action-plan composers.
  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [open]);

  const submit = async (formData: FormData) => {
    await action(formData);
    setBody("");
    setOpen(false);
  };

  return (
    <>
      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/10 p-card backdrop-blur-[1px]"
          onClick={() => setOpen(false)}
        >
          <Surface
            as="form"
            action={submit}
            onClick={(event: React.MouseEvent) => event.stopPropagation()}
            elevated
            className="absolute bottom-24 right-4 w-[calc(100vw-2rem)] max-w-xl space-y-3 sm:right-6"
          >
            {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
            {epicId ? <input type="hidden" name="epicId" value={epicId} /> : null}
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                  {title}
                </div>
                <p className="mt-1 text-caption text-text-muted">
                  Markdown and mentions are supported.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close comment composer"
                variant="icon"
                size="icon"
              >
                &times;
              </Button>
            </div>
            <MaximizableTextarea
              ref={textareaRef}
              name="body"
              required
              rows={4}
              value={body}
              onValueChange={setBody}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  if (canSubmit) event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder={placeholder}
              expandedTitle={title}
              className="w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 text-body outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                onClick={() => setOpen(false)}
                variant="ghost"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!canSubmit}
                variant="primary"
              >
                Add comment
              </Button>
            </div>
          </Surface>
        </div>
      ) : null}

      {!hideTrigger ? (
        <Button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Add comment"
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
