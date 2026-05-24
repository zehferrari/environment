"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type TargetKind = "direct" | "task-chat" | "task-comment";

type StreamState = {
  text?: string;
  status?: "streaming" | "done" | "error";
  error?: string | null;
};

interface StreamingAgentReplyProps {
  targetKind: TargetKind;
  agentSlug: string;
  messageId: string;
  taskId?: string;
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
  setStatus: (value: "connecting" | "streaming" | "done" | "error") => void,
) {
  if (typeof incoming.text === "string") setText(incoming.text);
  if (incoming.status === "done") setStatus("done");
  else if (incoming.status === "error") setStatus("error");
  else setStatus("streaming");
}

export default function StreamingAgentReply({
  targetKind,
  agentSlug,
  messageId,
  taskId,
  label,
  className = "",
}: StreamingAgentReplyProps) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"connecting" | "streaming" | "done" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams({
      kind: targetKind,
      agentSlug,
      messageId,
    });
    if (taskId) params.set("taskId", taskId);
    return `/api/openclaw/pm-channel/events?${params.toString()}`;
  }, [agentSlug, messageId, targetKind, taskId]);

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
      applyStreamState(payload, setText, setStatus);
      if (payload.status === "done") refreshSoon();
    };

    const onErrorEvent = (event: MessageEvent<string>) => {
      const payload = parse(event);
      setError(payload?.error ?? "Agent stream failed");
      setStatus("error");
    };

    source.addEventListener("snapshot", onState);
    source.addEventListener("partial", onState);
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

  if (!text.trim()) {
    return (
      <div className={`inline-flex max-w-xs items-center rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm text-[var(--color-text-muted)] ${className}`}>
        {status === "error" ? (error ?? "Agent stream failed") : `${label} is typing`}
        {status === "error" ? null : <TypingDots />}
      </div>
    );
  }

  return (
    <div className={`max-w-3xl rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2 ${className}`}>
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        <span>{label} / streaming</span>
        <span>{status === "done" ? "finalizing" : status === "error" ? "stream error" : "live"}</span>
      </div>
      <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{text}</div>
    </div>
  );
}
