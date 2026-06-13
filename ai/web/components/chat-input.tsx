"use client";

import { sendDirectAgentMessage } from "@/lib/agents/chat/direct-chat-actions";
import MaximizableTextarea from "@/components/maximizable-textarea";
import { useDirectChatOptimistic } from "@/components/direct-chat-optimistic-provider";
import { generateClientMessageId } from "@/lib/agents/client-message-id";
import React, { useEffect, useRef, useState } from "react";

function isNextRedirectError(err: unknown) {
  return typeof (err as { digest?: unknown } | null)?.digest === "string"
    && (err as { digest: string }).digest.startsWith("NEXT_REDIRECT");
}

interface ChatInputProps {
  agentSlug: string;
  agentUsername: string;
  viewingArchive: boolean;
  selectedArchiveId?: string | null;
  activeBaseArchiveId?: string | null;
  projects?: Array<{ id: string; name: string }>;
  attachedProjectId?: string | null;
}

export default function ChatInput({
  agentSlug,
  agentUsername,
  viewingArchive,
  selectedArchiveId,
  activeBaseArchiveId,
  projects = [],
  attachedProjectId = null,
}: ChatInputProps) {
  const { addOptimistic, markFailed } = useDirectChatOptimistic();
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [messageText, setMessageText] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedFilesCount, setSelectedFilesCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canSend = messageText.trim().length > 0 || selectedFilesCount > 0;

  // Project attachment is carried forward across the conversation. Human
  // project-scoped requests automatically carry the one-shot proposal capability.
  const [projectId, setProjectId] = useState(attachedProjectId ?? "");

  useEffect(() => {
    const openNewChatComposer = (event: Event) => {
      const detail = (event as CustomEvent<{ agentSlug?: string; body?: string }>).detail;
      if (detail?.agentSlug && detail.agentSlug !== agentSlug) return;
      setMessageText(detail?.body ?? "");
      setSelectedFilesCount(0);
      setErrorMessage(null);
      setComposerOpen(true);
      window.requestAnimationFrame(() => textareaRef.current?.focus());
    };
    window.addEventListener("pm:new-direct-chat", openNewChatComposer);
    return () => window.removeEventListener("pm:new-direct-chat", openNewChatComposer);
  }, [agentSlug]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) formRef.current?.requestSubmit();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedFilesCount(e.target.files?.length ?? 0);
  };

  const closeComposer = () => {
    setComposerOpen(false);
    setSelectedFilesCount(0);
    setErrorMessage(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const actionHandler = async (formData: FormData) => {
    setErrorMessage(null);
    const submittedBody = String(formData.get("body") ?? "").trim();
    // Echo the user's own message instantly (current-chat sends only; the
    // child-chat / archive path redirects, so an echo would be discarded).
    const echoClientId = !viewingArchive && submittedBody ? generateClientMessageId() : null;
    if (echoClientId) {
      addOptimistic(echoClientId, submittedBody);
      // Send the same id to the server so it becomes the message's id — the echo
      // then reconciles by id (reliable) instead of by body text.
      formData.set("clientMessageId", echoClientId);
    }
    // Remember what we optimistically cleared so a failed send that has no
    // optimistic bubble to fall back on (attachment-only or archive/child-chat
    // sends) can restore the composer instead of silently dropping the input.
    const previousText = messageText;
    const hadFiles = selectedFilesCount > 0;
    setMessageText("");
    setSelectedFilesCount(0);
    setComposerOpen(false);
    try {
      await sendDirectAgentMessage(formData);
    } catch (err) {
      if (isNextRedirectError(err)) throw err; // let Next perform the redirect
      if (echoClientId) {
        // The optimistic bubble carries the failure + resend affordance.
        markFailed(echoClientId);
      } else {
        // No echo exists for this send, so reopen the composer and surface the
        // error rather than losing the message with zero feedback. Files cannot
        // be restored into a file input programmatically, so prompt to re-attach.
        setMessageText(previousText);
        setComposerOpen(true);
        setErrorMessage(
          hadFiles
            ? "Couldn't send your message. Re-attach your files and try again."
            : "Couldn't send your message. Please try again.",
        );
      }
      return;
    }
    if (textareaRef.current) {
      textareaRef.current.value = "";
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <>
      {composerOpen ? (
        <div
          className="fixed inset-0 z-50 bg-black/10 p-4 backdrop-blur-[1px]"
          onClick={closeComposer}
        >
          <form
            ref={formRef}
            action={actionHandler}
            encType="multipart/form-data"
            onClick={(event) => event.stopPropagation()}
            className="absolute bottom-24 right-4 w-[calc(100vw-2rem)] max-w-2xl space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-2xl sm:right-6"
          >
            <input type="hidden" name="agentSlug" value={agentSlug} />
            {selectedArchiveId ? (
              <>
                <input type="hidden" name="baseArchiveId" value={selectedArchiveId} />
                <input type="hidden" name="continueFromArchive" value="1" />
              </>
            ) : activeBaseArchiveId ? (
              <input type="hidden" name="baseArchiveId" value={activeBaseArchiveId} />
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {viewingArchive ? "Start child chat" : "New message"}
                </div>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Message @{agentUsername} with optional files and project context.
                </p>
              </div>
              <button
                type="button"
                onClick={closeComposer}
                aria-label="Close chat composer"
                className="grid h-8 w-8 place-items-center rounded-lg text-lg leading-none text-[var(--color-text-muted)] transition hover:bg-[var(--color-panel-soft)] hover:text-[var(--color-text)]"
              >
                &times;
              </button>
            </div>
            <MaximizableTextarea
              ref={textareaRef}
              name="body"
              value={messageText}
              onValueChange={(value) => {
                setMessageText(value);
                if (errorMessage) setErrorMessage(null);
              }}
              rows={5}
              maxLength={8000}
              placeholder={
                viewingArchive
                  ? `Start a child chat from this archive with @${agentUsername}...`
                  : `Message @${agentUsername}...`
              }
              onKeyDown={handleKeyDown}
              expandedTitle={`Message @${agentUsername}`}
              className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />

            {errorMessage ? (
              <p
                role="alert"
                className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400"
              >
                {errorMessage}
              </p>
            ) : null}

            {projects.length > 0 ? (
              <label className="flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]">
                <span className="select-none font-semibold">Project</span>
                <select
                  name="projectId"
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer select-none">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                <span>{selectedFilesCount > 0 ? `${selectedFilesCount} selected` : "Attach files"}</span>
                <input
                  ref={fileInputRef}
                  type="file"
                  name="attachments"
                  multiple
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>

              <button
                type="submit"
                disabled={!canSend}
                className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
              >
                {viewingArchive ? "Start Child Chat" : "Send"}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => {
          setErrorMessage(null);
          setComposerOpen(true);
        }}
        aria-label={viewingArchive ? "Start child chat" : `Message @${agentUsername}`}
        className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-accent)] text-3xl leading-none text-[var(--color-bg)] shadow-lg transition hover:opacity-90"
      >
        <span className="-mt-0.5">+</span>
      </button>
    </>
  );
}
