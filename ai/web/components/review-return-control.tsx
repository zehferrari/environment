"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import ConfirmPopup from "@/components/confirm-popup";

export default function ReviewReturnControl({
  action,
  taskId,
  reviewRunId,
  accepted,
}: {
  action: (formData: FormData) => Promise<void>;
  taskId: string;
  reviewRunId: string;
  accepted: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const reviewerComment = feedback.trim();
    if (!reviewerComment) {
      setError("Add feedback so the assignee knows what to do next.");
      return;
    }
    const formData = new FormData();
    formData.set("taskId", taskId);
    formData.set("reviewRunId", reviewRunId);
    formData.set("reviewerComment", reviewerComment);
    setError(null);
    startTransition(async () => {
      try {
        await action(formData);
        setOpen(false);
        setFeedback("");
        router.refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not return the task to To Do.");
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-caption font-semibold text-amber-700 transition hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-300"
      >
        Request changes → To Do
      </button>
      <ConfirmPopup
        open={open}
        title={accepted ? "Revoke acceptance and return to To Do?" : "Return task to To Do?"}
        confirmLabel={accepted ? "Revoke and return" : "Request changes"}
        danger={accepted}
        busy={pending}
        onConfirm={submit}
        onCancel={() => {
          if (!pending) {
            setOpen(false);
            setError(null);
          }
        }}
        description={(
          <div className="space-y-3">
            <p>
              {accepted
                ? "This records a newer reviewer decision and retires the current finalization."
                : "This records review feedback and closes the current implementation cycle."}
              {" "}The assignee, branch, and worktree are preserved; PM moves the task to the front of To Do and asks the assignee to restart from your feedback.
            </p>
            <label className="block">
              <span className="mb-1 block text-micro font-semibold uppercase tracking-wider text-text-muted">
                Required feedback
              </span>
              <textarea
                value={feedback}
                onChange={(event) => {
                  setFeedback(event.target.value);
                  if (error) setError(null);
                }}
                rows={4}
                maxLength={16_000}
                disabled={pending}
                placeholder="Explain what the assignee should change or continue…"
                className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-body text-text outline-none focus:border-accent"
              />
            </label>
            {error ? <p className="text-caption text-crit">{error}</p> : null}
          </div>
        )}
      />
    </>
  );
}
