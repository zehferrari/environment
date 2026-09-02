import assert from "node:assert/strict";
import { NextRequest } from "next/server";

process.env.AUTH_SECRET = process.env.AUTH_SECRET ?? "billing-callback-test-secret";

import {
  createBillingCallbackToken,
  verifyBillingCallbackToken,
} from "@/lib/billing/token";
import { clampMinutes } from "@/lib/billing/report";
import { compactLedger, buildBillingDispatchBody, resolveBillingPromptValue, DEFAULT_BILLING_PROMPT } from "@/lib/billing/prompt";
import type { BillingLedger, BillingLedgerDay } from "@/lib/billing/git-ledger";
import { middleware } from "@/middleware";

function ledgerDay(day: string, commitCount: number): BillingLedgerDay {
  return {
    day,
    commitCount,
    insertions: 100,
    deletions: 10,
    filesTouched: 4,
    firstCommitAt: `${day}T09:00:00+10:00`,
    lastCommitAt: `${day}T17:00:00+10:00`,
    commits: Array.from({ length: commitCount }, (_, index) => ({
      hash: `${day}-${index}`.padEnd(40, "0"),
      shortHash: `abc${index}`,
      authorName: "Zeh",
      authorEmail: "zeh@example.invalid",
      authoredAt: `${day}T1${index % 9}:00:00+10:00`,
      subject: `PH-${index} a reasonably long commit subject to make the body grow`,
      insertions: 25,
      deletions: 2,
      filesTouched: 1,
    })),
  };
}

async function main() {
  const token = createBillingCallbackToken("proj_1", "rep_1", "karen");

  // --- the token is bound to all three parts of the tuple ---
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", token), true);
  assert.equal(verifyBillingCallbackToken("proj_2", "rep_1", "karen", token), false);
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_2", "karen", token), false);
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "other", token), false);

  // --- malformed presentations are refused without throwing ---
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", ""), false);
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", undefined), false);
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", null), false);
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", 12345), false);
  // A different length must not reach timingSafeEqual, which throws on one.
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", token.slice(0, -1)), false);
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", token + "x"), false);
  // Same length, one character different.
  const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(verifyBillingCallbackToken("proj_1", "rep_1", "karen", flipped), false);

  // --- estimate clamping: a misplaced decimal must not reach an invoice ---
  assert.equal(clampMinutes(120), 120);
  assert.equal(clampMinutes("90"), 90);
  assert.equal(clampMinutes(-5), 0);
  assert.equal(clampMinutes("nonsense"), 0);
  assert.equal(clampMinutes(undefined), 0);
  assert.equal(clampMinutes(12000), 1440, "a day cannot bill more than 24 hours");
  assert.equal(clampMinutes(59.6), 60);

  // --- prompt resolution: project, then system, then the default ---
  assert.equal(resolveBillingPromptValue("project text", "system text"), "project text");
  assert.equal(resolveBillingPromptValue("   ", "system text"), "system text");
  assert.equal(resolveBillingPromptValue(null, null), DEFAULT_BILLING_PROMPT);

  // --- the dispatch body must fit sendDirectAgentMessage's 8000-char limit ---
  // A fortnight in which every day is busy is the worst realistic case.
  const days = Array.from({ length: 16 }, (_, index) =>
    ledgerDay(`2026-08-${String(16 + index).padStart(2, "0")}`, 12),
  );
  const ledger: BillingLedger = {
    days,
    totals: {
      days: days.length,
      commits: days.reduce((sum, day) => sum + day.commitCount, 0),
      insertions: 1600,
      deletions: 160,
      filesTouched: 64,
    },
    ref: "--all",
    from: "2026-08-16",
    to: "2026-08-31",
    authorEmails: ["zeh@example.invalid"],
    error: null,
  };

  const body = buildBillingDispatchBody({
    agentSlug: "karen",
    projectName: "patricia",
    repositoryPath: "/home/zeh/Code/patricia/projects/patricia",
    ledger,
    prompt: DEFAULT_BILLING_PROMPT,
    ledgerUrl: "http://127.0.0.1:3000/api/agent/projects/proj_1/billing/rep_1",
    callbackUrl: "http://127.0.0.1:3000/api/agent/projects/proj_1/billing/rep_1",
    token,
  });
  assert.ok(body.length <= 8000, `dispatch body must fit the 8000-char cap, got ${body.length}`);

  // Trimming detail must never drop a DAY — a missing day bills at zero.
  for (const day of days) {
    assert.ok(body.includes(day.day), `every day must survive trimming: ${day.day}`);
  }
  assert.ok(body.includes(token), "the agent needs the token to answer");

  // The route owns HMAC authorization. Middleware must let its exact GET/POST
  // shape through without a browser session, while nearby and unsupported
  // paths remain session-protected.
  const billingUrl = "http://127.0.0.1:3000/api/agent/projects/proj_1/billing/rep_1";
  for (const method of ["GET", "POST"]) {
    const response = await middleware(new NextRequest(billingUrl, { method }));
    assert.equal(response.headers.get("x-middleware-next"), "1", `${method} billing callback reaches route auth`);
  }
  for (const request of [
    new NextRequest(billingUrl, { method: "DELETE" }),
    new NextRequest("http://127.0.0.1:3000/api/agent/projects/proj_1/billing"),
    new NextRequest(`${billingUrl}/extra`),
  ]) {
    const response = await middleware(request);
    assert.equal(response.status, 307, `${request.method} ${request.nextUrl.pathname} stays browser-session protected`);
  }

  // The compact ledger degrades subject detail, not day coverage.
  const tiny = compactLedger(ledger, 400);
  for (const day of days) {
    assert.ok(tiny.includes(day.day), `day ${day.day} must survive an aggressive budget`);
  }

  console.log("billing-callback-auth-test ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
