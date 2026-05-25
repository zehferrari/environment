"use client";

import { useState } from "react";

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
}: {
  previewHtml: string;
  defaultValue: string;
  rows: number;
  // When set, the textarea is associated with that <form id> via the HTML
  // `form` attribute, so it submits through the task card's single Save
  // button even though the textarea lives in a separate tab panel.
  formId?: string;
}) {
  const [editing, setEditing] = useState(defaultValue.trim() === "");

  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          {editing ? "Edit" : "Preview"}
        </span>
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
        defaultValue={defaultValue}
        rows={rows}
        placeholder="Add a description — markdown supported (headings, lists, code fences, tables)"
        className={`w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)] ${
          editing ? "" : "hidden"
        }`}
      />
    </div>
  );
}
