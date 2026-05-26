"use client";

import React, { useRef, useEffect } from "react";
import { renderFullMarkdown } from "@/lib/markdown";
import { sendAgentChatMessage, deleteChatMessage } from "@/lib/agents/chat-actions";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  type MessageActor,
} from "@/components/message-avatar";

interface Message {
  id: string;
  body: string;
  createdAt: Date;
  allowDescriptionEdit: boolean;
  editGrantUsedAt: Date | null;
  sender: MessageActor;
}

interface ChatRoomProps {
  projectSlug: string;
  taskId?: string;
  epicId?: string;
  messages: Message[];
  pendingAgents: Array<{ slug: string; username: string }>;
  latestMessageId: string | null;
  currentUserId?: string | null;
}

export default function ChatRoom({
  projectSlug,
  taskId,
  epicId,
  messages,
  pendingAgents,
  latestMessageId,
  currentUserId = null,
}: ChatRoomProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pendingAgents]);

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
    <div className="flex flex-col h-[520px] rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text)]">
            {taskId ? "Task Chat Room" : "Epic Chat Room"}
          </span>
        </div>
        <span className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider font-semibold">
          Multi-Agent Channel
        </span>
      </div>

      {/* Messages List */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0 scrollbar-thin"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center p-6 border border-dashed border-[var(--color-line)] rounded-xl bg-[var(--color-panel-soft)]/20">
            <span className="text-xl">💬</span>
            <p className="mt-2 text-xs font-semibold text-[var(--color-text)]">
              Welcome to the Chat Room!
            </p>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)] max-w-[280px]">
              Post a message to invoke default assignees/reviewers, or use <code className="px-1 py-0.5 rounded bg-[var(--color-panel-soft)] font-mono text-[var(--color-accent)]">@agent</code> to mention specific agents.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            const fromAgent = m.sender.kind === "agent";
            const fromCurrentUser = Boolean(currentUserId && m.sender.id === currentUserId);
            const displayName = actorDisplayName(m.sender);
            const bubbleTone = fromCurrentUser
              ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/[0.09]"
              : fromAgent
                ? "border-[var(--color-accent)]/25 bg-[var(--color-panel-soft)]"
                : "border-[var(--color-line)] bg-[var(--color-panel-soft)]";
            const tailTone = fromCurrentUser
              ? "border-[var(--color-accent)]/35 bg-[var(--color-accent)]/[0.09]"
              : fromAgent
                ? "border-[var(--color-accent)]/25 bg-[var(--color-panel-soft)]"
                : "border-[var(--color-line)] bg-[var(--color-panel-soft)]";
            return (
              <div
                key={m.id}
                className={`flex items-start gap-2.5 ${fromCurrentUser ? "justify-end" : "justify-start"}`}
              >
                {!fromCurrentUser ? <MessageAvatar actor={m.sender} /> : null}
                <article
                  className={`group relative w-fit min-w-[11rem] max-w-[min(36rem,78%)] rounded-2xl border px-3.5 py-2.5 shadow-sm transition-all ${bubbleTone}`}
                >
                  <span
                    aria-hidden="true"
                    className={`absolute top-4 h-3 w-3 rotate-45 ${tailTone} ${
                      fromCurrentUser ? "-right-1.5 border-r border-t" : "-left-1.5 border-b border-l"
                    }`}
                  />
                  <div className={`relative mb-2 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)] ${fromCurrentUser ? "justify-end" : "justify-between"}`}>
                    <span className="flex min-w-0 items-center gap-1">
                      <span className={`truncate ${fromAgent ? "font-semibold text-[var(--color-accent)]" : "font-semibold text-[var(--color-text)]"}`}>
                        {displayName}
                      </span>
                      {fromAgent ? (
                        <span className="rounded bg-[var(--color-accent)]/10 px-1 py-0.2 text-[8px] text-[var(--color-accent)] uppercase tracking-wider font-bold">
                          agent
                        </span>
                      ) : null}
                    </span>
                    <div className="flex items-center gap-2">
                      <MessageTimestamp value={m.createdAt} />
                      <form action={deleteChatMessage}>
                        <input type="hidden" name="projectSlug" value={projectSlug} />
                        <input type="hidden" name="messageId" value={m.id} />
                        <button
                          type="submit"
                          aria-label="Delete message"
                          title="Delete message"
                          className="text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--color-crit)] cursor-pointer font-bold text-[12px]"
                        >
                          ×
                        </button>
                      </form>
                    </div>
                  </div>
                  <div className={`relative md md-compact text-sm ${fromCurrentUser ? "text-left" : ""}`} dangerouslySetInnerHTML={renderFullMarkdown(m.body)} />
                </article>
                {fromCurrentUser ? <MessageAvatar actor={m.sender} /> : null}
              </div>
            );
          })
        )}

        {/* Streaming Replies */}
        {latestMessageId && pendingAgents.map((agent) => (
          <StreamingAgentReply
            key={agent.slug}
            targetKind={taskId ? "task-chat" : "epic-chat"}
            agentSlug={agent.slug}
            messageId={latestMessageId}
            taskId={taskId}
            epicId={epicId}
            label={agent.username}
          />
        ))}
      </div>

      {/* Input Form */}
      <form
        ref={formRef}
        action={actionHandler}
        className="border-t border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3 space-y-2 shrink-0"
      >
        <input type="hidden" name="projectSlug" value={projectSlug} />
        {taskId ? (
          <input type="hidden" name="taskId" value={taskId} />
        ) : (
          <input type="hidden" name="epicId" value={epicId} />
        )}
        <input type="hidden" name="agentSlug" value="room" />

        <textarea
          ref={textareaRef}
          name="body"
          required
          rows={2}
          maxLength={8000}
          placeholder="Message the room... (mentions like @agent are supported)"
          onKeyDown={handleKeyDown}
          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)] resize-none"
        />

        <div className="flex items-center justify-end gap-4">
          <button
            type="submit"
            className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-xs font-semibold text-[var(--color-bg)] hover:opacity-90 transition cursor-pointer select-none"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
