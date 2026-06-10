export type StreamingReplyRunStatus = "queued" | "accepted" | "streaming" | "retryable" | "complete" | "failed";
export type StreamingReplyStatus = "connecting" | "streaming" | "done" | "error";

export const RECONNECTING_DEBOUNCE_MS = 1_200;
export const RECONNECTING_STUCK_MS = 10_000;

export function formatStreamingReplyElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function waitingCopy(args: {
  status: StreamingReplyStatus;
  runStatus?: StreamingReplyRunStatus;
  lifecycleStatus?: "thinking" | "reading" | "working" | null;
  toolStatus?: "call" | "result" | null;
  toolName?: string | null;
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

  if (args.toolStatus === "call") {
    return args.toolName ? `Using ${args.toolName}...` : "Using tool...";
  }
  if (args.toolStatus === "result") {
    return args.toolName ? `Read ${args.toolName} result...` : "Reading tool result...";
  }
  if (args.lifecycleStatus === "thinking") return "Thinking...";
  if (args.lifecycleStatus === "reading") return "Reading...";
  if (args.lifecycleStatus === "working") return "Working...";

  const phases = [
    { until: 4_000, label: "Waking..." },
    { until: 12_000, label: "Thinking..." },
    { until: 24_000, label: "Reading..." },
    { until: 40_000, label: "Planning..." },
    { until: 64_000, label: "Writing..." },
    { until: 92_000, label: "Checking..." },
    { until: Number.POSITIVE_INFINITY, label: "Sending..." },
  ];
  return phases.find((phase) => args.elapsedMs < phase.until)?.label ?? "Sending...";
}

export function reconnectingCopy(reconnectingMs: number | null) {
  if (reconnectingMs === null) return null;
  if (reconnectingMs < RECONNECTING_DEBOUNCE_MS) return null;
  if (reconnectingMs < RECONNECTING_STUCK_MS) return "reconnecting...";
  return "connection is still recovering...";
}
