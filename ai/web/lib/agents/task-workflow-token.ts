import { createHmac, timingSafeEqual } from "crypto";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for task workflow grants");
  return value;
}

function tokenPayload(messageId: string, taskId: string, agentSlug: string) {
  return `task-agent:workflow:${messageId}:${taskId}:${agentSlug}`;
}

export function createTaskWorkflowToken(
  messageId: string,
  taskId: string,
  agentSlug: string,
) {
  return createHmac("sha256", secret())
    .update(tokenPayload(messageId, taskId, agentSlug))
    .digest("base64url");
}

export function verifyTaskWorkflowToken(
  messageId: string,
  taskId: string,
  agentSlug: string,
  token: string,
) {
  const expected = createTaskWorkflowToken(messageId, taskId, agentSlug);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
