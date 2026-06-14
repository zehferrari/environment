import { createHmac, timingSafeEqual } from "crypto";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for epic workflow grants");
  return value;
}

function tokenPayload(messageId: string, epicId: string, agentSlug: string) {
  return `epic-agent:workflow:${messageId}:${epicId}:${agentSlug}`;
}

export function createEpicWorkflowToken(
  messageId: string,
  epicId: string,
  agentSlug: string,
) {
  return createHmac("sha256", secret())
    .update(tokenPayload(messageId, epicId, agentSlug))
    .digest("base64url");
}

export function verifyEpicWorkflowToken(
  messageId: string,
  epicId: string,
  agentSlug: string,
  token: string,
) {
  const expected = createEpicWorkflowToken(messageId, epicId, agentSlug);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
