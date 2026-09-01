// Hourly rates. A workspace sets the rate for its client; a project may carry
// its own, which wins. There is deliberately no system-wide fallback — unlike
// doneTtlDays, an unset rate must LOOK unset. A global default would price an
// invoice at a number nobody remembers setting, so a report with no rate
// anywhere renders hours only.

export type BillingRateSource = "project" | "workspace";

export type BillingRate = {
  rateCents: number;
  currency: string;
  source: BillingRateSource;
};

export const DEFAULT_BILLING_CURRENCY = "AUD";

type RateInputs = {
  project: { hourlyRateCents: number | null | undefined };
  workspace: { hourlyRateCents: number | null | undefined; billingCurrency: string | null | undefined } | null;
};

export function resolveBillingRate(inputs: RateInputs): BillingRate | null {
  const currency = normalizeCurrency(inputs.workspace?.billingCurrency) ?? DEFAULT_BILLING_CURRENCY;
  const projectRate = normalizeRateCents(inputs.project.hourlyRateCents);
  if (projectRate !== null) return { rateCents: projectRate, currency, source: "project" };
  const workspaceRate = normalizeRateCents(inputs.workspace?.hourlyRateCents);
  if (workspaceRate !== null) return { rateCents: workspaceRate, currency, source: "workspace" };
  return null;
}

// A zero rate is not "free", it is an empty field someone tabbed through. Treat
// it as unset so the report says "no rate" instead of invoicing $0.00.
export function normalizeRateCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

// Settings forms take dollars; everything downstream is cents. Money is never a
// float in this system — 0.1 + 0.2 has no place on an invoice.
export function parseRateInputToCents(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim().replace(/[$,\s]/g, "");
  if (raw === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error("Hourly rate must be an amount such as 150 or 137.50.");
  }
  const cents = Math.round(Number(raw) * 100);
  return cents > 0 ? cents : null;
}

export function formatCents(cents: number, currency?: string | null) {
  const amount = (cents / 100).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency ? `${currency} ${amount}` : amount;
}

export function formatRate(rate: BillingRate) {
  return `${formatCents(rate.rateCents, rate.currency)}/h`;
}

export function formatHours(minutes: number) {
  return (minutes / 60).toFixed(1);
}

const CURRENCY_RE = /^[A-Za-z]{3}$/;

export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toUpperCase();
  return CURRENCY_RE.test(raw) ? raw : null;
}

// Rounded per day, then summed — never minutes summed and priced once. The
// printed lines have to add up to the printed total, because that is the first
// thing a client checks.
export function priceDayCents(minutes: number, rateCents: number) {
  return Math.round((minutes * rateCents) / 60);
}

export type BillingTotals = {
  minutes: number;
  hours: string;
  amountCents: number | null;
};

export function totalBilling(
  dayMinutes: number[],
  rate: Pick<BillingRate, "rateCents"> | null,
): BillingTotals {
  const minutes = dayMinutes.reduce((sum, value) => sum + value, 0);
  const amountCents = rate
    ? dayMinutes.reduce((sum, value) => sum + priceDayCents(value, rate.rateCents), 0)
    : null;
  return { minutes, hours: formatHours(minutes), amountCents };
}

// What the day actually bills at: an operator override wins over the agent's
// estimate, and the agent's number is kept either way.
export function billableMinutes(day: { estimatedMinutes: number; overrideMinutes: number | null }) {
  return day.overrideMinutes ?? day.estimatedMinutes;
}
