"use client";

import React, { useEffect, useRef, useState, useMemo } from "react";
import { deleteDirectAgentMessage, restoreDirectAgentMessage } from "@/lib/agents/direct-chat-actions";
import ChatBubble from "@/components/chat-bubble";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import ConfirmedDeleteButton from "@/components/confirmed-delete-button";
import DeletedMessageDivider from "@/components/deleted-message-divider";
import {
  type MessageActor,
} from "@/components/message-avatar";
import { getMessageGroupState, messageParticipantKey } from "@/lib/agents/message-grouping";

interface Message {
  id: string;
  body: string;
  createdAt: string; // ISO string
  sender: MessageActor;
  // Soft-delete metadata (HOMELAB-41 / item 2). When deletedAt is set
  // the bubble is replaced by a collapsed dotted divider.
  deletedAt?: string | null;
  deletedBy?: { username?: string | null; name?: string | null; kind?: string | null } | null;
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
  const [liveMessages, setLiveMessages] = useState(messages);

  useEffect(() => {
    setLiveMessages(messages);
  }, [messages]);

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
    return [...prependedMessages, ...liveMessages];
  }, [prependedMessages, liveMessages]);

  const containerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const prevMessagesCount = useRef(liveMessages.length);

  // Smart scrolling logic when messages are added
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const isNewMessage = liveMessages.length > prevMessagesCount.current;
    prevMessagesCount.current = liveMessages.length;

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
    } else if (liveMessages.length > 0 && !isNewMessage) {
      // Default mount/first load scroll to bottom
      container.scrollTop = container.scrollHeight;
    }
  }, [liveMessages]);

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

  const latest = liveMessages.at(-1) ?? null;
  const latestMessageId = latest?.id ?? null;
  const liveShowAgentProcessing = showAgentProcessing
    && !viewingArchive
    && Boolean(latest && latest.sender.kind !== "agent");
  const participantIndexes = useMemo(() => {
    const map = new Map<string, number>();
    for (const message of allMessages) {
      if (currentUserId && message.sender.id === currentUserId) continue;
      const key = messageParticipantKey(message.sender);
      if (!map.has(key)) map.set(key, map.size);
    }
    return map;
  }, [allMessages, currentUserId]);

  const reconcileMessages = React.useCallback(async () => {
    if (viewingArchive) return;
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(slug)}/chat/messages`, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) return;
      const payload = (await res.json()) as { messages?: Message[] };
      if (Array.isArray(payload.messages)) {
        setLiveMessages(payload.messages);
      }
    } catch {
      // Best-effort UI reconciliation; the server-rendered page remains source of truth.
    }
  }, [slug, viewingArchive]);

  useEffect(() => {
    if (!liveShowAgentProcessing || !latestMessageId) return;

    const initialRefresh = setTimeout(() => {
      void reconcileMessages();
    }, 1_500);
    const interval = setInterval(() => {
      void reconcileMessages();
    }, 4_000);

    return () => {
      clearTimeout(initialRefresh);
      clearInterval(interval);
    };
  }, [latestMessageId, liveShowAgentProcessing, reconcileMessages]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto p-4 min-h-0 scrollbar-thin scroll-smooth"
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
          const isLast = index === allMessages.length - 1;
          const groupState = getMessageGroupState(allMessages, index);
          if (m.deletedAt) {
            // Soft-deleted direct-chat bubble (HOMELAB-41 / item 2).
            // Restore (↺) only on live view, never in an archived read-only.
            return (
              <DeletedMessageDivider
                key={m.id}
                deletedAt={m.deletedAt}
                deletedBy={m.deletedBy ?? null}
                restore={!viewingArchive ? {
                  action: restoreDirectAgentMessage,
                  fields: { agentSlug: slug, messageId: m.id },
                } : undefined}
              >
                <span>{m.body}</span>
              </DeletedMessageDivider>
            );
          }
          return (
            <ChatBubble
              key={m.id}
              containerRef={isLast ? lastMessageRef : null}
              message={m}
              currentUserId={currentUserId}
              participantIndex={participantIndexes.get(messageParticipantKey(m.sender)) ?? 0}
              isGroupStart={groupState.isGroupStart}
              isGroupEnd={groupState.isGroupEnd}
              isGroupedContinuation={groupState.isGroupedContinuation}
              className={groupState.isGroupedContinuation ? "mt-1" : "mt-6 first:mt-0"}
              actions={!viewingArchive ? (
                <ConfirmedDeleteButton
                  action={deleteDirectAgentMessage}
                  fields={{ agentSlug: slug, messageId: m.id }}
                  label="×"
                  title="Delete message"
                  description="The bubble will be hidden behind a collapsed dotted divider that humans can expand. Agents will never see it in their context again."
                  confirmLabel="Delete message"
                  buttonTitle="Delete message"
                  ariaLabel="Delete message"
                  className="cursor-pointer text-[12px] font-bold text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 hover:text-[var(--color-crit)]"
                />
              ) : null}
            />
          );
        })
      )}
      {liveShowAgentProcessing && latest && (
        <div ref={lastMessageRef}>
          <StreamingAgentReply
            targetKind="direct"
            agentSlug={agentSlug}
            messageId={latest.id}
            label={agentUsername}
            onFinal={() => {
              void reconcileMessages();
            }}
          />
        </div>
      )}
    </div>
  );
}
