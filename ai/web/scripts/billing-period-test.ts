import assert from "node:assert/strict";
import {
  defaultBillingPeriod,
  normalizeBillingPeriod,
  eachDayInPeriod,
  isRealDay,
  lastDayOfMonth,
  formatBillingDay,
  formatBillingPeriod,
} from "@/lib/billing/period";

function at(year: number, month1to12: number, day: number) {
  return new Date(year, month1to12 - 1, day, 12, 0, 0);
}

function main() {
  // --- the boundary: the 15th belongs to the first half only ---
  assert.deepEqual(defaultBillingPeriod(at(2026, 8, 1)), { from: "2026-08-01", to: "2026-08-15" });
  assert.deepEqual(defaultBillingPeriod(at(2026, 8, 15)), { from: "2026-08-01", to: "2026-08-15" });
  assert.deepEqual(defaultBillingPeriod(at(2026, 8, 16)), { from: "2026-08-16", to: "2026-08-31" });
  assert.deepEqual(defaultBillingPeriod(at(2026, 8, 31)), { from: "2026-08-16", to: "2026-08-31" });

  // The two halves must tile the month exactly — no gap, no overlap.
  const first = defaultBillingPeriod(at(2026, 8, 10));
  const second = defaultBillingPeriod(at(2026, 8, 20));
  const covered = [...eachDayInPeriod(first), ...eachDayInPeriod(second)];
  assert.equal(covered.length, 31, "August must be covered by exactly 31 day slots");
  assert.equal(new Set(covered).size, 31, "no day may appear in both halves");

  // --- month lengths ---
  assert.deepEqual(defaultBillingPeriod(at(2026, 2, 20)), { from: "2026-02-16", to: "2026-02-28" });
  assert.deepEqual(defaultBillingPeriod(at(2028, 2, 20)), { from: "2028-02-16", to: "2028-02-29" });
  assert.deepEqual(defaultBillingPeriod(at(2026, 4, 20)), { from: "2026-04-16", to: "2026-04-30" });
  assert.deepEqual(defaultBillingPeriod(at(2026, 12, 20)), { from: "2026-12-16", to: "2026-12-31" });

  assert.equal(lastDayOfMonth(2026, 2), 28);
  assert.equal(lastDayOfMonth(2028, 2), 29);
  assert.equal(lastDayOfMonth(2026, 12), 31);

  // --- normalize ---
  const fallback = defaultBillingPeriod(at(2026, 8, 20));
  assert.deepEqual(normalizeBillingPeriod("2026-08-16", "2026-08-31", at(2026, 8, 20)), {
    from: "2026-08-16",
    to: "2026-08-31",
  });
  assert.deepEqual(normalizeBillingPeriod("garbage", "2026-08-31", at(2026, 8, 20)), fallback);
  assert.deepEqual(normalizeBillingPeriod(undefined, undefined, at(2026, 8, 20)), fallback);
  // "2026-02-30" has the right shape and is not a date.
  assert.deepEqual(normalizeBillingPeriod("2026-02-30", "2026-03-01", at(2026, 8, 20)), fallback);
  // A reversed range is swapped, not rejected — the intent is obvious.
  assert.deepEqual(normalizeBillingPeriod("2026-08-31", "2026-08-16", at(2026, 8, 20)), {
    from: "2026-08-16",
    to: "2026-08-31",
  });

  assert.equal(isRealDay("2026-02-29"), false);
  assert.equal(isRealDay("2028-02-29"), true);
  assert.equal(isRealDay("2026-13-01"), false);
  assert.equal(isRealDay("2026-00-10"), false);

  // --- enumeration crosses a month boundary ---
  const across = eachDayInPeriod({ from: "2026-01-30", to: "2026-02-02" });
  assert.deepEqual(across, ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);

  // --- formatting is offset-free so server and browser agree ---
  assert.equal(formatBillingDay("2026-08-17"), "Mon 17 Aug");
  assert.equal(formatBillingDay("2026-08-16"), "Sun 16 Aug");
  assert.equal(formatBillingPeriod({ from: "2026-08-16", to: "2026-08-31" }), "16–31 Aug 2026");

  console.log("billing-period-test ok");
}

main();
