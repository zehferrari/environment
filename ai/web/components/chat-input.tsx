"use client";

import { sendDirectAgentMessage } from "@/lib/agents/direct-chat-actions";
import React, { useRef, useState } from "react";

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
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [selectedFilesCount, setSelectedFilesCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Project attachment is carried forward across the conversation. Human
  // project-scoped requests automatically carry the one-shot proposal capability.
  const [projectId, setProjectId] = useState(attachedProjectId ?? "");

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSelectedFilesCount(e.target.files?.length ?? 0);
  };

  const actionHandler = async (formData: FormData) => {
    if (textareaRef.current) {
      textareaRef.current.value = "";
    }
    setSelectedFilesCount(0);
    await sendDirectAgentMessage(formData);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <form
      ref={formRef}
      action={actionHandler}
      encType="multipart/form-data"
      className="border-t border-[var(--color-line)] p-4 bg-[var(--color-panel)] shrink-0"
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
      <textarea
        ref={textareaRef}
        name="body"
        required
        rows={4}
        maxLength={8000}
        placeholder={
          viewingArchive
            ? `Start a child chat from this archive with @${agentUsername}...`
            : `Message @${agentUsername}...`
        }
        onKeyDown={handleKeyDown}
        className="w-full resize-none rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
      />

      {/* Project attachment */}
      {projects.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <span className="select-none">Project</span>
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
        </div>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-4">
        {/* Attach File Button */}
        <label className="flex items-center gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] cursor-pointer transition select-none">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
          <span>Attach Files</span>
          <input
            ref={fileInputRef}
            type="file"
            name="attachments"
            multiple
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        <div className="flex items-center gap-3">
          {selectedFilesCount > 0 && (
            <span className="text-xs text-[var(--color-accent)] font-semibold">
              {selectedFilesCount} file{selectedFilesCount === 1 ? "" : "s"} selected
            </span>
          )}

          <button
            type="submit"
            className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 cursor-pointer"
          >
            {viewingArchive ? "Start Child Chat" : "Send"}
          </button>
        </div>
      </div>
    </form>
  );
}
