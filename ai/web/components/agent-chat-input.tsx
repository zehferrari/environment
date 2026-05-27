"use client";

import { sendAgentChatMessage } from "@/lib/agents/chat-actions";
import MaximizableTextarea from "@/components/maximizable-textarea";
import React, { useRef, useState } from "react";

interface AgentChatInputProps {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  agentSlug: string;
  agentUsername: string;
}

export default function AgentChatInput({
  projectSlug,
  taskId,
  epicId,
  agentSlug,
  agentUsername,
}: AgentChatInputProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [messageText, setMessageText] = useState("");
  const canSend = messageText.trim().length > 0;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) formRef.current?.requestSubmit();
    }
  };

  const actionHandler = async (formData: FormData) => {
    await sendAgentChatMessage(formData);
    setMessageText("");
    if (textareaRef.current) textareaRef.current.value = "";
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
      <MaximizableTextarea
        ref={textareaRef}
        name="body"
        value={messageText}
        onValueChange={setMessageText}
        rows={3}
        maxLength={8000}
        placeholder={`Message @${agentUsername}...`}
        onKeyDown={handleKeyDown}
        expandedTitle={`Message @${agentUsername}`}
        className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)] resize-none"
      />
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!canSend}
          className="rounded-lg bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[var(--color-bg)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45 cursor-pointer"
        >
          Send
        </button>
      </div>
    </form>
  );
}
