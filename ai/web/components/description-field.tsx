"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sendAgentChatMessage } from "@/lib/agents/chat-actions";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";

// Description field for the task form. Shows the rendered-markdown
// preview by default with a pencil toggle beside the "Preview" label;
// the pencil swaps in a textarea for editing (and an eye toggles back).
//
// The textarea is ALWAYS mounted (just hidden in preview mode via a CSS
// class — display:none controls still submit) so the form's single
// "Save changes" button persists `description` regardless of which mode
// is showing. There is no separate save for the description.
//
// Initial mode derives purely from props (edit when empty, preview when
// there is content), so the server and client first render agree — no
// hydration mismatch.
export default function DescriptionField({
  previewHtml,
  defaultValue,
  rows,
  formId,
  projectSlug,
  taskId,
  epicId,
  aiTargets = [],
  defaultAiTarget = "",
  descriptionLabel = "Description",
}: {
  previewHtml: string;
  defaultValue: string;
  rows: number;
  // When set, the textarea is associated with that <form id> via the HTML
  // `form` attribute, so it submits through the task card's single Save
  // button even though the textarea lives in a separate tab panel.
  formId?: string;
  projectSlug?: string;
  taskId?: string;
  epicId?: string;
  aiTargets?: AvatarComboboxOption[];
  defaultAiTarget?: string;
  descriptionLabel?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(defaultValue.trim() === "");
  const [value, setValue] = useState(defaultValue);
  const [aiOpen, setAiOpen] = useState(false);
  const [improveText, setImproveText] = useState(true);
  const [improveFormatting, setImproveFormatting] = useState(true);
  const [aiSubmitting, setAiSubmitting] = useState(false);
  const aiFormId = `description-ai-${taskId ?? epicId ?? "scope"}`;
  const selectedAiTarget = defaultAiTarget || aiTargets[0]?.value || "";
  const aiAvailable = Boolean(projectSlug && (taskId || epicId) && aiTargets.length > 0);
  const hasUnsavedEdits = value !== defaultValue;
  const aiInstructionParts = [
    improveText ? "improve the wording, clarity, and completeness" : null,
    improveFormatting ? "improve the markdown structure and formatting" : null,
  ].filter(Boolean);
  const aiInstruction = aiInstructionParts.length > 0
    ? `Please update this ${descriptionLabel.toLowerCase()} description in place: ${aiInstructionParts.join(" and ")}. Preserve useful existing details and only change the description.`
    : "";

  useEffect(() => {
    setValue(defaultValue);
    setEditing(defaultValue.trim() === "");
  }, [defaultValue]);

  const submitAiPrompt = async (formData: FormData) => {
    if (aiSubmitting) return;
    setAiSubmitting(true);
    try {
      await sendAgentChatMessage(formData);
      setAiOpen(false);
      router.refresh();
    } finally {
      setAiSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          {editing ? "Edit" : "Preview"}
        </span>
        <div className="flex items-center gap-1">
          {aiAvailable ? (
            <button
              type="button"
              onClick={() => setAiOpen(true)}
              aria-label="Ask AI to update description"
              title="Ask AI to update description"
              className="rounded p-1 text-[var(--color-text-muted)] transition hover:text-[var(--color-accent)]"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3l1.7 5.2L19 10l-5.3 1.8L12 17l-1.7-5.2L5 10l5.3-1.8L12 3Z" />
                <path d="M5 3v4" />
                <path d="M3 5h4" />
                <path d="M19 17v4" />
                <path d="M17 19h4" />
              </svg>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setValue(defaultValue);
              setEditing(defaultValue.trim() === "");
            }}
            disabled={!hasUnsavedEdits}
            aria-label="Rollback unsaved description edits"
            title="Rollback unsaved description edits"
            className="rounded p-1 text-[var(--color-text-muted)] transition hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-35"
          >
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-pressed={editing}
            aria-label={editing ? "Show preview" : "Edit description"}
            title={editing ? "Show preview" : "Edit description"}
            className="rounded p-1 text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
          >
            {editing ? (
              // eye — back to preview
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            ) : (
              // pencil — edit the description
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Rendered preview — markdown is sanitized + rendered server-side
          and handed in as HTML. Hidden (not unmounted) while editing. */}
      <div
        className={`md ${editing ? "hidden" : ""}`}
        dangerouslySetInnerHTML={{ __html: previewHtml }}
      />

      {/* Editor — always in the DOM so the single Save button submits it. */}
      <textarea
        form={formId}
        name="description"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        rows={rows}
        placeholder="Add a description — markdown supported (headings, lists, code fences, tables)"
        className={`w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)] ${
          editing ? "" : "hidden"
        }`}
      />

      {aiOpen ? (
        <div
          className="fixed inset-0 z-50 bg-black/10 p-4 backdrop-blur-[1px]"
          onClick={() => !aiSubmitting && setAiOpen(false)}
        >
          <form
            id={aiFormId}
            action={submitAiPrompt}
            onClick={(event) => event.stopPropagation()}
            className="absolute bottom-24 right-4 w-[calc(100vw-2rem)] max-w-xl space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-2xl sm:right-6"
          >
            {projectSlug ? <input type="hidden" name="projectSlug" value={projectSlug} /> : null}
            {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
            {epicId ? <input type="hidden" name="epicId" value={epicId} /> : null}
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  AI description update
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Sends a discussion message with a one-shot description edit grant.
                </p>
              </div>
              <button
                type="button"
                disabled={aiSubmitting}
                onClick={() => setAiOpen(false)}
                aria-label="Close AI description prompt"
                className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)] disabled:opacity-50"
              >
                &times;
              </button>
            </div>
            <input type="hidden" name="body" value={aiInstruction} />
            <label className="flex items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm text-[var(--color-text)]">
              <input
                type="checkbox"
                name="improveText"
                checked={improveText}
                onChange={(event) => setImproveText(event.currentTarget.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>Improve Text</span>
            </label>
            <label className="flex items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm text-[var(--color-text)]">
              <input
                type="checkbox"
                name="improveFormatting"
                checked={improveFormatting}
                onChange={(event) => setImproveFormatting(event.currentTarget.checked)}
                className="h-4 w-4 accent-[var(--color-accent)]"
              />
              <span>Improve Formatting</span>
            </label>
            <label className="block space-y-1.5 text-xs font-medium text-[var(--color-text-muted)]">
              <span>Select Agent to perform the task</span>
              <AvatarCombobox
                formId={aiFormId}
                name="discussionTarget"
                defaultValue={selectedAiTarget}
                options={aiTargets}
                emptyLabel="Select an agent"
                ariaLabel="AI description agent"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={aiSubmitting}
                onClick={() => setAiOpen(false)}
                className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={aiSubmitting || aiInstruction.length === 0 || selectedAiTarget.length === 0}
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {aiSubmitting ? "Sending..." : "Ask AI"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
