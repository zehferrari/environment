"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageAvatar, type MessageActor } from "@/components/message-avatar";
import { extractDiscussionSectionA } from "@/lib/agents/discussion-reply-format";

type TargetKind = "direct" | "task-chat" | "task-comment" | "epic-chat";

type StreamState = {
  text?: string;
  reasoning?: string;
  status?: "streaming" | "done" | "error";
  runStatus?: "queued" | "accepted" | "streaming" | "retryable" | "complete" | "failed";
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
  typingSlotIndex?: number;
  typingSlotTotal?: number;
}

export function anonymousTypingLabel(total: number) {
  const count = Math.max(1, Math.min(4, Math.floor(total)));
  return `${Array.from({ length: count }, () => "🤖").join(" + ")} typing`;
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
  setStatus: (value: "connecting" | "streaming" | "done" | "error") => void,
  setRunStatus: (value: StreamState["runStatus"]) => void,
) {
  if (typeof incoming.text === "string") setText(incoming.text);
  if (typeof incoming.reasoning === "string") setReasoning(incoming.reasoning);
  if (incoming.runStatus) setRunStatus(incoming.runStatus);
  if (incoming.status === "done") setStatus("done");
  else if (incoming.status === "error") setStatus("error");
  else setStatus("streaming");
}

const REFRESH_FALLBACK_MS = 8_000;
const ANONYMOUS_TYPING_IDLE_MS = 8_000;

function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function waitingCopy(args: {
  status: "connecting" | "streaming" | "done" | "error";
  runStatus?: StreamState["runStatus"];
  elapsedMs: number;
  error: string | null;
}) {
  if (args.status === "error") {
    return args.error ?? "Agent stream failed";
  }
  if (args.runStatus === "queued") {
    return "Queued...";
  }
  if (args.runStatus === "retryable") {
    return "Retrying...";
  }

  const phases = [
    { until: 4_000, label: "Waking..." },
    { until: 12_000, label: "Thinking..." },
    { until: 24_000, label: "Reading..." },
    { until: 40_000, label: "Planning..." },
    { until: 64_000, label: "Writing..." },
    { until: 92_000, label: "Checking..." },
    { until: 125_000, label: "Sending..." },
  ];
  return phases.find((phase) => args.elapsedMs < phase.until)?.label ?? "Recovering reply...";
}

export default function StreamingAgentReply({
  targetKind,
  agentSlug,
  messageId,
  taskId,
  epicId,
  label,
  className = "",
  anonymizeTyping = false,
  typingSlotIndex = 0,
  typingSlotTotal = 1,
}: StreamingAgentReplyProps) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [status, setStatus] = useState<"connecting" | "streaming" | "done" | "error">("connecting");
  const [runStatus, setRunStatus] = useState<StreamState["runStatus"]>("queued");
  const [error, setError] = useState<string | null>(null);
  const [startedAt] = useState(() => Date.now());
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finalized, setFinalized] = useState(false);

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

  useEffect(() => {
    let refreshTimer: number | undefined;
    let refreshInterval: number | undefined;
    const source = new EventSource(url);

    const refreshSoon = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => router.refresh(), 25);
    };
    refreshInterval = window.setInterval(refreshSoon, REFRESH_FALLBACK_MS);

    const parse = (event: MessageEvent<string>) => {
      try {
        return JSON.parse(event.data) as StreamState;
      } catch {
        return null;
      }
    };

    const onState = (event: MessageEvent<string>) => {
      const payload = parse(event);
      if (!payload) return;
      setError(payload.error ?? null);
      setLastUpdateAt(payload.updatedAt ?? Date.now());
      applyStreamState(payload, setText, setReasoning, setStatus, setRunStatus);
      if (payload.status === "done") {
        setFinalized(true);
        window.clearInterval(refreshInterval);
        source.close();
        refreshSoon();
      } else if (payload.status === "error") {
        window.clearInterval(refreshInterval);
        refreshSoon();
      }
    };

    const onErrorEvent = (event: MessageEvent<string>) => {
      const payload = parse(event);
      setError(payload?.error ?? "Agent stream failed");
      setRunStatus("failed");
      setStatus("error");
      setLastUpdateAt(payload?.updatedAt ?? Date.now());
      window.clearInterval(refreshInterval);
      refreshSoon();
    };

    const onHeartbeat = () => {
      setLastUpdateAt((current) => current ?? Date.now());
      setStatus((current) => current === "connecting" ? "streaming" : current);
    };

    source.addEventListener("snapshot", onState);
    source.addEventListener("partial", onState);
    source.addEventListener("reasoning", onState);
    source.addEventListener("final", onState);
    source.addEventListener("done", onState);
    source.addEventListener("stream-error", onErrorEvent);
    source.addEventListener("heartbeat", onHeartbeat);
    source.onerror = () => {
      refreshSoon();
      setStatus((current) => {
        if (current === "done" || current === "error") {
          window.clearInterval(refreshInterval);
          return current;
        }
        return "connecting";
      });
    };

    return () => {
      window.clearTimeout(refreshTimer);
      window.clearInterval(refreshInterval);
      source.close();
    };
  }, [router, url]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  const [showReasoning, setShowReasoning] = useState(true);
  const actor: MessageActor = {
    username: agentSlug,
    kind: "agent",
    name: label,
    agent: { slug: agentSlug, name: label, avatar: "placeholder" },
  };
  const anonymousTypingActor: MessageActor = {
    username: "agent",
    kind: "agent",
    name: "Agent",
    agent: null,
  };

  if (finalized) return null;

  const waitLabel = waitingCopy({
    status,
    runStatus,
    elapsedMs,
    error,
  });
  const displayText = targetKind === "task-chat" || targetKind === "epic-chat"
    ? extractDiscussionSectionA(text)
    : text;
  const elapsedLabel = formatElapsed(lastUpdateAt ? Date.now() - lastUpdateAt : elapsedMs);
  const liveTone = status === "error"
    ? "border-[var(--color-crit)]/30 bg-[var(--color-crit)]/[0.06] text-[var(--color-crit)]"
    : "border-[var(--color-accent)]/20 bg-[var(--color-panel-soft)] text-[var(--color-text-muted)]";

  if (!text.trim() && !reasoning.trim()) {
    const typingLastSeenAt = lastUpdateAt ?? startedAt;
    if (anonymizeTyping && status !== "error" && Date.now() - typingLastSeenAt > ANONYMOUS_TYPING_IDLE_MS) return null;
    if (anonymizeTyping && typingSlotIndex > 0 && status !== "error") return null;
    const typingActor = anonymizeTyping ? anonymousTypingActor : actor;
    const typingText = anonymizeTyping && status !== "error"
      ? anonymousTypingLabel(typingSlotTotal)
      : waitLabel;
    return (
      <div className={`flex items-start gap-2.5 ${className}`}>
        {anonymizeTyping ? (
          <div
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] text-lg shadow-sm"
            title="Agent typing"
            aria-label="Anonymous agent typing avatar"
          >
            🤖
          </div>
        ) : (
          <MessageAvatar actor={typingActor} />
        )}
        <div className={`w-fit max-w-[min(34rem,82%)] rounded-[1.15rem] rounded-bl-md border px-3.5 py-2.5 text-sm shadow-[0_8px_22px_rgba(15,23,42,0.05)] ring-1 ring-black/[0.02] ${liveTone}`}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full border border-current/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
              {status === "error" ? "failed" : anonymizeTyping ? "typing" : runStatus === "accepted" ? "accepted" : "live"}
            </span>
            <span className="min-w-0 break-words">{typingText}</span>
            {status === "error" ? null : <TypingDots />}
          </div>
          {status === "error" ? null : (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span>active {formatElapsed(elapsedMs)}</span>
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
          <span>{status === "done" ? "finalizing" : status === "error" ? "stream error" : `active ${elapsedLabel}`}</span>
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
            Writing response <TypingDots />
          </div>
        ) : null}
      </div>
    </div>
  );
}
