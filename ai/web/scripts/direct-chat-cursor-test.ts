import assert from "node:assert/strict";
import { directChatCursorWhere, parseDirectChatCursor } from "@/lib/agents/chat/direct/cursor";
import { isTaskScopedDelivery } from "@/lib/pm-consumer/delivery-log";

const createdAt = "2026-06-11T15:08:15.312Z";
const id = "cmq9mty6v00jb5r0jyep3a3pj";
const cursor = parseDirectChatCursor(new URLSearchParams({ after: createdAt, afterId: id }));

assert.ok(cursor, "valid cursor parses");
assert.equal(cursor.createdAt.toISOString(), createdAt, "cursor createdAt is preserved");
assert.equal(cursor.id, id, "cursor id is preserved");
assert.deepEqual(
  directChatCursorWhere(cursor),
  {
    OR: [
      { createdAt: { gt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { gt: id } },
    ],
  },
  "cursor where uses (createdAt, id) semantics so same-timestamp later IDs are fetched",
);

assert.equal(parseDirectChatCursor(new URLSearchParams({ after: createdAt })), null, "missing id disables cursor");
assert.equal(parseDirectChatCursor(new URLSearchParams({ after: "not-a-date", afterId: id })), null, "invalid date disables cursor");

assert.equal(
  isTaskScopedDelivery({
    kind: "task.assigned",
    taskId: "task-1",
    taskKey: "ENV-1",
    projectKey: "ENV",
  }),
  true,
  "real PM task deliveries are task-scoped",
);
assert.equal(
  isTaskScopedDelivery({
    kind: "openclaw.pm_channel_turn",
    taskId: "",
    taskKey: "",
    projectKey: "",
  }),
  false,
  "native PM-channel placeholder rows are not task-scoped",
);

console.log("direct-chat-cursor-test: ok");
