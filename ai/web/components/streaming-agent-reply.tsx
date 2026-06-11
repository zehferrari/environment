"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistentPmStream } from "@/components/persistent-pm-stream-provider";
import { MessageAvatar, type MessageActor } from "@/components/message-avatar";
import { extractDiscussionSectionA } from "@/lib/agents/discussion-reply-format";
import { renderFullMarkdown } from "@/lib/markdown";
import { sendNativePmReplyNotification } from "@/lib/agents/native-pm-notifications";
import {
  reconnectingCopy,
  waitingCopy,
  shouldShowTypingDots,
  type StreamingReplyRunStatus,
  type StreamingReplyStatus,
} from "@/lib/agents/streaming-agent-reply-status";

type TargetKind = "direct" | "task-chat" | "task-comment" | "epic-chat";

type StreamState = {
  text?: string;
  reasoning?: string;
  status?: "streaming" | "done" | "error";
  lifecycleStatus?: "thinking" | "reading" | "working" | null;
  toolStatus?: "call" | "result" | null;
  toolName?: string | null;
  runStatus?: StreamingReplyRunStatus;
  error?: string | null;
  updatedAt?: number;
};

interface StreamingAgentReplyProps {
  targetKind: TargetKind;
  agentSlug: string;
  messageId: string;
  taskId?: string;
  epicId?: string;
  label: string;
  className?: string;
  anonymizeTyping?: boolean;
  initialStatus?: StreamingReplyStatus;
  onFinal?: (payload: { agentSlug: string; text: string; reasoning: string; status: "done" | "error" }) => void;
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-1 pl-1.5" aria-hidden="true">
      <style>{`
        @keyframes pm-typing-dot {
          0%, 80%, 100% { transform: translateY(2px); opacity: 0.55; }
          38% { transform: translateY(-5px); opacity: 1; }
        }
      `}</style>
      <span className="h-1 w-1 rounded-full bg-current [animation:pm-typing-dot_720ms_cubic-bezier(0.33,0,0.2,1)_infinite] [animation-delay:-280ms]" />
      <span className="h-1 w-1 rounded-full bg-current [animation:pm-typing-dot_720ms_cubic-bezier(0.33,0,0.2,1)_infinite] [animation-delay:-140ms]" />
      <span className="h-1 w-1 rounded-full bg-current [animation:pm-typing-dot_720ms_cubic-bezier(0.33,0,0.2,1)_infinite]" />
    </span>
  );
}

const ANONYMOUS_TYPING_IDLE_MS = 8_000;

export default function StreamingAgentReply({
  targetKind,
  agentSlug,
  messageId,
  taskId,
  epicId,
  label,
  className = "",
  anonymizeTyping = false,
  initialStatus = "pending",
  onFinal,
}: StreamingAgentReplyProps) {
  const stream = usePersistentPmStream({ targetKind, agentSlug, messageId, taskId, epicId }, initialStatus);
  const {
    text,
    reasoning,
    status,
    runStatus,
    lifecycleStatus,
    toolStatus,
    toolName,
    error,
    startedAt,
    lastUpdateAt,
    connectionIssueAt,
  } = stream;
  const finalNotifiedRef = useRef(false);
  const latestTextRef = useRef("");
  const latestReasoningRef = useRef("");
  const onFinalRef = useRef(onFinal);

  useEffect(() => {
    latestTextRef.current = text;
  }, [text]);

  useEffect(() => {
    latestReasoningRef.current = reasoning;
  }, [reasoning]);

  useEffect(() => {
    onFinalRef.current = onFinal;
  }, [onFinal]);

  useEffect(() => {
    finalNotifiedRef.current = false;
  }, [targetKind, agentSlug, messageId, taskId, epicId]);

  const notifyFinal = useCallback((payload: StreamState | null, finalStatus: "done" | "error") => {
    if (finalNotifiedRef.current) return;
    finalNotifiedRef.current = true;
    const finalText = payload?.text ?? latestTextRef.current;
    const finalReasoning = payload?.reasoning ?? latestReasoningRef.current;
    if (finalStatus === "done") {
      sendNativePmReplyNotification({
        targetKind,
        agentLabel: label,
        text: finalText,
        tag: `pm-reply:${targetKind}:${messageId}:${agentSlug}`,
      });
    }
    onFinalRef.current?.({
      agentSlug,
      text: finalText,
      reasoning: finalReasoning,
      status: finalStatus,
    });
  }, [agentSlug, label, messageId, targetKind]);

  useEffect(() => {
    if (status === "done" || status === "error") {
      notifyFinal({ text, reasoning }, status);
    }
  }, [notifyFinal, reasoning, status, text]);

  const [showReasoning, setShowReasoning] = useState(true);
  const actor: MessageActor = {
    username: agentSlug,
    kind: "agent",
    name: label,
    agent: { slug: agentSlug, name: label, avatar: "placeholder" },
  };

  // Memoize the per-render markdown parse: this component re-renders on every
  // stream event (including heartbeats and reasoning-only deltas that leave the
  // reply text unchanged), and re-parsing the whole accumulated reply each time
  // is wasted main-thread work during streaming. Keyed on the text it derives
  // from, so a parse only happens when the rendered content actually changes.
  const displayText = useMemo(
    () => (targetKind === "task-chat" || targetKind === "epic-chat" ? extractDiscussionSectionA(text) : text),
    [targetKind, text],
  );
  const markdownHtml = useMemo(() => renderFullMarkdown(displayText), [displayText]);

  if (status === "done") return null;

  const waitLabel = waitingCopy({
    status,
    runStatus,
    lifecycleStatus,
    toolStatus,
    toolName,
    error,
  });
  const reconnectingMs = status !== "error" && connectionIssueAt !== null
    ? Date.now() - connectionIssueAt
    : null;
  const reconnectLabel = reconnectingCopy(reconnectingMs);
  const liveStateLabel = status === "error" ? "stream error" : waitLabel;
  const liveTone = status === "error"
    ? "border-[var(--color-crit)]/30 bg-[var(--color-crit)]/[0.06] text-[var(--color-crit)]"
    : "border-[var(--color-accent)]/20 bg-[var(--color-panel-soft)] text-[var(--color-text-muted)]";

  if (!text.trim() && !reasoning.trim()) {
    if (connectionIssueAt !== null && reconnectLabel === null) return null;
    const typingLastSeenAt = lastUpdateAt ?? startedAt;
    if (anonymizeTyping && status !== "error" && Date.now() - typingLastSeenAt > ANONYMOUS_TYPING_IDLE_MS) return null;
    const typingText = anonymizeTyping && status !== "error"
      ? `${label} typing`
      : reconnectLabel ?? waitLabel;
    return (
      <div className={`flex items-start gap-2.5 ${className}`}>
        <MessageAvatar actor={actor} />
        <div className={`w-fit max-w-[min(34rem,82%)] rounded-[1.15rem] rounded-bl-md border px-3.5 py-2.5 text-sm shadow-[0_8px_22px_rgba(15,23,42,0.05)] ring-1 ring-black/[0.02] ${liveTone}`}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full border border-current/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
              {status === "error" ? "failed" : reconnectLabel ? "sync" : anonymizeTyping ? "typing" : runStatus === "accepted" ? "accepted" : "live"}
            </span>
            <span className="min-w-0 break-words">{typingText}</span>
            {status === "error" || reconnectLabel ? null : <TypingDots />}
          </div>
          {status === "error" || reconnectLabel ? null : (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span>{waitLabel}</span>
              <span className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--color-line)]">
                <span className="block h-full w-1/2 animate-pulse rounded-full bg-[var(--color-accent)]/60" />
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-2.5 ${className}`}>
      <MessageAvatar actor={actor} />
      <div className="w-fit min-w-0 max-w-[min(44rem,82%)] rounded-[1.15rem] rounded-bl-md border border-[var(--color-accent)]/20 bg-[var(--color-panel)] px-4 py-3 shadow-[0_8px_22px_rgba(15,23,42,0.05)] ring-1 ring-black/[0.02]">
        <div className="mb-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          <span>{label} / live reply</span>
          <span>{liveStateLabel}</span>
        </div>

        {/* Collapsible Reasoning Thought Process Block */}
        {reasoning.trim() ? (
          <details
            className="mb-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3 text-xs text-[var(--color-text-muted)] font-mono group"
            open={showReasoning}
            onToggle={(e) => setShowReasoning(e.currentTarget.open)}
          >
            <summary className="flex items-center justify-between gap-1.5 font-semibold text-[10px] uppercase tracking-wider mb-2 border-b border-[var(--color-line)] pb-1 cursor-pointer outline-none list-none [&::-webkit-details-marker]:hidden select-none">
              <span className="flex items-center gap-1.5">
                <span>Thought Process</span>
                {shouldShowTypingDots({ status, text, lifecycleStatus }) && <TypingDots />}
              </span>
              <span className="text-[9px] font-normal normal-case text-[var(--color-text-muted)] opacity-60">
                {showReasoning ? "click to hide" : "click to show"}
              </span>
            </summary>
            <div className="whitespace-pre-wrap leading-relaxed mt-2">{reasoning}</div>
          </details>
        ) : null}

        {/* Main Message Content */}
        {displayText.trim() ? (
          <div
            className="md md-compact break-words text-sm leading-relaxed text-[var(--color-text)] [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={markdownHtml}
          />
        ) : status !== "error" && !reasoning.trim() ? (
          <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-1">
            working... <TypingDots />
          </div>
        ) : null}
      </div>
    </div>
  );
}
