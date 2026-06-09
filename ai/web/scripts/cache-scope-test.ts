import assert from "node:assert/strict";
import {
  tagsForTaskReplyScope,
  revalidateTaskReplyScope,
  revalidateTaskAttachments,
  taskCacheTag,
} from "../lib/tasks/cache";
import {
  epicCacheTag,
  revalidateEpicReplyScope,
  tagsForEpicReplyScope,
} from "../lib/epics/cache";

const taskId = "task-123";
const epicId = "epic-123";

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

const commentRevalidated: string[] = [];
revalidateTaskReplyScope(taskId, "comment", (tag) => commentRevalidated.push(tag));
assert.deepEqual(commentRevalidated, commentTags, "comment reply revalidates only comments + activity");
for (const off of [
  taskCacheTag.shell(taskId),
  taskCacheTag.description(taskId),
  taskCacheTag.chat(taskId),
  taskCacheTag.attachments(taskId),
]) {
  assert(!commentRevalidated.includes(off), `comment reply must not revalidate ${off}`);
}

const attachmentRevalidated: string[] = [];
revalidateTaskAttachments(taskId, (tag) => attachmentRevalidated.push(tag));
assert.deepEqual(
  attachmentRevalidated,
  [taskCacheTag.attachments(taskId), taskCacheTag.activity(taskId)],
  "attachment change revalidates only attachments + activity",
);
for (const off of [
  taskCacheTag.shell(taskId),
  taskCacheTag.description(taskId),
  taskCacheTag.comments(taskId),
  taskCacheTag.chat(taskId),
]) {
  assert(!attachmentRevalidated.includes(off), `attachment change must not revalidate ${off}`);
}

const epicChatTags = tagsForEpicReplyScope(epicId, "chat");
assert.deepEqual(epicChatTags, [
  epicCacheTag.chat(epicId),
  epicCacheTag.chatArchives(epicId),
  epicCacheTag.proposals(epicId),
]);
assert(!epicChatTags.includes(epicCacheTag.shell(epicId)), "epic chat reply must not invalidate epic shell");
assert(!epicChatTags.includes(epicCacheTag.tasks(epicId)), "epic chat reply must not invalidate epic tasks");
assert(!epicChatTags.includes(epicCacheTag.comments(epicId)), "epic chat reply must not invalidate comments");
assert(!epicChatTags.includes(epicCacheTag.attachments(epicId)), "epic chat reply must not invalidate attachments");
assert(!epicChatTags.includes(epicCacheTag.activity(epicId)), "epic chat reply must not invalidate activity");

const epicCommentTags = tagsForEpicReplyScope(epicId, "comment");
assert.deepEqual(epicCommentTags, [
  epicCacheTag.comments(epicId),
  epicCacheTag.activity(epicId),
]);
assert(!epicCommentTags.includes(epicCacheTag.chat(epicId)), "epic comment reply must not invalidate chat");
assert(!epicCommentTags.includes(epicCacheTag.attachments(epicId)), "epic comment reply must not invalidate attachments");

const revalidatedEpic: string[] = [];
revalidateEpicReplyScope(epicId, "chat", (tag) => revalidatedEpic.push(tag));
assert.deepEqual(revalidatedEpic, epicChatTags, "epic chat reply revalidates only the epic chat resource tags");

console.log("cache scope tests passed");
