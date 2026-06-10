"use client";

import { useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { renderFullMarkdown } from "@/lib/markdown";
import { parsePmOptions, isPmOptionsTargetedAtCurrentUser, type PmOption } from "@/lib/pm-options";
import { parseDiscussionReplySections } from "@/lib/agents/discussion-reply-format";
import PmOptions from "@/components/pm-options";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  type MessageActor,
} from "@/components/message-avatar";

export interface ChatBubbleMessage {
  id: string;
  body: string;
  createdAt: Date | string;
  targetLabel?: string | null;
  targetType?: string | null;
  targetValue?: string | null;
  sender: MessageActor;
}

interface ChatBubbleProps {
  message: ChatBubbleMessage;
  currentUserId?: string | null;
  projectSlug?: string;
  surface?: "task-chat" | "epic-chat";
  resolvedOption?: PmOption | null;
  actions?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
  className?: string;
  preferShortAgentSections?: boolean;
  participantIndex?: number;
  deliveryStatus?: "sending" | "failed";
}

const senderPalette = [
  "#2563eb",
  "#c2410c",
  "#047857",
  "#be123c",
  "#7c3aed",
  "#0f766e",
  "#b45309",
  "#4338ca",
];

function hashString(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export default function ChatBubble({
  message,
  currentUserId = null,
  projectSlug,
  surface,
  resolvedOption = null,
  actions,
  containerRef,
  className = "",
  preferShortAgentSections = false,
  participantIndex,
  deliveryStatus,
}: ChatBubbleProps) {
  const [showFullSection, setShowFullSection] = useState(false);
  const fromAgent = message.sender.kind === "agent";
  const fromCurrentUser = Boolean(currentUserId && message.sender.id === currentUserId);
  const displayName = actorDisplayName(message.sender);
  const sections = preferShortAgentSections && fromAgent
    ? parseDiscussionReplySections(message.body)
    : null;
  const rawDisplayBody = sections
    ? showFullSection
      ? sections.sectionA
      : sections.sectionB
    : message.body;
  const parsedOptions = parsePmOptions(rawDisplayBody);
  const displayBody = parsedOptions.body;
  const senderKey = message.sender.id ?? message.sender.agent?.slug ?? message.sender.username;
  const hash = hashString(senderKey);
  const paletteIndex = participantIndex ?? (hash % senderPalette.length);
  const senderAccent = fromCurrentUser
    ? "var(--color-accent)"
    : senderPalette[paletteIndex % senderPalette.length];
  const indentationLevel = fromCurrentUser ? 0 : Math.max(0, participantIndex ?? 0);
  const rootStyle = {
    marginLeft: indentationLevel > 0 ? `${Math.min(indentationLevel, 6) * 10}%` : undefined,
  } satisfies CSSProperties;
  const articleStyle = {
    borderColor: `color-mix(in srgb, ${senderAccent} 52%, transparent)`,
    background: fromCurrentUser
      ? `color-mix(in srgb, ${senderAccent} 18%, var(--color-panel))`
      : `color-mix(in srgb, ${senderAccent} ${fromAgent ? "16%" : "14%"}, var(--color-panel))`,
    boxShadow: `0 10px 28px color-mix(in srgb, ${senderAccent} 14%, transparent)`,
  } satisfies CSSProperties;
  const cornerClass = fromCurrentUser ? "rounded-br-md" : "rounded-bl-md";

  return (
    <div
      ref={containerRef}
      style={rootStyle}
      className={`group flex items-start gap-2.5 transition-all duration-200 ${fromCurrentUser ? "justify-end" : "justify-start"} ${className}`}
    >
      {!fromCurrentUser ? <MessageAvatar actor={message.sender} /> : null}
      <article
        style={articleStyle}
        className={`w-fit min-w-0 max-w-[min(44rem,82%)] rounded-[1.15rem] ${cornerClass} border px-3.5 py-2.5 ring-1 ring-black/[0.02]`}
      >
        <div className={`mb-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)] ${fromCurrentUser ? "justify-end" : "justify-between"}`}>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="truncate font-semibold" style={{ color: senderAccent }}>
              {displayName}
            </strong>
            {fromAgent ? (
              <span
                className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
                style={{ borderColor: `color-mix(in srgb, ${senderAccent} 28%, transparent)`, color: senderAccent }}
              >
                agent
              </span>
            ) : null}
            {!fromAgent && message.targetLabel ? (
              <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-bg)]/70 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                to {message.targetLabel}
              </span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <MessageTimestamp value={message.createdAt} />
            {sections ? (
              <button
                type="button"
                onClick={() => setShowFullSection((current) => !current)}
                aria-label={showFullSection ? "Show short reply" : "Show full reply"}
                title={showFullSection ? "Show short reply" : "Show full reply"}
                className="grid h-6 w-6 place-items-center rounded-md border border-[var(--color-line)] bg-[var(--color-bg)] text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                {showFullSection ? (
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 7h16" />
                    <path d="M4 12h10" />
                    <path d="M4 17h7" />
                  </svg>
                ) : (
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 6h16" />
                    <path d="M4 12h16" />
                    <path d="M4 18h16" />
                  </svg>
                )}
              </button>
            ) : null}
            {actions}
          </span>
        </div>
        <div
          className="md md-compact break-words text-sm leading-relaxed text-[var(--color-text)] [overflow-wrap:anywhere]"
          dangerouslySetInnerHTML={renderFullMarkdown(displayBody)}
        />
        {deliveryStatus ? (
          <div className={`mt-2 text-[10px] font-semibold uppercase tracking-wider ${deliveryStatus === "failed" ? "text-[var(--color-crit)]" : "text-[var(--color-text-muted)]"}`}>
            {deliveryStatus === "failed" ? "Failed to send" : "Sending..."}
          </div>
        ) : null}
        {projectSlug && surface && parsedOptions.options.length > 0 ? (
          <PmOptions
            projectSlug={projectSlug}
            sourceMessageId={message.id}
            surface={surface}
            options={parsedOptions.options}
            resolvedOption={resolvedOption}
            interactive={isPmOptionsTargetedAtCurrentUser({
              currentUserId,
              targetType: message.targetType,
              targetValue: message.targetValue,
            })}
          />
        ) : null}
      </article>
      {fromCurrentUser ? <MessageAvatar actor={message.sender} /> : null}
    </div>
  );
}
