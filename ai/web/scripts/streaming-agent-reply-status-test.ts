import assert from "node:assert/strict";
import {
  RECONNECTING_DEBOUNCE_MS,
  RECONNECTING_STUCK_MS,
  reconnectingCopy,
  waitingCopy,
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
  waitingCopy({ status: "streaming", runStatus: "streaming", elapsedMs: 124_999, error: null }),
  "Sending...",
);
assert.equal(
  waitingCopy({ status: "streaming", runStatus: "streaming", elapsedMs: 125_000, error: null }),
  "Sending...",
  "the old 125s recovery copy must not reappear",
);
assert.notEqual(
  waitingCopy({ status: "streaming", runStatus: "streaming", elapsedMs: 180_000, error: null }),
  ["Recovering", " reply..."].join(""),
);

console.log("streaming-agent-reply-status tests passed");
