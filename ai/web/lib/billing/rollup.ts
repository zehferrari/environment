import { formatHours, type BillingRate } from "@/lib/billing/rate";
import { buildBillingView, type BillingDayRow } from "@/lib/billing/view";

export type BillingProjectRollup = {
  projectId: string;
  slug: string;
  name: string;
  status: string;
  reportId: string | null;
  minutes: number;
  hours: string;
  amountCents: number | null;
  rate: BillingRate | null;
  dayCount: number;
};

export type BillingCurrencyTotal = {
  currency: string;
  amountCents: number;
};

export type BillingWorkspaceRollup = {
  projects: BillingProjectRollup[];
  totalMinutes: number;
  totalHours: string;
  // One entry per currency in play. A workspace whose projects bill in
  // different currencies has no single total, and inventing one by adding the
  // numbers together would be worse than showing two lines.
  currencyTotals: BillingCurrencyTotal[];
  byDay: { day: string; minutes: number; hours: string }[];
};

export type BillingRollupInput = {
  projectId: string;
  slug: string;
  name: string;
  status: string;
  reportId: string | null;
  rate: BillingRate | null;
  days: BillingDayRow[];
};

export function buildWorkspaceRollup(inputs: BillingRollupInput[]): BillingWorkspaceRollup {
  const projects: BillingProjectRollup[] = [];
  const currencies = new Map<string, number>();
  const dayMinutes = new Map<string, number>();
  let totalMinutes = 0;

  for (const input of inputs) {
    const view = buildBillingView(input.days, input.rate);
    projects.push({
      projectId: input.projectId,
      slug: input.slug,
      name: input.name,
      status: input.status,
      reportId: input.reportId,
      minutes: view.totalMinutes,
      hours: view.totalHours,
      amountCents: view.totalAmountCents,
      rate: input.rate,
      dayCount: view.days.filter((day) => !day.excluded).length,
    });

    totalMinutes += view.totalMinutes;
    if (view.totalAmountCents !== null && input.rate) {
      currencies.set(
        input.rate.currency,
        (currencies.get(input.rate.currency) ?? 0) + view.totalAmountCents,
      );
    }
    for (const day of view.days) {
      if (day.minutes === 0) continue;
      dayMinutes.set(day.day, (dayMinutes.get(day.day) ?? 0) + day.minutes);
    }
  }

  return {
    projects: projects.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name)),
    totalMinutes,
    totalHours: formatHours(totalMinutes),
    currencyTotals: [...currencies.entries()]
      .map(([currency, amountCents]) => ({ currency, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents),
    byDay: [...dayMinutes.entries()]
      .map(([day, minutes]) => ({ day, minutes, hours: formatHours(minutes) }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}
