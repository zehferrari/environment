import assert from "node:assert/strict";
import {
  resolveBillingRate,
  parseRateInputToCents,
  normalizeRateCents,
  normalizeCurrency,
  priceDayCents,
  totalBilling,
  billableMinutes,
  formatCents,
} from "@/lib/billing/rate";
import { buildBillingView, billingInvoiceText, type BillingDayRow } from "@/lib/billing/view";
import { buildWorkspaceRollup } from "@/lib/billing/rollup";

function day(partial: Partial<BillingDayRow> & { id: string; day: string }): BillingDayRow {
  return {
    summary: "work",
    rationale: null,
    estimatedMinutes: 60,
    overrideMinutes: null,
    excluded: false,
    commitCount: 1,
    insertions: 10,
    deletions: 2,
    filesTouched: 1,
    firstCommitAt: `${partial.day}T09:00:00+10:00`,
    lastCommitAt: `${partial.day}T17:00:00+10:00`,
    ...partial,
  };
}

function main() {
  // --- resolution: project over workspace over global, else nothing ---
  const workspace = { hourlyRateCents: 15000, billingCurrency: "AUD" };
  const global = { hourlyRateCents: 12000, billingCurrency: "NZD" };

  assert.deepEqual(resolveBillingRate({ project: { hourlyRateCents: 20000 }, workspace }), {
    rateCents: 20000,
    currency: "AUD",
    source: "project",
  });
  assert.deepEqual(resolveBillingRate({ project: { hourlyRateCents: null }, workspace }), {
    rateCents: 15000,
    currency: "AUD",
    source: "workspace",
  });
  assert.deepEqual(resolveBillingRate({ project: { hourlyRateCents: null }, workspace: null, global }), {
    rateCents: 12000,
    currency: "NZD",
    source: "global",
  });
  assert.equal(resolveBillingRate({ project: { hourlyRateCents: null }, workspace: null }), null);
  // A project override still applies when the project sits in no workspace.
  assert.deepEqual(resolveBillingRate({ project: { hourlyRateCents: 9900 }, workspace: null }), {
    rateCents: 9900,
    currency: "AUD",
    source: "project",
  });
  // Currency comes from the workspace even when the project overrides the rate.
  assert.equal(
    resolveBillingRate({
      project: { hourlyRateCents: 20000 },
      workspace: { hourlyRateCents: 15000, billingCurrency: "GBP" },
    })?.currency,
    "GBP",
  );
  assert.equal(
    resolveBillingRate({
      project: { hourlyRateCents: null },
      workspace: { hourlyRateCents: 15000, billingCurrency: null },
      global,
    })?.currency,
    "NZD",
  );

  // --- zero is an empty field, not "free" ---
  assert.equal(normalizeRateCents(0), null);
  assert.equal(normalizeRateCents(-5), null);
  assert.equal(normalizeRateCents(""), null);
  assert.equal(normalizeRateCents(15000), 15000);

  // --- form input: dollars in, cents out, no floats ---
  assert.equal(parseRateInputToCents("150"), 15000);
  assert.equal(parseRateInputToCents("137.50"), 13750);
  assert.equal(parseRateInputToCents("$1,250.05"), 125005);
  assert.equal(parseRateInputToCents(""), null);
  assert.equal(parseRateInputToCents("0"), null);
  assert.throws(() => parseRateInputToCents("abc"));
  assert.throws(() => parseRateInputToCents("10.123"));

  assert.equal(normalizeCurrency("aud"), "AUD");
  assert.equal(normalizeCurrency("dollars"), null);
  assert.equal(normalizeCurrency(""), null);

  // --- the rounding rule: lines must add up to the total ---
  // 25 minutes at $137.50/h is 57.2916…, and three of them are the case where
  // pricing the sum and summing the prices disagree.
  const rate = { rateCents: 13750, currency: "AUD", source: "workspace" as const };
  assert.equal(priceDayCents(25, rate.rateCents), 5729);
  const totals = totalBilling([25, 25, 25], rate);
  assert.equal(totals.amountCents, 5729 * 3);
  assert.notEqual(totals.amountCents, priceDayCents(75, rate.rateCents));

  // --- override wins, estimate is kept ---
  assert.equal(billableMinutes({ estimatedMinutes: 120, overrideMinutes: null }), 120);
  assert.equal(billableMinutes({ estimatedMinutes: 120, overrideMinutes: 90 }), 90);
  assert.equal(billableMinutes({ estimatedMinutes: 120, overrideMinutes: 0 }), 0);

  // --- view: excluded days bill nothing and are left out of the invoice ---
  const rows = [
    day({ id: "a", day: "2026-08-17", estimatedMinutes: 120 }),
    day({ id: "b", day: "2026-08-18", estimatedMinutes: 420, overrideMinutes: 300 }),
    day({ id: "c", day: "2026-08-19", estimatedMinutes: 90, excluded: true }),
  ];
  const view = buildBillingView(rows, { rateCents: 15000, currency: "AUD", source: "workspace" });
  assert.equal(view.totalMinutes, 420);
  assert.equal(view.totalHours, "7.0");
  assert.equal(view.totalAmountCents, 30000 + 75000);
  assert.equal(view.excludedMinutes, 90);
  assert.equal(view.days[0].factsLine, "1 commit · 09:00–17:00 · +10 −2 · 1 file");

  const text = billingInvoiceText({
    projectName: "patricia",
    from: "2026-08-16",
    to: "2026-08-31",
    view,
  });
  assert.ok(text.includes("Mon 17 Aug"));
  assert.ok(!text.includes("Wed 19 Aug"), "an excluded day must not reach the invoice");
  assert.ok(text.includes("Total: 7.0 h @ 150.00/h = AUD 1,050.00"));

  // --- hours-only when no rate is set anywhere ---
  const noRate = buildBillingView(rows, null);
  assert.equal(noRate.totalAmountCents, null);
  assert.equal(noRate.days[0].amountCents, null);
  assert.ok(
    billingInvoiceText({ projectName: "p", from: "a", to: "b", view: noRate }).includes("Total: 7.0 h"),
  );

  // --- rollup: mixed currencies are sub-totalled, never added ---
  const rollup = buildWorkspaceRollup([
    {
      projectId: "p1",
      slug: "patricia",
      name: "patricia",
      status: "ready",
      reportId: "r1",
      rate: { rateCents: 15000, currency: "AUD", source: "workspace" },
      days: [day({ id: "d1", day: "2026-08-17", estimatedMinutes: 120 })],
    },
    {
      projectId: "p2",
      slug: "v23",
      name: "v23",
      status: "ready",
      reportId: "r2",
      rate: { rateCents: 10000, currency: "GBP", source: "project" },
      days: [day({ id: "d2", day: "2026-08-17", estimatedMinutes: 60 })],
    },
    {
      projectId: "p3",
      slug: "no-rate",
      name: "no-rate",
      status: "ready",
      reportId: "r3",
      rate: null,
      days: [day({ id: "d3", day: "2026-08-18", estimatedMinutes: 30 })],
    },
  ]);
  assert.equal(rollup.totalMinutes, 210);
  assert.equal(rollup.currencyTotals.length, 2);
  assert.deepEqual(
    rollup.currencyTotals.map((total) => `${total.currency}:${total.amountCents}`).sort(),
    ["AUD:30000", "GBP:10000"],
  );
  // Both projects worked the 17th; the day rolls up to their sum.
  assert.deepEqual(rollup.byDay, [
    { day: "2026-08-17", minutes: 180, hours: "3.0" },
    { day: "2026-08-18", minutes: 30, hours: "0.5" },
  ]);
  assert.equal(rollup.projects.find((p) => p.slug === "no-rate")?.amountCents, null);

  assert.equal(formatCents(125005, "AUD"), "AUD 1,250.05");

  console.log("billing-rate-test ok");
}

main();
