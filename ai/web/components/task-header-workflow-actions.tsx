"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ConfirmPopup from "@/components/confirm-popup";
import { useToast } from "@/components/toast";
import { performTaskCommentWorkflowAction } from "@/lib/create/actions";

type HeaderAction = "cancel" | "accept";

export default function TaskHeaderWorkflowActions({
  taskId,
  projectSlug,
  canCancel,
  canAccept,
}: {
  taskId: string;
  projectSlug: string;
  canCancel: boolean;
  canAccept: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<HeaderAction | null>(null);
  if (!canCancel && !canAccept) return null;

  const confirmation = action === "cancel"
    ? {
        title: "Suspend work?",
        description: "This will stop the active workflow, preserve the assignee and worktree, and move the task to Backlog.",
        label: "Yes, suspend work",
        body: "Work was suspended from the task header.",
        danger: true,
      }
    : {
        title: "Accept this review?",
        description: "Repository finalization will begin. The task reaches Done only after finalization succeeds.",
        label: "Yes, accept review",
        body: "The reviewer marked this task as complete from the task header.",
        danger: false,
      };

  const confirm = () => {
    const selected = action;
    if (!selected) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("taskId", taskId);
      formData.set("projectSlug", projectSlug);
      formData.set("workflowAction", selected);
      formData.set("body", confirmation.body);
      const result = await performTaskCommentWorkflowAction(formData);
      setAction(null);
      if (result.ok) {
        toast.show({ message: result.message, href: result.href, linkLabel: "Open" });
        router.refresh();
      } else {
        toast.show({ message: result.error });
      }
    });
  };

  return (
    <>
      {canCancel ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setAction("cancel")}
          className="h-9 shrink-0 rounded-lg border border-warn/50 px-3 text-caption font-semibold text-warn transition hover:bg-warn/10 disabled:opacity-45"
        >
          Suspend Work
        </button>
      ) : null}
      {canAccept ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => setAction("accept")}
          className="h-9 shrink-0 rounded-lg border border-ok/50 px-3 text-caption font-semibold text-ok transition hover:bg-ok/10 disabled:opacity-45"
        >
          Task is Complete
        </button>
      ) : null}
      <ConfirmPopup
        open={Boolean(action)}
        title={confirmation.title}
        description={confirmation.description}
        confirmLabel={confirmation.label}
        cancelLabel="No"
        danger={confirmation.danger}
        busy={pending}
        onConfirm={confirm}
        onCancel={() => setAction(null)}
      />
    </>
  );
}
