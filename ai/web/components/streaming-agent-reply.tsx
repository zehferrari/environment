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
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-0.5 pl-1" aria-hidden="true">
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-240ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:-120ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current" />
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
  agentSlug: string;
}) {
  if (args.status === "error") {
    return args.error ?? "Agent stream failed";
  }
  if (args.status === "connecting") {
    return "Connecting to live reply";
  }
  if (args.runStatus === "queued") {
    return `Queued for @${args.agentSlug}`;
  }
  if (args.runStatus === "retryable") {
    return `Retrying @${args.agentSlug}`;
  }
  if (args.runStatus === "accepted" && args.elapsedMs < 12_000) {
    return `Delivered to @${args.agentSlug}`;
  }
  if (args.elapsedMs < 30_000) {
    return `@${args.agentSlug} is starting`;
  }
  if (args.elapsedMs < 90_000) {
    return `Still waiting for @${args.agentSlug}'s first token`;
  }
  return `Still checking @${args.agentSlug}'s saved reply`;
}

export default function StreamingAgentReply({
  targetKind,
  agentSlug,
  messageId,
  taskId,
  epicId,
  label,
  className = "",
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

  if (finalized) return null;

  const waitLabel = waitingCopy({
    status,
    runStatus,
    elapsedMs,
    error,
    agentSlug,
  });
  const displayText = targetKind === "task-chat" || targetKind === "epic-chat"
    ? extractDiscussionSectionA(text)
    : text;
  const elapsedLabel = formatElapsed(lastUpdateAt ? Date.now() - lastUpdateAt : elapsedMs);
  const liveTone = status === "error"
    ? "border-[var(--color-crit)]/30 bg-[var(--color-crit)]/[0.06] text-[var(--color-crit)]"
    : "border-[var(--color-accent)]/20 bg-[var(--color-panel-soft)] text-[var(--color-text-muted)]";

  if (!text.trim() && !reasoning.trim()) {
    return (
      <div className={`flex items-start gap-2.5 ${className}`}>
        <MessageAvatar actor={actor} />
        <div className={`w-fit max-w-[min(34rem,82%)] rounded-[1.15rem] rounded-bl-md border px-3.5 py-2.5 text-sm shadow-[0_8px_22px_rgba(15,23,42,0.05)] ring-1 ring-black/[0.02] ${liveTone}`}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full border border-current/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
              {status === "error" ? "failed" : runStatus === "accepted" ? "accepted" : "live"}
            </span>
            <span className="min-w-0 break-words">{waitLabel}</span>
            {status === "error" ? null : <TypingDots />}
          </div>
          {status === "error" ? null : (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
              <span>waiting {formatElapsed(elapsedMs)}</span>
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
