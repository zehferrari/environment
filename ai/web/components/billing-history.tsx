import Link from "next/link";
import { formatBillingDay, formatBillingPeriod } from "@/lib/billing/period";
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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {showProject ? <span className="font-semibold text-text">{entry.project.name}</span> : null}
                <span className="text-body text-text">{formatBillingPeriod({ from: entry.fromDate, to: entry.toDate })}</span>
                <span className="text-caption text-text-muted">{entry.agentSlug} · {entry.status}</span>
                <span className="ml-auto font-mono text-caption font-semibold text-accent">{entry.totalHours} h · {entry.days.length} day{entry.days.length === 1 ? "" : "s"}</span>
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
              <ol className="space-y-1">
                {entry.days.map((day) => (
                  <li key={day.id} className={`rounded-lg bg-panel-soft px-3 py-2 ${day.excluded ? "opacity-60" : ""}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-caption text-text">
                        <span className="mr-2 font-mono text-text-muted">{formatBillingDay(day.day)}</span>
                        {day.summary}
                      </span>
                      <span className="font-mono text-caption font-semibold text-accent">
                        {day.excluded ? "excluded" : `${(day.minutes / 60).toFixed(1)} h`}
                      </span>
                    </div>
                    {day.rationale ? <p className="mt-1 text-caption text-text-muted">{day.rationale}</p> : null}
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
