export type StreamingReplyRunStatus = "queued" | "accepted" | "streaming" | "completed" | "failed" | "timed_out" | "cancelled" | "superseded";
export type StreamingReplyStatus = "pending" | "connecting" | "thinking" | "streaming" | "done" | "error";

export const RECONNECTING_DEBOUNCE_MS = 1_200;
export const RECONNECTING_STUCK_MS = 10_000;

export function waitingCopy(args: {
  status: StreamingReplyStatus;
  runStatus?: StreamingReplyRunStatus;
  lifecycleStatus?: "thinking" | "reading" | "working" | null;
  toolStatus?: "call" | "result" | null;
  toolName?: string | null;
  error: string | null;
}) {
  if (args.status === "error" || args.runStatus === "failed") {
    return args.error ?? "Agent stream failed";
  }
  if (args.runStatus === "cancelled") {
    return "cancelled";
  }
  if (args.runStatus === "queued") {
    return "queued...";
  }
  if (args.runStatus === "timed_out") {
    return "timed out";
  }
  if (args.runStatus === "superseded") {
    return "superseded";
  }
  if (args.runStatus === "retryable") {
    return "retrying...";
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

  return "working...";
}

export function shouldShowTypingDots(args: {
  status: StreamingReplyStatus;
  text?: string | null;
  lifecycleStatus?: "thinking" | "reading" | "working" | null;
}) {
  if (args.text?.trim()) return false;
  return args.status === "pending"
    || args.status === "thinking"
    || args.status === "streaming"
    || args.lifecycleStatus === "thinking";
}

export function reconnectingCopy(reconnectingMs: number | null) {
  if (reconnectingMs === null) return null;
  if (reconnectingMs < RECONNECTING_DEBOUNCE_MS) return null;
  if (reconnectingMs < RECONNECTING_STUCK_MS) return "reconnecting...";
  return "connection is still recovering...";
}
