import assert from "node:assert/strict";
import {
  tagsForTaskReplyScope,
  revalidateTaskReplyScope,
  taskCacheTag,
} from "../lib/tasks/cache";

const taskId = "task-123";

const chatTags = tagsForTaskReplyScope(taskId, "chat");
assert.deepEqual(chatTags, [
  taskCacheTag.chat(taskId),
  taskCacheTag.chatArchives(taskId),
  taskCacheTag.proposals(taskId),
]);
assert(!chatTags.includes(taskCacheTag.shell(taskId)), "chat reply must not invalidate task status/shell");
assert(!chatTags.includes(taskCacheTag.comments(taskId)), "chat reply must not invalidate comments");
assert(!chatTags.includes(taskCacheTag.attachments(taskId)), "chat reply must not invalidate attachments");
assert(!chatTags.includes(taskCacheTag.activity(taskId)), "chat reply must not invalidate activity");

const commentTags = tagsForTaskReplyScope(taskId, "comment");
assert.deepEqual(commentTags, [
  taskCacheTag.comments(taskId),
  taskCacheTag.activity(taskId),
]);
assert(!commentTags.includes(taskCacheTag.chat(taskId)), "comment reply must not invalidate chat");
assert(!commentTags.includes(taskCacheTag.attachments(taskId)), "comment reply must not invalidate attachments");

const revalidated: string[] = [];
revalidateTaskReplyScope(taskId, "chat", (tag) => revalidated.push(tag));
assert.deepEqual(revalidated, chatTags, "chat reply revalidates only the chat resource tags");

console.log("cache scope tests passed");
