"use client";

import { sendAgentChatMessage } from "@/lib/agents/chat-actions";
import React, { useRef } from "react";

interface AgentChatInputProps {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  agentSlug: string;
  agentUsername: string;
  isTaskChat: boolean;
}

export default function AgentChatInput({
  projectSlug,
  taskId,
  epicId,
  agentSlug,
  agentUsername,
  isTaskChat,
}: AgentChatInputProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  };

  const actionHandler = async (formData: FormData) => {
    if (textareaRef.current) {
      textareaRef.current.value = "";
    }
    await sendAgentChatMessage(formData);
  };

  return (
    <form ref={formRef} action={actionHandler} className="space-y-2 shrink-0">
      <input type="hidden" name="projectSlug" value={projectSlug} />
      {taskId ? (
        <input type="hidden" name="taskId" value={taskId} />
      ) : (
        <input type="hidden" name="epicId" value={epicId} />
      )}
      <input type="hidden" name="agentSlug" value={agentSlug} />
      <textarea
        ref={textareaRef}
        name="body"
        required
        rows={3}
        maxLength={8000}
        placeholder={`Message @${agentUsername}...`}
        onKeyDown={handleKeyDown}
        className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)] resize-none"
      />
      {isTaskChat ? (
        <label className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer">
          <input
            type="checkbox"
            name="allowDescriptionEdit"
            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
          />
          Allow description edit
        </label>
      ) : null}
      <div className="flex justify-end">
        <button
          type="submit"
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] hover:opacity-90 cursor-pointer"
        >
          Send
        </button>
      </div>
    </form>
  );
}
