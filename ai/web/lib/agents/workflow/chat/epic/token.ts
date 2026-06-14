import { createHmac, timingSafeEqual } from "crypto";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for epic description grants");
  return value;
}

function tokenPayload(messageId: string, epicId: string, agentSlug: string) {
  return `epic-agent:description-write:${epicId}:${agentSlug}:${messageId}`;
}

export function createEpicDescriptionWriteToken(
  messageId: string,
  epicId: string,
  agentSlug: string,
) {
  return createHmac("sha256", secret())
    .update(tokenPayload(messageId, epicId, agentSlug))
    .digest("base64url");
}

export function verifyEpicDescriptionWriteToken(
  messageId: string,
  epicId: string,
  agentSlug: string,
  token: string,
) {
  const expected = createEpicDescriptionWriteToken(messageId, epicId, agentSlug);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
