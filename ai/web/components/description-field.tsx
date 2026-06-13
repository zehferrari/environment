"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { sendAgentChatMessage } from "@/lib/agents/chat/chat-actions";
import { generateClientMessageId } from "@/lib/agents/client-message-id";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";
import { renderFullMarkdown } from "@/lib/markdown";

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
  draftDescription = null,
  aiRunning = false,
  runningMessageId = null,
  runningAgentSlug = null,
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
  draftDescription?: string | null;
  aiRunning?: boolean;
  runningMessageId?: string | null;
  runningAgentSlug?: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(draftDescription !== null || defaultValue.trim() === "");
  const [value, setValue] = useState(draftDescription !== null ? draftDescription : defaultValue);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiMode, setAiMode] = useState<"format" | "both">("both");
  const [modeOpen, setModeOpen] = useState(false);
  const [aiSubmitting, setAiSubmitting] = useState(false);

  const rollbackKey = `description-rollback-${taskId ?? epicId ?? "scope"}`;
  const [hasRollback, setHasRollback] = useState(false);

  const [streamText, setStreamText] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [streamStatus, setStreamStatus] = useState<"connecting" | "streaming" | "done" | "error" | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);

  const aiFormId = `description-ai-${taskId ?? epicId ?? "scope"}`;
  const selectedAiTarget = defaultAiTarget || aiTargets[0]?.value || "";
  const aiAvailable = Boolean(projectSlug && (taskId || epicId) && aiTargets.length > 0 && defaultValue.trim() !== "");
  const hasUnsavedEdits = value !== defaultValue;

  // Compute preview HTML from the live `value` state so toggling to
  // preview mode always shows the user's current (possibly unsaved) edits
  // instead of the stale server-rendered previewHtml.
  const livePreviewHtml = useMemo(
    () => (value.trim() ? renderFullMarkdown(value).__html : ""),
    [value],
  );

  const improveText = aiMode === "both";
  const improveFormatting = true;
  const aiInstructionParts = [
    improveText ? "improve the wording, clarity, and completeness" : null,
    improveFormatting ? "improve the markdown structure and formatting" : null,
  ].filter(Boolean);
  const aiInstruction = aiInstructionParts.length > 0
    ? `Please propose a new ${descriptionLabel.toLowerCase()} description as a draft: ${aiInstructionParts.join(" and ")}. Preserve useful existing details. ${descriptionLabel.toLowerCase() === "task" ? "For task descriptions, use a concise operational markdown format with clear sections when useful: Goal, Scope, Acceptance Criteria, Implementation Notes, Test Notes, and Relevant Attachments. Keep empty or irrelevant sections out." : ""} Do NOT submit this as a work-item proposal. Use your description write-back token/endpoint to publish the draft for the requester to review; the requester will explicitly Save it (or Rollback) on the task/epic page.`
    : "";

  useEffect(() => {
    if (draftDescription !== null && draftDescription !== undefined) {
      setValue(draftDescription);
      setEditing(true);
      setHasRollback(true);
    } else {
      setValue(defaultValue);
      setEditing(defaultValue.trim() === "");
      setHasRollback(false);
    }

    const stored = localStorage.getItem(rollbackKey);
    if (stored === defaultValue) {
      localStorage.removeItem(rollbackKey);
    }
  }, [defaultValue, draftDescription, rollbackKey]);

  // Description-draft heartbeat — bumps lastSeenAt on the requester's
  // DescriptionDraft row while the page is open. If the user navigates
  // away or the tab is hidden long enough, heartbeats stop and the
  // server-side reaper purges any draft within ~60s. We always heartbeat
  // (even when there's no current draft) so a late-arriving agent POST
  // still sees a fresh row when it lands. We stop while the AI prompt
  // is running on the same tab to avoid log spam during streaming.
  useEffect(() => {
    const id = taskId ?? epicId;
    const scope: "task" | "epic" | null = taskId ? "task" : epicId ? "epic" : null;
    if (!id || !scope) return;

    const ping = () => {
      // navigator.sendBeacon isn't ideal here (it's POST-only and we want
      // JSON), so a plain fetch with keepalive covers tab-close as well.
      fetch("/api/system/description-draft/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, targetId: id }),
        keepalive: true,
      }).catch(() => { /* heartbeat failures are silent — reaper cleans up */ });
    };

    ping(); // immediate bump so the first read after the AI POST is fresh
    const handle = window.setInterval(ping, 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(handle);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [taskId, epicId]);

  useEffect(() => {
    if (!aiRunning || !runningMessageId || !runningAgentSlug) {
      setStreamText("");
      setStreamReasoning("");
      setStreamStatus(null);
      setStreamError(null);
      return;
    }

    const params = new URLSearchParams({
      kind: taskId ? "task-chat" : "epic-chat",
      agentSlug: runningAgentSlug,
      messageId: runningMessageId,
    });
    if (taskId) params.set("taskId", taskId);
    if (epicId) params.set("epicId", epicId);
    if (projectSlug) params.set("projectSlug", projectSlug);

    const url = `/api/openclaw/pm-channel/events?${params.toString()}`;
    setStreamStatus("connecting");
    const source = new EventSource(url);

    let refreshTimer: any;
    const refreshSoon = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        router.refresh();
      }, 500);
    };

    const parse = (event: MessageEvent<string>) => {
      try {
        return JSON.parse(event.data) as {
          text?: string;
          reasoning?: string;
          status?: "streaming" | "done" | "error";
          error?: string | null;
        };
      } catch {
        return null;
      }
    };

    const onState = (event: MessageEvent<string>) => {
      const payload = parse(event);
      if (!payload) return;
      if (typeof payload.text === "string") {
        setStreamText(payload.text);
      }
      if (typeof payload.reasoning === "string") {
        setStreamReasoning(payload.reasoning);
      }
      if (payload.status === "done") {
        setStreamStatus("done");
        source.close();
        refreshSoon();
      } else if (payload.status === "error") {
        setStreamStatus("error");
        setStreamError(payload.error ?? "Agent stream failed");
        source.close();
        refreshSoon();
      } else {
        setStreamStatus("streaming");
      }
    };

    const onErrorEvent = (event: MessageEvent<string>) => {
      const payload = parse(event);
      setStreamError(payload?.error ?? "Agent stream failed");
      setStreamStatus("error");
      source.close();
      refreshSoon();
    };

    const onHeartbeat = () => {
      setStreamStatus((current) => current === "connecting" ? "streaming" : current);
    };

    source.addEventListener("snapshot", onState);
    source.addEventListener("partial", onState);
    source.addEventListener("reasoning", onState);
    source.addEventListener("final", onState);
    source.addEventListener("done", onState);
    source.addEventListener("stream-error", onErrorEvent);
    source.addEventListener("heartbeat", onHeartbeat);

    source.onerror = () => {
      // EventSource retries automatically
    };

    return () => {
      source.close();
      clearTimeout(refreshTimer);
    };
  }, [aiRunning, runningMessageId, runningAgentSlug, taskId, epicId, projectSlug, router]);

  const submitAiPrompt = async (formData: FormData) => {
    if (aiSubmitting) return;
    localStorage.setItem(rollbackKey, defaultValue);
    setHasRollback(true);
    setAiSubmitting(true);
    try {
      formData.set("messageId", generateClientMessageId());
      await sendAgentChatMessage(formData);
      setAiOpen(false);
      router.refresh();
    } finally {
      setAiSubmitting(false);
    }
  };

  const handleRollback = async () => {
    const stored = localStorage.getItem(rollbackKey);
    const rollbackValue = stored !== null ? stored : defaultValue;
    setValue(rollbackValue);
    setEditing(rollbackValue.trim() === "");

    const id = taskId ?? epicId;
    const scope = taskId ? "task" : "epic";
    if (id) {
      try {
        const { clearDescriptionDraftAction } = await import("@/lib/projects/actions");
        await clearDescriptionDraftAction(id, scope);
      } catch (e) {
        console.error("Failed to clear server description draft:", e);
      }
    }
    localStorage.removeItem(rollbackKey);
    setHasRollback(false);
    router.refresh();
  };

  return (
    <div className="relative rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
      {aiRunning ? (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center rounded-lg bg-[var(--color-panel)]/95 p-6 space-y-4 overflow-y-auto">
          <div className="relative flex items-center justify-center shrink-0">
            <div className="h-10 w-10 rounded-full border-4 border-[var(--color-accent)]/20 border-t-[var(--color-accent)] animate-spin" />
            <span className="absolute text-[10px] font-bold text-[var(--color-accent)] uppercase">z</span>
          </div>
          <div className="text-center space-y-1 shrink-0">
            <p className="text-xs font-semibold text-[var(--color-text)]">Agent is updating description...</p>
            <p className="text-[10px] text-[var(--color-text-muted)]">Please wait while the description is being improved.</p>
          </div>
          {(streamReasoning || streamText) ? (
            <div className="w-full max-w-lg mt-2 space-y-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3 text-left">
              {streamReasoning ? (
                <div className="space-y-1">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Thought Process</div>
                  <div className="max-h-24 overflow-y-auto font-mono text-[11px] leading-relaxed text-[var(--color-text-muted)] whitespace-pre-wrap">{streamReasoning}</div>
                </div>
              ) : null}
              {streamText ? (
                <div className="space-y-1 border-t border-[var(--color-line)] pt-2">
                  <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Output Response</div>
                  <div className="max-h-32 overflow-y-auto font-mono text-[11px] leading-relaxed text-[var(--color-text)] whitespace-pre-wrap">{streamText}</div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
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
          {draftDescription !== null ? (
            <button
              type="button"
              onClick={handleRollback}
              aria-label="Rollback description edits"
              title="Rollback description edits"
              className="rounded p-1 text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
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
          ) : null}
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
        dangerouslySetInnerHTML={{ __html: livePreviewHtml }}
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]"
          onClick={() => !aiSubmitting && setAiOpen(false)}
        >
          <form
            id={aiFormId}
            action={submitAiPrompt}
            onClick={(event) => event.stopPropagation()}
            className="relative w-full max-w-xl space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-2xl"
          >
            {aiSubmitting ? (
              <div className="absolute inset-0 z-40 flex flex-col items-center justify-center rounded-2xl bg-[var(--color-panel)]/95 p-6 space-y-4">
                <div className="relative flex items-center justify-center">
                  <div className="h-10 w-10 rounded-full border-4 border-[var(--color-accent)]/20 border-t-[var(--color-accent)] animate-spin" />
                  <span className="absolute text-[10px] font-bold text-[var(--color-accent)] uppercase">z</span>
                </div>
                <div className="text-center space-y-1">
                  <p className="text-xs font-semibold text-[var(--color-text)]">Agent is thinking...</p>
                  <p className="text-[10px] text-[var(--color-text-muted)]">Updating description, please wait.</p>
                </div>
              </div>
            ) : null}

            {projectSlug ? <input type="hidden" name="projectSlug" value={projectSlug} /> : null}
            {taskId ? <input type="hidden" name="taskId" value={taskId} /> : null}
            {epicId ? <input type="hidden" name="epicId" value={epicId} /> : null}
            <input type="hidden" name="originChannel" value="description" />
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Description update
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
            <div className="grid grid-cols-2 gap-3 relative">
              <label className="block space-y-1.5 text-xs font-medium text-[var(--color-text-muted)] relative">
                <span>Action</span>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModeOpen((current) => !current)}
                    className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 text-left text-xs text-[var(--color-text)] outline-none transition hover:border-[var(--color-accent)]"
                  >
                    <span>{aiMode === "both" ? "Improve Description" : "Improve Only Formatting"}</span>
                    <span className="shrink-0 text-[var(--color-text-muted)]" aria-hidden="true">
                      {modeOpen ? "▴" : "▾"}
                    </span>
                  </button>
                  {modeOpen ? (
                    <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] p-1.5 shadow-2xl">
                      <button
                        type="button"
                        onClick={() => {
                          setAiMode("both");
                          setModeOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${
                          aiMode === "both"
                            ? "bg-[var(--color-accent)]/[0.12] text-[var(--color-text)]"
                            : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        Improve Description
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAiMode("format");
                          setModeOpen(false);
                        }}
                        className={`mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${
                          aiMode === "format"
                            ? "bg-[var(--color-accent)]/[0.12] text-[var(--color-text)]"
                            : "text-[var(--color-text-muted)] hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
                        }`}
                      >
                        Improve Only Formatting
                      </button>
                    </div>
                  ) : null}
                </div>
              </label>
              <label className="block space-y-1.5 text-xs font-medium text-[var(--color-text-muted)]">
                <span>Select Agent</span>
                <AvatarCombobox
                  formId={aiFormId}
                  name="discussionTarget"
                  defaultValue={selectedAiTarget}
                  options={aiTargets}
                  emptyLabel="Select an agent"
                  ariaLabel="AI description agent"
                />
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
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
                {aiSubmitting ? "Running..." : "Run"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
