"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReconnectableSSE } from "@/hooks/use-reconnectable-sse";
import { MessageAvatar, type MessageActor } from "@/components/message-avatar";
import { extractDiscussionSectionA } from "@/lib/agents/discussion-reply-format";
import {
  reconnectingCopy,
  waitingCopy,
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

function applyStreamState(
  incoming: StreamState,
  setText: (value: string | ((prev: string) => string)) => void,
  setReasoning: (value: string | ((prev: string) => string)) => void,
  setStatus: (value: StreamingReplyStatus) => void,
  setRunStatus: (value: StreamState["runStatus"]) => void,
) {
  if (typeof incoming.text === "string") setText(incoming.text);
  if (typeof incoming.reasoning === "string") setReasoning(incoming.reasoning);
  if (incoming.runStatus) setRunStatus(incoming.runStatus);
  if (incoming.status === "done") setStatus("done");
  else if (incoming.status === "error") setStatus("error");
  else setStatus("streaming");
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
  onFinal,
}: StreamingAgentReplyProps) {
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [status, setStatus] = useState<StreamingReplyStatus>("connecting");
  const [runStatus, setRunStatus] = useState<StreamState["runStatus"]>("queued");
  const [lifecycleStatus, setLifecycleStatus] = useState<StreamState["lifecycleStatus"]>(null);
  const [toolStatus, setToolStatus] = useState<StreamState["toolStatus"]>(null);
  const [toolName, setToolName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [connectionIssueAt, setConnectionIssueAt] = useState<number | null>(null);
  const [finalized, setFinalized] = useState(false);
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

  const url = useMemo(() => {
    const params = new URLSearchParams({
      kind: targetKind,
      agentSlug,
      messageId,
    });
    if (taskId) params.set("taskId", taskId);
    if (epicId) params.set("epicId", epicId);
    return `/api/openclaw/pm-channel/events?${params.toString()}`;
  }, [agentSlug, messageId, targetKind, taskId, epicId]);

  const notifyFinal = useCallback((payload: StreamState | null, finalStatus: "done" | "error") => {
    if (finalNotifiedRef.current) return;
    finalNotifiedRef.current = true;
    onFinalRef.current?.({
      agentSlug,
      text: payload?.text ?? latestTextRef.current,
      reasoning: payload?.reasoning ?? latestReasoningRef.current,
      status: finalStatus,
    });
  }, [agentSlug]);

  const { connect, disconnect, setLastEventId } = useReconnectableSSE();

  useEffect(() => {
    finalNotifiedRef.current = false;
    setFinalized(false);
    setLastEventId("");

    const stateEventTypes = new Set([
      "snapshot",
      "status",
      "status:thinking",
      "status:reading",
      "status:working",
      "tool:call",
      "tool:result",
      "token",
      "partial",
      "reasoning",
      "final",
      "done",
    ]);

    connect({
      url,
      onEvent(event) {
        if (event.event === "heartbeat") {
          setLastUpdateAt((current) => current ?? Date.now());
          setConnectionIssueAt(null);
          setStatus((current) => current === "connecting" ? "streaming" : current);
          return;
        }

        if (event.event === "stream-error") {
          let payload: StreamState | null = null;
          try { payload = JSON.parse(event.data) as StreamState; } catch { /* ignore */ }
          setError(payload?.error ?? "Agent stream failed");
          setConnectionIssueAt(null);
          setRunStatus("failed");
          setStatus("error");
          setLastUpdateAt(payload?.updatedAt ?? Date.now());
          notifyFinal(payload, "error");
          // Terminal error — don't reconnect
          disconnect();
          return;
        }

        if (stateEventTypes.has(event.event)) {
          let payload: StreamState | null = null;
          try { payload = JSON.parse(event.data) as StreamState; } catch { return; }
          if (!payload) return;
          setError(payload.error ?? null);
          setConnectionIssueAt(null);
          setLifecycleStatus(payload.lifecycleStatus ?? null);
          setToolStatus(payload.toolStatus ?? null);
          setToolName(payload.toolName ?? null);
          setLastUpdateAt(payload.updatedAt ?? Date.now());
          applyStreamState(payload, setText, setReasoning, setStatus, setRunStatus);
          if (payload.status === "done") {
            setFinalized(true);
            notifyFinal(payload, "done");
            disconnect();
          } else if (payload.status === "error") {
            notifyFinal(payload, "error");
            disconnect();
          }
          return;
        }
      },
      onConnected() {
        setConnectionIssueAt(null);
      },
      onError(attempt) {
        setStatus((current) => {
          if (current === "done" || current === "error") return current;
          setConnectionIssueAt((existing) => existing ?? Date.now());
          return "connecting";
        });
      },
      onReconnect(attempt, delayMs) {
        setStatus((current) => {
          if (current === "done" || current === "error") return current;
          setConnectionIssueAt((existing) => existing ?? Date.now());
          return "connecting";
        });
      },
      shouldReconnect() {
        // Only reconnect if we haven't reached a terminal state
        // Read the latest finalized value via ref to avoid stale closures
        return !finalNotifiedRef.current;
      },
    });

    return () => {
      disconnect();
    };
  }, [agentSlug, url, connect, disconnect, notifyFinal, setLastEventId]);

  const [showReasoning, setShowReasoning] = useState(true);
  const actor: MessageActor = {
    username: agentSlug,
    kind: "agent",
    name: label,
    agent: { slug: agentSlug, name: label, avatar: "placeholder" },
  };

  if (finalized) return null;

  const waitLabel = waitingCopy({
    status,
    runStatus,
    lifecycleStatus,
    toolStatus,
    toolName,
    error,
  });
  const reconnectingMs = status !== "done" && status !== "error" && connectionIssueAt !== null
    ? Date.now() - connectionIssueAt
    : null;
  const reconnectLabel = reconnectingCopy(reconnectingMs);
  const displayText = targetKind === "task-chat" || targetKind === "epic-chat"
    ? extractDiscussionSectionA(text)
    : text;
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
          <span>{status === "done" ? "finalizing" : liveStateLabel}</span>
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
                {status === "streaming" && !text && <TypingDots />}
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
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {displayText}
          </div>
        ) : status !== "error" && !reasoning.trim() ? (
          <div className="text-xs text-[var(--color-text-muted)] flex items-center gap-1">
            working... <TypingDots />
          </div>
        ) : null}
      </div>
    </div>
  );
}
