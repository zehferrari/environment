import { createHmac, timingSafeEqual } from "crypto";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for task chat replies");
  return value;
}

function tokenPayload(
  purpose: "chat-reply" | "description-write",
  messageId: string,
  taskId: string,
  agentSlug: string,
) {
  return `task-agent:${purpose}:${taskId}:${agentSlug}:${messageId}`;
}

export function createTaskChatReplyToken(
  messageId: string,
  taskId: string,
  agentSlug: string,
) {
  return createHmac("sha256", secret())
    .update(tokenPayload("chat-reply", messageId, taskId, agentSlug))
    .digest("base64url");
}

export function createTaskDescriptionWriteToken(
  messageId: string,
  taskId: string,
  agentSlug: string,
) {
  return createHmac("sha256", secret())
    .update(tokenPayload("description-write", messageId, taskId, agentSlug))
    .digest("base64url");
}

export function verifyTaskChatReplyToken(
  messageId: string,
  taskId: string,
  agentSlug: string,
  token: string,
) {
  const expected = createTaskChatReplyToken(messageId, taskId, agentSlug);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyTaskDescriptionWriteToken(
  messageId: string,
  taskId: string,
  agentSlug: string,
  token: string,
) {
  const expected = createTaskDescriptionWriteToken(messageId, taskId, agentSlug);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
