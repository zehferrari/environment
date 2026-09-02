import assert from "node:assert/strict";
import { db } from "@/lib/db";
import { acceptBillingRun, applyBillingRunResult, discardBillingRun } from "@/lib/billing/report";
import type { BillingLedger } from "@/lib/billing/git-ledger";
import { appendPmChannelStreamEvent } from "@/lib/agents/pm-channel/stream-log";

const ledger: BillingLedger = {
  from: "2026-09-01",
  to: "2026-09-01",
  ref: "--all",
  authorEmails: [],
  error: null,
  totals: { days: 1, commits: 1, insertions: 10, deletions: 2, filesTouched: 1 },
  days: [{
    day: "2026-09-01",
    commitCount: 1,
    insertions: 10,
    deletions: 2,
    filesTouched: 1,
    firstCommitAt: "2026-09-01T09:00:00+10:00",
    lastCommitAt: "2026-09-01T09:00:00+10:00",
    commits: [{
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      authorName: "Zeh",
      authorEmail: "zeh@example.test",
      authoredAt: "2026-09-01T09:00:00+10:00",
      subject: "initial work",
      insertions: 10,
      deletions: 2,
      filesTouched: 1,
    }],
  }],
};

async function main() {
  const user = await db.user.create({ data: { username: "billing-owner", email: "billing@example.test", kind: "human" } });
  const project = await db.project.create({ data: { slug: "billing-test", name: "Billing test" } });
  const report = await db.billingReport.create({
    data: {
      projectId: project.id,
      fromDate: ledger.from,
      toDate: ledger.to,
      authorEmails: "[]",
      agentSlug: "karen",
      ledger: JSON.stringify(ledger),
      requestedById: user.id,
    },
  });
  const run1 = await db.billingRun.create({
    data: { reportId: report.id, generation: 1, status: "running", authorEmails: "[]", ledger: JSON.stringify(ledger) },
  });
  const first = await applyBillingRunResult({
    runId: run1.id,
    days: [{ day: ledger.from, summary: "Accepted first", estimatedMinutes: 60 }],
  });
  assert.equal(first.ok, true);
  let current = await db.billingReport.findUniqueOrThrow({ where: { id: report.id }, include: { days: true } });
  assert.equal(current.acceptedRunId, run1.id);
  assert.equal(current.days[0]?.summary, "Accepted first");

  const run2 = await db.billingRun.create({
    data: { reportId: report.id, generation: 2, status: "running", authorEmails: "[]", ledger: JSON.stringify(ledger) },
  });
  const candidate = await applyBillingRunResult({
    runId: run2.id,
    days: [{ day: ledger.from, summary: "Candidate second", estimatedMinutes: 90 }],
  });
  assert.equal(candidate.ok, true);
  current = await db.billingReport.findUniqueOrThrow({ where: { id: report.id }, include: { days: true } });
  assert.equal(current.acceptedRunId, run1.id, "a regeneration must not overwrite accepted data");
  assert.equal(current.days[0]?.summary, "Accepted first");
  assert.equal((await db.billingRun.findUniqueOrThrow({ where: { id: run2.id } })).status, "ready");

  assert.equal((await acceptBillingRun(run2.id)).ok, true);
  current = await db.billingReport.findUniqueOrThrow({ where: { id: report.id }, include: { days: true } });
  assert.equal(current.acceptedRunId, run2.id);
  assert.equal(current.days[0]?.summary, "Candidate second");
  assert.equal((await db.billingRun.findUniqueOrThrow({ where: { id: run1.id } })).status, "superseded");

  const run3 = await db.billingRun.create({
    data: { reportId: report.id, generation: 3, status: "running", authorEmails: "[]", ledger: JSON.stringify(ledger) },
  });
  await applyBillingRunResult({
    runId: run3.id,
    days: [{ day: ledger.from, summary: "Discard me", estimatedMinutes: 120 }],
  });
  assert.equal((await discardBillingRun(run3.id)).ok, true);
  current = await db.billingReport.findUniqueOrThrow({ where: { id: report.id }, include: { days: true } });
  assert.equal(current.acceptedRunId, run2.id);
  assert.equal(current.days[0]?.summary, "Candidate second");

  const run4 = await db.billingRun.create({
    data: { reportId: report.id, generation: 4, status: "running", authorEmails: "[]", ledger: JSON.stringify(ledger) },
  });
  const message = await db.directAgentChatMessage.create({
    data: { agentSlug: "karen", senderUserId: user.id, body: "private billing", billingRunId: run4.id },
  });
  await db.billingRun.update({ where: { id: run4.id }, data: { messageId: message.id } });
  const pmRun = await db.pmChannelRun.create({
    data: { targetKey: `direct:karen:${message.id}`, kind: "direct", agentSlug: "karen", messageId: message.id },
  });
  await appendPmChannelStreamEvent({
    runId: pmRun.id,
    event: "reasoning",
    input: { event: "reasoning", text: "Visible reasoning" },
  });
  await appendPmChannelStreamEvent({
    runId: pmRun.id,
    event: "final",
    input: { event: "final", text: "Saved response", replace: true },
  });
  const savedEvents = await db.billingRunEvent.findMany({ where: { runId: run4.id }, orderBy: { seq: "asc" } });
  assert.deepEqual(savedEvents.map((event) => event.kind), ["reasoning", "final"]);
  assert.ok(savedEvents[0]?.payload.includes("Visible reasoning"));
  console.log("billing-generation-test ok");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
