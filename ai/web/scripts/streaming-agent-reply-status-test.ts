import assert from "node:assert/strict";
import {
  RECONNECTING_DEBOUNCE_MS,
  RECONNECTING_STUCK_MS,
  reconnectingCopy,
  waitingCopy,
  shouldShowTypingDots,
} from "../lib/agents/streaming-agent-reply-status";

assert.equal(reconnectingCopy(null), null, "normal streaming should not show a reconnect chip");
assert.equal(
  reconnectingCopy(RECONNECTING_DEBOUNCE_MS - 1),
  null,
  "transient reconnect blips stay quiet before the debounce",
);
assert.equal(
  reconnectingCopy(RECONNECTING_DEBOUNCE_MS),
  "reconnecting...",
  "after the debounce, show a quiet reconnecting chip",
);
assert.equal(
  reconnectingCopy(RECONNECTING_STUCK_MS - 1),
  "reconnecting...",
  "the stuck-state copy is suppressed until roughly 10s of reconnecting",
);
assert.equal(
  reconnectingCopy(RECONNECTING_STUCK_MS),
  "connection is still recovering...",
  "after roughly 10s, escalate from the quiet reconnect chip",
);
assert.equal(
  waitingCopy({ status: "pending", runStatus: "queued", error: null }),
  "queued...",
  "pending replies use the queued degraded-mode copy before any SSE event",
);
assert.equal(
  shouldShowTypingDots({ status: "pending", text: "" }),
  true,
  "pending replies show typing dots before the first SSE event",
);
assert.equal(
  shouldShowTypingDots({ status: "thinking", text: "" }),
  true,
  "thinking replies show typing dots before the first token",
);
assert.equal(
  shouldShowTypingDots({ status: "streaming", lifecycleStatus: "thinking", text: "" }),
  true,
  "status:thinking lifecycle events keep typing dots visible",
);
assert.equal(
  shouldShowTypingDots({ status: "pending", text: "hello" }),
  false,
  "first text token replaces pending dots",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "queued", error: null }),
  "queued...",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "retryable", error: null }),
  "retrying...",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "streaming", error: null }),
  "working...",
  "streaming copy must not use elapsed-time phase labels",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "accepted", error: null }),
  "working...",
  "accepted copy falls back to generic work until a real event-specific state arrives",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "streaming", lifecycleStatus: "thinking", error: null }),
  "Thinking...",
  "typed lifecycle status events may provide visible copy",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "streaming", lifecycleStatus: "reading", error: null }),
  "Reading...",
  "typed lifecycle status events may provide visible copy",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "streaming", toolStatus: "call", toolName: "grep", error: null }),
  "Using grep...",
  "typed tool events may provide visible copy",
);
assert.equal(
  waitingCopy({ status: "error", runStatus: "failed", error: "boom" }),
  "boom",
);

console.log("streaming-agent-reply-status tests passed");
