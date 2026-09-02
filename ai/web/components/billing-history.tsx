import Link from "next/link";
import { formatBillingDay, formatBillingPeriod } from "@/lib/billing/period";
import { formatCents } from "@/lib/billing/rate";
import type { BillingHistoryEntry } from "@/lib/billing/history";

export default function BillingHistory({
  entries,
  showProject,
}: {
  entries: BillingHistoryEntry[];
  showProject: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-body font-semibold text-text">Summary history</h2>
        <span className="text-caption text-text-muted">{entries.length} saved report{entries.length === 1 ? "" : "s"}</span>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <details key={entry.id} className="rounded-card border border-line bg-panel">
            <summary className="cursor-pointer list-none px-4 py-3 marker:hidden">
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {showProject ? <span className="font-semibold text-text">{entry.project.name}</span> : null}
                    <span className="text-body text-text">{formatBillingPeriod({ from: entry.fromDate, to: entry.toDate })}</span>
                    <span className="text-caption text-text-muted">{entry.agentSlug} · {entry.status}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-caption leading-5 text-text-muted">{entry.overview}</p>
                </div>
                <div className="flex items-baseline gap-3 md:justify-end">
                  <span className="font-mono text-caption font-semibold text-accent">{entry.totalHours} h</span>
                  {entry.totalAmountCents !== null && entry.currency ? (
                    <span className="font-mono text-caption font-semibold text-text">{formatCents(entry.totalAmountCents, entry.currency)}</span>
                  ) : null}
                </div>
              </div>
            </summary>
            <div className="space-y-2 border-t border-line px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-text-muted">
                <span>Saved {entry.updatedAt.toLocaleString("en-AU")}</span>
                <Link
                  href={`/projects/${entry.project.slug}/billing?from=${entry.fromDate}&to=${entry.toDate}&agent=${encodeURIComponent(entry.agentSlug)}`}
                  className="font-semibold text-accent hover:underline"
                >
                  Open report
                </Link>
              </div>
              <div className="hidden grid-cols-[10rem_minmax(0,1fr)_6rem_9rem] gap-3 border-b border-line pb-2 text-nano font-semibold uppercase tracking-wider text-text-muted md:grid">
                <span>Date</span><span>Description</span><span className="text-right">Hours</span><span className="text-right">Amount</span>
              </div>
              <ol>
                {entry.days.map((day) => (
                  <li key={day.id} className={`border-b border-line py-2 last:border-b-0 ${day.excluded ? "opacity-60" : ""}`}>
                    <div className="grid gap-1 md:grid-cols-[10rem_minmax(0,1fr)_6rem_9rem] md:gap-3">
                      <span className="font-mono text-caption text-text-muted">{formatBillingDay(day.day)}</span>
                      <div><p className="text-caption text-text">{day.summary}</p>{day.rationale ? <p className="mt-1 text-caption text-text-muted">{day.rationale}</p> : null}</div>
                      <span className="font-mono text-caption font-semibold text-accent md:text-right">{day.excluded ? "excluded" : `${(day.minutes / 60).toFixed(1)} h`}</span>
                      <span className="font-mono text-caption text-text md:text-right">{day.amountCents !== null && entry.currency ? formatCents(day.amountCents, entry.currency) : "—"}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
