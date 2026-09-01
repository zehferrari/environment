// Billing periods are half-months. The first half is the 1st to the 15th; the
// second is the 16th to the last day of the month. The 15th belongs to the first
// half only — a boundary that overlaps would bill a day twice.

export type BillingPeriod = {
  from: string;
  to: string;
};

const FIRST_HALF_LAST_DAY = 15;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function lastDayOfMonth(year: number, month1to12: number) {
  // Day 0 of the next month is the last day of this one, and this rolls over
  // December correctly because Date normalises month 12 to January of year+1.
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

export function formatDay(year: number, month1to12: number, day: number) {
  return `${year}-${pad(month1to12)}-${pad(day)}`;
}

// The period containing `now`, in the server's local calendar — the same calendar
// the ledger groups commits by, so "this fortnight" means one thing everywhere.
export function defaultBillingPeriod(now: Date = new Date()): BillingPeriod {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  if (day <= FIRST_HALF_LAST_DAY) {
    return {
      from: formatDay(year, month, 1),
      to: formatDay(year, month, FIRST_HALF_LAST_DAY),
    };
  }
  return {
    from: formatDay(year, month, FIRST_HALF_LAST_DAY + 1),
    to: formatDay(year, month, lastDayOfMonth(year, month)),
  };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Accepts a submitted period, falling back to the default for anything missing
// or malformed. Returns the fallback rather than throwing: a hand-edited query
// string should show this period, not an error page.
export function normalizeBillingPeriod(
  from: unknown,
  to: unknown,
  now: Date = new Date(),
): BillingPeriod {
  const fallback = defaultBillingPeriod(now);
  const cleanFrom = typeof from === "string" && DAY_RE.test(from.trim()) ? from.trim() : null;
  const cleanTo = typeof to === "string" && DAY_RE.test(to.trim()) ? to.trim() : null;
  if (!cleanFrom || !cleanTo) return fallback;
  if (!isRealDay(cleanFrom) || !isRealDay(cleanTo)) return fallback;
  if (cleanFrom > cleanTo) return { from: cleanTo, to: cleanFrom };
  return { from: cleanFrom, to: cleanTo };
}

// "2026-02-30" matches the shape but is not a date. Round-tripping catches the
// rollover Date would otherwise perform silently.
export function isRealDay(day: string) {
  if (!DAY_RE.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  return d >= 1 && d <= lastDayOfMonth(y, m);
}

export function eachDayInPeriod(period: BillingPeriod): string[] {
  const days: string[] = [];
  const [fy, fm, fd] = period.from.split("-").map(Number);
  const [ty, tm, td] = period.to.split("-").map(Number);
  let cursor = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86_400_000;
  }
  return days;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "Mon 17 Aug". Formatted from the parts rather than via toLocaleDateString so
// the server and the browser cannot disagree and trip a hydration mismatch.
export function formatBillingDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday} ${d} ${MONTHS[m - 1]}`;
}

export function formatBillingPeriod(period: BillingPeriod) {
  const [, , fd] = period.from.split("-").map(Number);
  const [ty, tm, td] = period.to.split("-").map(Number);
  return `${fd}–${td} ${MONTHS[tm - 1]} ${ty}`;
}
