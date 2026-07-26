"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendAgentChatMessage } from "@/lib/agents/chat/actions";
import { generateClientMessageId } from "@/lib/agents/ops/client-message-id";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";

// A per-commit "chat with an agent about this change" trigger + popup, rendered
// before each commit hash in the Changes tab. It seeds the first message with
// the commit prefix + "based on the changes done in this commit <hash>, ..." so
// the agent has the exact commit to inspect, then dispatches via the same
// task/epic-scoped chat action the AI-description/plan prompts use.
export default function CommitChatPopup({
  projectSlug,
  taskId,
  epicId,
  commitPrefix,
  commitShortHash,
  commitSubject,
  aiTargets,
  defaultAiTarget,
}: {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  commitPrefix: string | null;
  commitShortHash: string;
  commitSubject: string;
  aiTargets: AvatarComboboxOption[];
  defaultAiTarget: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const prefixPart = commitPrefix ? `${commitPrefix} ` : "";
  const [prompt, setPrompt] = useState(
    `${prefixPart}based on the changes done in this commit ${commitShortHash}, `,
  );
  const formId = `commit-chat-${commitShortHash}`;
  const selectedTarget = defaultAiTarget || aiTargets[0]?.value || "";

  const submitPrompt = async (formData: FormData) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      formData.set("messageId", generateClientMessageId());
      await sendAgentChatMessage(formData);
      setOpen(false);
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        disabled={aiTargets.length === 0}
        onClick={() => setOpen(true)}
        aria-label={`Chat with an agent about commit ${commitShortHash}`}
        title="Ask an agent about this commit"
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-text-muted transition hover:bg-accent/10 hover:text-accent disabled:hidden"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3.5 w-3.5"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </button>

      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/10 p-card backdrop-blur-[1px]"
          onClick={() => !isSubmitting && setOpen(false)}
        >
          <form
            id={formId}
            action={submitPrompt}
            onClick={(event) => event.stopPropagation()}
            className="absolute bottom-24 right-4 w-[calc(100vw-2rem)] max-w-xl space-y-section-gap rounded-panel border border-line bg-panel p-card shadow-2xl sm:right-6"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
            {epicId ? <input type="hidden" name="epicId" value={epicId} /> : null}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-micro font-semibold uppercase tracking-wider text-text-muted">
                  Ask about commit{" "}
                  <span className="font-mono text-accent">{commitShortHash}</span>
                </div>
                <p className="mt-1 truncate text-caption text-text-muted">{commitSubject}</p>
              </div>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setOpen(false)}
                aria-label="Close commit chat"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-heading leading-none text-text-muted transition hover:bg-panel-soft hover:text-text disabled:opacity-50"
              >
                &times;
              </button>
            </div>
            <label className="block space-y-1.5 text-caption font-medium text-text-muted">
              <span>Agent</span>
              <AvatarCombobox
                formId={formId}
                name="discussionTarget"
                defaultValue={selectedTarget}
                options={aiTargets}
                emptyLabel="Select an agent"
                ariaLabel="Commit chat agent"
              />
            </label>
            <label className="block space-y-1.5 text-caption font-medium text-text-muted">
              <span>Message</span>
              <textarea
                name="body"
                required
                rows={5}
                maxLength={8000}
                value={prompt}
                onChange={(event) => setPrompt(event.currentTarget.value)}
                className="w-full resize-none rounded-lg border border-line bg-bg px-3 py-2 text-body leading-relaxed text-text outline-none focus:border-accent"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setOpen(false)}
                className="rounded-lg border border-line bg-panel-soft px-control-x py-control-y text-body font-medium text-text-muted transition hover:border-accent hover:text-accent disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || prompt.trim().length === 0}
                className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isSubmitting ? "Sending..." : "Send"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
