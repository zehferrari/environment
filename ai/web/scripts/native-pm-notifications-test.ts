import assert from "node:assert/strict";
import {
  compactNativePmNotificationBody,
  shouldSendNativePmNotification,
} from "../lib/agents/pm-channel/native-pm-notifications";

const base = {
  supported: true,
  enabled: true,
  permission: "granted" as const,
  visibilityState: "hidden" as const,
  hasFocus: false,
  targetKind: "task-chat" as const,
  status: "done" as const,
  text: "Agent reply body",
};

assert.equal(shouldSendNativePmNotification(base), true, "notifies for opted-in hidden task chat final replies");
assert.equal(shouldSendNativePmNotification({ ...base, visibilityState: "visible", hasFocus: true }), false, "does not notify when tab is visible and focused");
assert.equal(shouldSendNativePmNotification({ ...base, permission: "default" }), false, "does not notify while permission is still default");
assert.equal(shouldSendNativePmNotification({ ...base, permission: "denied" }), false, "does not notify when permission is denied");
assert.equal(shouldSendNativePmNotification({ ...base, enabled: false }), false, "does not notify before explicit opt-in");
assert.equal(shouldSendNativePmNotification({ ...base, supported: false, permission: "unsupported" }), false, "unsupported browsers are safe no-ops");
assert.equal(shouldSendNativePmNotification({ ...base, targetKind: "task-comment" }), false, "task-comment streams are not open chat replies");
assert.equal(shouldSendNativePmNotification({ ...base, status: "error" }), false, "stream errors do not produce reply notifications");
assert.equal(shouldSendNativePmNotification({ ...base, text: "   " }), false, "blank final replies do not notify");
assert.equal(shouldSendNativePmNotification({ ...base, visibilityState: "visible", hasFocus: false }), true, "visible but unfocused windows notify");

const compacted = compactNativePmNotificationBody("  hello\n\nthere   friend  ", 20);
assert.equal(compacted, "hello there friend", "notification bodies collapse whitespace");
assert.equal(compactNativePmNotificationBody("x".repeat(50), 10), "xxxxxxxxx…", "long bodies are truncated");

console.log("native PM notification decision tests passed");
