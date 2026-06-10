"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { sendAgentChatMessage } from "@/lib/agents/chat-actions";
import { generateClientMessageId } from "@/lib/agents/client-message-id";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";

export default function EpicTasksAiPrompt({
  projectSlug,
  epicId,
  epicTitle,
  aiTargets,
  defaultAiTarget,
  isAiRunning = false,
}: {
  projectSlug: string;
  epicId: string;
  epicTitle: string;
  aiTargets: AvatarComboboxOption[];
  defaultAiTarget: string;
  isAiRunning?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [prompt, setPrompt] = useState(
    `Please break the epic "${epicTitle}" into a practical set of implementation tasks. Use the current project and epic context, avoid duplicate work, and submit the task proposals for review.`,
  );
  const formId = `epic-task-ai-${epicId}`;
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
      <div className="mt-3 rounded-xl border border-dashed border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4 text-sm">
        <div className="font-semibold text-[var(--color-text)]">Plan tasks with AI</div>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">
          Ask an agent to use the Epic context and propose the first task breakdown.
        </p>
        {isAiRunning ? (
          <div className="mt-3 flex items-center gap-2 text-xs font-medium text-[var(--color-accent)]">
            <div className="h-4 w-4 rounded-full border-2 border-[var(--color-accent)]/20 border-t-[var(--color-accent)] animate-spin" />
            <span>Agent is planning tasks, please wait...</span>
          </div>
        ) : (
          <button
            type="button"
            disabled={aiTargets.length === 0}
            onClick={() => setOpen(true)}
            className="mt-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-45"
          >
            Ask AI to generate tasks
          </button>
        )}
      </div>

      {open ? (
        <div
          className="fixed inset-0 z-50 bg-black/10 p-4 backdrop-blur-[1px]"
          onClick={() => !isSubmitting && setOpen(false)}
        >
          <form
            id={formId}
            action={submitPrompt}
            onClick={(event) => event.stopPropagation()}
            className="absolute bottom-24 right-4 w-[calc(100vw-2rem)] max-w-xl space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-2xl sm:right-6"
          >
            <input type="hidden" name="projectSlug" value={projectSlug} />
            <input type="hidden" name="epicId" value={epicId} />
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Generate Epic tasks
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  The agent receives work-item proposal capability for this request.
                </p>
              </div>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setOpen(false)}
                aria-label="Close AI task prompt"
                className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)] disabled:opacity-50"
              >
                &times;
              </button>
            </div>
            <label className="block space-y-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              <span>Agent</span>
              <AvatarCombobox
                formId={formId}
                name="discussionTarget"
                defaultValue={selectedTarget}
                options={aiTargets}
                emptyLabel="Select an agent"
                ariaLabel="Task planning agent"
              />
            </label>
            <label className="block space-y-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              <span>Instruction</span>
              <textarea
                name="body"
                required
                rows={5}
                maxLength={8000}
                value={prompt}
                onChange={(event) => setPrompt(event.currentTarget.value)}
                className="w-full resize-none rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={isSubmitting}
                onClick={() => setOpen(false)}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || prompt.trim().length === 0}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isSubmitting ? "Sending..." : "Ask AI"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}
