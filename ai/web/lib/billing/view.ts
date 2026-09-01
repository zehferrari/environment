import { billableMinutes, formatCents, formatHours, priceDayCents, type BillingRate } from "@/lib/billing/rate";
import { formatBillingDay } from "@/lib/billing/period";

export type BillingDayRow = {
  id: string;
  day: string;
  summary: string;
  rationale: string | null;
  estimatedMinutes: number;
  overrideMinutes: number | null;
  excluded: boolean;
  commitCount: number;
  insertions: number;
  deletions: number;
  filesTouched: number;
  firstCommitAt: string | null;
  lastCommitAt: string | null;
};

export type BillingViewDay = BillingDayRow & {
  label: string;
  minutes: number;
  hours: string;
  amountCents: number | null;
  factsLine: string;
};

export type BillingView = {
  days: BillingViewDay[];
  totalMinutes: number;
  totalHours: string;
  totalAmountCents: number | null;
  excludedMinutes: number;
  rate: BillingRate | null;
};

function timeOf(iso: string | null) {
  return iso ? iso.slice(11, 16) : null;
}

export function factsLine(day: BillingDayRow) {
  const first = timeOf(day.firstCommitAt);
  const last = timeOf(day.lastCommitAt);
  const span = first && last ? (first === last ? first : `${first}–${last}`) : null;
  return [
    `${day.commitCount} commit${day.commitCount === 1 ? "" : "s"}`,
    span,
    `+${day.insertions} −${day.deletions}`,
    `${day.filesTouched} file${day.filesTouched === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function buildBillingView(rows: BillingDayRow[], rate: BillingRate | null): BillingView {
  const days = rows.map((row) => {
    const minutes = row.excluded ? 0 : billableMinutes(row);
    return {
      ...row,
      label: formatBillingDay(row.day),
      minutes,
      hours: formatHours(minutes),
      amountCents: rate ? priceDayCents(minutes, rate.rateCents) : null,
      factsLine: factsLine(row),
    };
  });

  // Summed from the per-day amounts, never from total minutes priced once, so
  // the lines on the page add up to the total on the page.
  const totalMinutes = days.reduce((sum, day) => sum + day.minutes, 0);
  const totalAmountCents = rate
    ? days.reduce((sum, day) => sum + (day.amountCents ?? 0), 0)
    : null;
  const excludedMinutes = rows
    .filter((row) => row.excluded)
    .reduce((sum, row) => sum + billableMinutes(row), 0);

  return {
    days,
    totalMinutes,
    totalHours: formatHours(totalMinutes),
    totalAmountCents,
    excludedMinutes,
    rate,
  };
}

// Plain text for an email. One line per day, hours and amount aligned to the
// right of the summary so a client can read down the column.
export function billingInvoiceText(args: {
  projectName: string;
  from: string;
  to: string;
  view: BillingView;
}) {
  const { view } = args;
  const lines: string[] = [
    `${args.projectName} — ${args.from} to ${args.to}`,
    "",
  ];

  for (const day of view.days) {
    if (day.excluded) continue;
    const amount = day.amountCents !== null ? `  ${formatCents(day.amountCents)}` : "";
    lines.push(`${day.label} — ${day.summary}`);
    lines.push(`    ${day.hours} h${amount}`);
  }

  lines.push("");
  if (view.totalAmountCents !== null && view.rate) {
    lines.push(
      `Total: ${view.totalHours} h @ ${formatCents(view.rate.rateCents)}/h = ${formatCents(
        view.totalAmountCents,
        view.rate.currency,
      )}`,
    );
  } else {
    lines.push(`Total: ${view.totalHours} h`);
  }
  return lines.join("\n");
}
