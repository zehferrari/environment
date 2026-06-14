import { createHmac, timingSafeEqual } from "crypto";

// One-shot capability token for the agent work-item proposal grant.
//
// Mirrors lib/agents/workflow/chat/task/token.ts: an HMAC over the grant's
// identifying tuple, keyed by AUTH_SECRET. PM hands the token to the
// agent in the planning turn; the agent presents it when POSTing a
// proposal to /api/agent/projects/[projectId]/proposals. The grant
// itself (DirectAgentChatMessage for direct chats, PmChannelRun for
// Task/Epic Discussion) is what makes it single-use — this token only
// proves the request is bound to that specific (project, agent, message).

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for work-item grant tokens");
  return value;
}

function tokenPayload(projectId: string, agentSlug: string, messageId: string) {
  return `work-item-grant:${projectId}:${agentSlug}:${messageId}`;
}

export function createWorkItemGrantToken(
  projectId: string,
  agentSlug: string,
  messageId: string,
) {
  return createHmac("sha256", secret())
    .update(tokenPayload(projectId, agentSlug, messageId))
    .digest("base64url");
}

export function verifyWorkItemGrantToken(
  projectId: string,
  agentSlug: string,
  messageId: string,
  token: string,
) {
  const expected = createWorkItemGrantToken(projectId, agentSlug, messageId);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
