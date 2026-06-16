"use client";

// Reusable confirmation popup — visual + interaction model matches
// components/new-chat-button.tsx (the "Move Current Chat to Bin" step).
// Replaces native browser window.confirm() across the app so every
// confirm-before-destructive-action prompt has the same look + feel.
//
// Usage (controlled):
//
//   const [open, setOpen] = useState(false);
//
//   <button onClick={() => setOpen(true)}>Delete</button>
//   <ConfirmPopup
//     open={open}
//     title="Move comment to bin"
//     description="The comment will be hidden from view and excluded
//                  from agent context."
//     confirmLabel="Delete comment"
//     danger
//     busy={isPending}
//     onConfirm={() => { /* do the work */ }}
//     onCancel={() => setOpen(false)}
//   />

import { useEffect } from "react";
import { Button, Surface } from "@/components/ui/primitives";

export interface ConfirmPopupProps {
  open: boolean;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red accent on the confirm button — use for destructive actions. */
  danger?: boolean;
  /** While true, both buttons are disabled and the confirm button shows a spinner. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmPopup({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmPopupProps) {
  // Escape-to-cancel — matches what users expect of a native dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-card backdrop-blur-sm transition-all duration-300"
      onClick={() => !busy && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-popup-title"
    >
      <Surface
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
        elevated
        className="w-full max-w-md space-y-section-gap p-6 animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between">
          <h3
            id="confirm-popup-title"
            className={`text-body font-semibold uppercase tracking-wider ${danger ? "text-crit" : "text-text-muted"}`}
          >
            {title}
          </h3>
          <Button
            type="button"
            disabled={busy}
            onClick={onCancel}
            aria-label="Close"
            variant="icon"
            size="icon"
          >
            &times;
          </Button>
        </div>
        {description ? (
          <div className="text-body text-text-muted leading-relaxed">
            {description}
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-2">
          <Button
            type="button"
            disabled={busy}
            onClick={onCancel}
            variant="ghost"
            size="sm"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            variant={danger ? "danger" : "primary"}
            size="sm"
            className="px-4 py-1.5"
          >
            {busy ? (
              <>
                <svg
                  className="animate-spin h-3 w-3 text-current"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Working…
              </>
            ) : (
              confirmLabel
            )}
          </Button>
        </div>
      </Surface>
    </div>
  );
}
