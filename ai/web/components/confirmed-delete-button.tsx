"use client";

// Confirmed-delete button for soft-delete actions (HOMELAB-41 / item 2).
// Triggers <ConfirmPopup> on click; on confirm, invokes the supplied
// server action with FormData built from the supplied fields. Used by
// the task / epic comment lists, the task / epic Discussion bubbles,
// and the direct-agent-chat bubbles — every place where a single row
// can be soft-deleted by a human.
//
// Server actions can be passed across the server→client boundary as
// long as they're declared with the "use server" directive. The
// callers in this codebase (deleteComment in the task page,
// deleteChatMessage in lib/agents/chat-actions.ts,
// deleteDirectAgentMessage in lib/agents/direct-chat-actions.ts) all
// satisfy that.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ConfirmPopup from "@/components/confirm-popup";

export interface ConfirmedDeleteButtonProps {
  action: (formData: FormData) => Promise<void>;
  /** Field name → string value that should be on the submitted FormData. */
  fields: Record<string, string>;
  /** Visible button text. Defaults to "Delete". */
  label?: string;
  /** Title text shown on the popup. */
  title: string;
  /** Body text shown inside the popup. */
  description?: React.ReactNode;
  /** Label of the destructive confirm button inside the popup. */
  confirmLabel?: string;
  /** Visual / class overrides for the trigger button. */
  className?: string;
  /** Tooltip on the trigger button. */
  buttonTitle?: string;
  /** Aria-label on the trigger button. */
  ariaLabel?: string;
  /** Optional optimistic UI update after the server confirms deletion. */
  onSuccess?: () => void;
}

export default function ConfirmedDeleteButton({
  action,
  fields,
  label = "Delete",
  title,
  description,
  confirmLabel = "Delete",
  className,
  buttonTitle,
  ariaLabel,
  onSuccess,
}: ConfirmedDeleteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    const fd = new FormData();
    for (const [key, value] of Object.entries(fields)) fd.append(key, value);
    startTransition(async () => {
      try {
        await action(fd);
        onSuccess?.();
        // Some chat surfaces keep a client-side copy of their server-rendered
        // messages. Refresh after the mutation so those copies receive the
        // authoritative deletedAt/deletedBy values instead of leaving the
        // original bubble visible until a full page reload.
        router.refresh();
      } finally {
        setOpen(false);
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={isPending}
        className={
          className
            ?? "shrink-0 rounded px-1.5 py-0.5 text-micro font-medium text-text-muted hover:bg-crit hover:text-on-crit disabled:opacity-50 cursor-pointer"
        }
        title={buttonTitle ?? "Delete"}
        aria-label={ariaLabel ?? "Delete"}
      >
        {label}
      </button>
      <ConfirmPopup
        open={open}
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        danger
        busy={isPending}
        onConfirm={submit}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
