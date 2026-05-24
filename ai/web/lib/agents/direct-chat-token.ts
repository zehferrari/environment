import { createHmac, timingSafeEqual } from "crypto";

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for direct chat replies");
  return value;
}

function tokenPayload(messageId: string, agentSlug: string) {
  return `direct-agent-chat:${agentSlug}:${messageId}`;
}

export function createDirectChatReplyToken(messageId: string, agentSlug: string) {
  return createHmac("sha256", secret())
    .update(tokenPayload(messageId, agentSlug))
    .digest("base64url");
}

export function verifyDirectChatReplyToken(messageId: string, agentSlug: string, token: string) {
  const expected = createDirectChatReplyToken(messageId, agentSlug);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
