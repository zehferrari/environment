"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";
import { renderFullMarkdown } from "@/lib/markdown";
import { deleteDirectAgentMessage } from "@/lib/agents/direct-chat-actions";
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
  createdAt: string; // ISO string
  sender: MessageActor;
}

interface ParentArchive {
  id: string;
  summary: string;
  messages: Message[];
}

interface ChatMessagesContainerProps {
  messages: Message[];
  parentArchives?: ParentArchive[];
  showAgentProcessing: boolean;
  agentSlug: string;
  agentUsername: string;
  viewingArchive: boolean;
  slug: string;
  currentUserId?: string | null;
}

export default function ChatMessagesContainer({
  messages,
  parentArchives = [],
  showAgentProcessing,
  agentSlug,
  agentUsername,
  viewingArchive,
  slug,
  currentUserId = null,
}: ChatMessagesContainerProps) {
  const [visibleParentsCount, setVisibleParentsCount] = useState(0);

  const prependedMessages = useMemo(() => {
    const result: Message[] = [];
    // parentArchives is ordered from closest parent to furthest ancestor.
    // We prepend from furthest ancestor to closest parent so that the timeline reads chronologically.
    for (let i = visibleParentsCount - 1; i >= 0; i--) {
      const p = parentArchives[i];
      if (p) {
        result.push(...p.messages);
      }
    }
    return result;
  }, [parentArchives, visibleParentsCount]);

  const allMessages = useMemo(() => {
    return [...prependedMessages, ...messages];
  }, [prependedMessages, messages]);

  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const prevMessagesCount = useRef(messages.length);

  // Smart scrolling logic when messages are added
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isNewMessage = messages.length > prevMessagesCount.current;
    prevMessagesCount.current = messages.length;

    if (isNewMessage && lastMessageRef.current) {
      const lastMsg = lastMessageRef.current;
      const containerHeight = container.clientHeight;
      const msgHeight = lastMsg.clientHeight;

      if (msgHeight > containerHeight) {
        // If message is taller than the screen, align the top of the message with the top of the chat area
        container.scrollTo({
          top: lastMsg.offsetTop,
          behavior: "smooth",
        });
      } else {
        // Otherwise, scroll to the bottom
        container.scrollTo({
          top: container.scrollHeight,
          behavior: "smooth",
        });
      }
    } else if (messages.length > 0 && !isNewMessage) {
      // Default mount/first load scroll to bottom
      container.scrollTop = container.scrollHeight;
    }
  }, [messages]);

  // Keep scrolled to bottom during streaming when new tokens arrive
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !showAgentProcessing) return;

    // Observe changes in scrollHeight to keep it pinned if user was already at the bottom
    let isNearBottom = true;
    
    const handleScroll = () => {
      const threshold = 100; // pixels from bottom
      isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
    };

    container.addEventListener("scroll", handleScroll);

    const observer = new MutationObserver(() => {
      if (isNearBottom) {
        container.scrollTop = container.scrollHeight;
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      container.removeEventListener("scroll", handleScroll);
      observer.disconnect();
    };
  }, [showAgentProcessing]);

  const latest = messages.at(-1) ?? null;

  return (
    <div
      ref={containerRef}
      className="flex-1 space-y-3 overflow-y-auto p-4 min-h-0 scrollbar-thin scroll-smooth"
    >
      {/* Parent lineage expanding button */}
      {parentArchives.length > 0 && (
        <div className="flex flex-col items-center justify-center py-2 mb-4 border-b border-[var(--color-line)]/40 shrink-0">
          {visibleParentsCount < parentArchives.length ? (
            <button
              onClick={() => setVisibleParentsCount((prev) => prev + 1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/10 text-xs font-semibold text-[var(--color-accent)] hover:bg-[var(--color-accent)] hover:text-white transition cursor-pointer select-none"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>
              </svg>
              Chat Initial Context
            </button>
          ) : (
            <span className="text-[10px] uppercase font-bold tracking-wider text-[var(--color-text-muted)] select-none">
              Chat Start...
            </span>
          )}
        </div>
      )}

      {allMessages.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">No messages yet.</p>
      ) : (
        allMessages.map((m, index) => {
          const fromCurrentUser = Boolean(currentUserId && m.sender.id === currentUserId);
          const fromAgent = m.sender.kind === "agent";
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
          const isLast = index === allMessages.length - 1;
          
          return (
            <div
              key={m.id}
              ref={isLast ? lastMessageRef : null}
              className={`group flex items-start gap-2.5 transition-all duration-200 ${
                fromCurrentUser ? "justify-end" : ""
              }`}
            >
              {!fromCurrentUser ? <MessageAvatar actor={m.sender} /> : null}
              <div
                className={`relative w-fit min-w-[11rem] max-w-[min(36rem,78%)] rounded-2xl border px-3.5 py-2.5 shadow-sm ${bubbleTone}`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute top-4 h-3 w-3 rotate-45 ${tailTone} ${
                    fromCurrentUser ? "-right-1.5 border-r border-t" : "-left-1.5 border-b border-l"
                  }`}
                />
                <div className="relative mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <strong className="truncate font-medium text-[var(--color-text)]">
                      {actorDisplayName(m.sender)}
                    </strong>
                    {m.sender.kind === "agent" ? (
                      <span className="rounded-full border border-[var(--color-line)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                        agent
                      </span>
                    ) : null}
                    <MessageTimestamp value={m.createdAt} />
                  </div>
                  <div className="flex items-center gap-2">
                    {!viewingArchive ? (
                      <form action={deleteDirectAgentMessage}>
                        <input type="hidden" name="agentSlug" value={slug} />
                        <input type="hidden" name="messageId" value={m.id} />
                        <button
                          type="submit"
                          aria-label="Delete message"
                          title="Delete message"
                          className="cursor-pointer text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--color-crit)]"
                        >
                          ×
                        </button>
                      </form>
                    ) : null}
                  </div>
                </div>
                <div className="relative md md-compact" dangerouslySetInnerHTML={renderFullMarkdown(m.body)} />
              </div>
              {fromCurrentUser ? <MessageAvatar actor={m.sender} /> : null}
            </div>
          );
        })
      )}
      {showAgentProcessing && latest && (
        <div ref={lastMessageRef}>
          <StreamingAgentReply
            targetKind="direct"
            agentSlug={agentSlug}
            messageId={latest.id}
            label={agentUsername}
          />
        </div>
      )}
    </div>
  );
}
