"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MessageAvatar, type MessageActor } from "@/components/message-avatar";

type TargetKind = "direct" | "task-chat" | "task-comment" | "epic-chat";

type StreamState = {
  text?: string;
  reasoning?: string;
  status?: "streaming" | "done" | "error";
  error?: string | null;
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
) {
  if (typeof incoming.text === "string") setText(incoming.text);
  if (typeof incoming.reasoning === "string") setReasoning(incoming.reasoning);
  if (incoming.status === "done") setStatus("done");
  else if (incoming.status === "error") setStatus("error");
  else setStatus("streaming");
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
  const [error, setError] = useState<string | null>(null);

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
    const source = new EventSource(url);

    const refreshSoon = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => router.refresh(), 180);
    };

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
      applyStreamState(payload, setText, setReasoning, setStatus);
      if (payload.status === "done") refreshSoon();
    };

    const onErrorEvent = (event: MessageEvent<string>) => {
      const payload = parse(event);
      setError(payload?.error ?? "Agent stream failed");
      setStatus("error");
    };

    source.addEventListener("snapshot", onState);
    source.addEventListener("partial", onState);
    source.addEventListener("reasoning", onState);
    source.addEventListener("final", onState);
    source.addEventListener("done", onState);
    source.addEventListener("stream-error", onErrorEvent);
    source.onerror = () => {
      setStatus((current) => (current === "done" ? current : "connecting"));
    };

    return () => {
      window.clearTimeout(refreshTimer);
      source.close();
    };
  }, [router, url]);

  const [showReasoning, setShowReasoning] = useState(true);
  const actor: MessageActor = {
    username: agentSlug,
    kind: "agent",
    name: label,
    agent: { slug: agentSlug, name: label, avatar: null },
  };

  if (!text.trim() && !reasoning.trim()) {
    return (
      <div className={`flex items-start gap-2.5 ${className}`}>
        <MessageAvatar actor={actor} />
        <div className="relative inline-flex max-w-xs items-center rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3.5 py-2 text-sm text-[var(--color-text-muted)] shadow-sm">
          <span
            aria-hidden="true"
            className="absolute -left-1.5 top-4 h-3 w-3 rotate-45 border-b border-l border-[var(--color-line)] bg-[var(--color-panel-soft)]"
          />
          {status === "error" ? (error ?? "Agent stream failed") : "typing"}
          {status === "error" ? null : <TypingDots />}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-2.5 ${className}`}>
      <MessageAvatar actor={actor} />
      <div className="relative w-fit min-w-[11rem] max-w-[min(36rem,78%)] rounded-2xl border border-[var(--color-accent)]/25 bg-[var(--color-panel-soft)] px-4 py-3 shadow-sm">
        <span
          aria-hidden="true"
          className="absolute -left-1.5 top-4 h-3 w-3 rotate-45 border-b border-l border-[var(--color-accent)]/25 bg-[var(--color-panel-soft)]"
        />
        <div className="mb-2 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          <span>{label} / streaming</span>
          <span>{status === "done" ? "finalizing" : status === "error" ? "stream error" : "live"}</span>
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
        {text.trim() ? (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {text}
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
