import assert from "node:assert/strict";
import { generateClientMessageId, isValidClientMessageId } from "../lib/agents/ops/client-message-id";

const first = generateClientMessageId();
const second = generateClientMessageId();

assert.ok(isValidClientMessageId(first), "generated IDs must satisfy server validation");
assert.ok(isValidClientMessageId(second), "subsequent generated IDs must satisfy server validation");
assert.notEqual(first, second, "rapid consecutive sends must get distinct stable IDs");
assert.equal(isValidClientMessageId(""), false, "empty IDs are not valid client IDs");
assert.equal(isValidClientMessageId("cmq7tjzp2006e5r3y51wiwwik"), false, "server-generated cuid values are not accepted as client-supplied IDs");
assert.equal(isValidClientMessageId("clientmsg_not-a-uuid"), false, "malformed client IDs are rejected");

const optimistic = new Map<string, string>();
optimistic.set(first, "first draft");
optimistic.set(second, "second draft");
optimistic.set(first, "first persisted");
assert.equal(optimistic.size, 2, "reconciliation keyed by stable ID replaces only the matching optimistic row");
assert.equal(optimistic.get(first), "first persisted", "persisted row replaces its optimistic row by ID");

console.log("client-stable-message-ids: ok");
