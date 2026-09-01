import { createHmac, timingSafeEqual } from "node:crypto";

// Capability token for a billing run's callback, mirroring
// lib/agents/workflow/token/work-item.ts: an HMAC over the identifying tuple,
// keyed by AUTH_SECRET. PM hands it to the agent in the dispatch turn; the agent
// presents it when reading the full ledger or posting its answer back.
//
// The token proves the request belongs to this (project, report, agent). What
// makes it single-use is the REPORT: a report that has already been answered or
// finalized refuses another write, so a leaked token cannot re-open a settled
// invoice.

function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value) throw new Error("AUTH_SECRET is required for billing callback tokens");
  return value;
}

function tokenPayload(projectId: string, reportId: string, agentSlug: string) {
  return `billing-run:${projectId}:${reportId}:${agentSlug}`;
}

export function createBillingCallbackToken(projectId: string, reportId: string, agentSlug: string) {
  return createHmac("sha256", secret())
    .update(tokenPayload(projectId, reportId, agentSlug))
    .digest("base64url");
}

export function verifyBillingCallbackToken(
  projectId: string,
  reportId: string,
  agentSlug: string,
  token: unknown,
) {
  if (typeof token !== "string" || token === "") return false;
  const expected = createBillingCallbackToken(projectId, reportId, agentSlug);
  const actualBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);
  // Length is compared first because timingSafeEqual throws on a mismatch, and
  // the length of an HMAC is not a secret.
  if (actualBuffer.byteLength !== expectedBuffer.byteLength) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
