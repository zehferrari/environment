import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { normalizeBillingPeriod, formatBillingPeriod } from "@/lib/billing/period";
import { formatCents, formatRate } from "@/lib/billing/rate";
import {
  findBillingReport,
  parseLedger,
  resolveProjectBillingRate,
} from "@/lib/billing/report";
import { listBillingAgents, selectBillingAgentSlug } from "@/lib/billing/run";
import { buildBillingView, billingInvoiceText, factsLine, type BillingDayRow } from "@/lib/billing/view";
import {
  setBillingDayOverride,
  toggleBillingDayExcluded,
  setBillingReportFinalized,
} from "@/lib/billing/actions";
import BillingCopyButton from "@/components/billing-copy-button";
import BillingRunPanel from "@/components/billing-run-panel";
import BillingHistory from "@/components/billing-history";
import { listBillingHistory } from "@/lib/billing/history";
import BillingCreateDialog from "@/components/billing-create-dialog";

export const dynamic = "force-dynamic";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProjectBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const session = await auth();
  const userId = session?.user?.id ?? null;

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, name: true, slug: true, repositoryPath: true },
  });
  if (!project) notFound();
  if (!project.repositoryPath) notFound();

  const period = normalizeBillingPeriod(single(sp.from), single(sp.to));
  const requestedAgent = single(sp.agent)?.trim() || "";

  const [agents, rateInfo] = await Promise.all([
    listBillingAgents(),
    resolveProjectBillingRate(project.id, period.from),
  ]);

  const agentSlug = (await selectBillingAgentSlug(requestedAgent)) ?? "";

  const report = userId && agentSlug
    ? await findBillingReport({
        projectId: project.id,
        period,
        agentSlug,
        requestedById: userId,
      })
    : null;
  const history = userId
    ? await listBillingHistory({
        projectIds: [project.id],
        requestedById: userId,
        excludeReportIds: report ? [report.id] : [],
      })
    : [];

  const storedRate =
    report?.rateCents && report.currency && report.rateSource
      ? {
          rateCents: report.rateCents,
          currency: report.currency,
          source: report.rateSource as "project" | "workspace" | "global",
        }
      : null;
  const rate = storedRate ?? rateInfo.rate;

  const ledger = parseLedger(report?.ledger);
  const rows: BillingDayRow[] = (report?.days ?? []).map((day) => ({
    id: day.id,
    day: day.day,
    summary: day.summary,
    rationale: day.rationale,
    estimatedMinutes: day.estimatedMinutes,
    overrideMinutes: day.overrideMinutes,
    excluded: day.excluded,
    commitCount: day.commitCount,
    insertions: day.insertions,
    deletions: day.deletions,
    filesTouched: day.filesTouched,
    firstCommitAt: day.firstCommitAt,
    lastCommitAt: day.lastCommitAt,
  }));
  const view = buildBillingView(rows, rate);
  const locked = report?.status === "final";
  const overview = report?.notes?.trim()
    || rows.slice(0, 2).map((row) => row.summary).join(" ");

  const invoiceText =
    rows.length > 0
      ? billingInvoiceText({
          projectName: project.name,
          from: period.from,
          to: period.to,
          view,
        })
      : "";

  return (
    <div className="space-y-section-gap">
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-panel-soft px-4 py-3 text-body">
        <div className="min-w-0">
          <div className="text-caption text-text-muted">{formatBillingPeriod(period)}</div>
          <div className="text-body font-semibold text-text">
            {view.totalHours} h
            {view.totalAmountCents !== null && rate ? (
              <> · {formatCents(view.totalAmountCents, rate.currency)}</>
            ) : null}
          </div>
        </div>
        <div className="text-caption text-text-muted">
          {rate ? (
            <>
              {formatRate(rate)} · {rate.source === "project" ? "project override" : rate.source === "workspace" ? "workspace rate" : "global default"}
              {rateInfo.workspace ? ` (${rateInfo.workspace.name})` : ""}
            </>
          ) : (
            <>No hourly rate set — hours only. Add one in project or workspace settings.</>
          )}
          {" · "}<Link href={`/projects/${slug}/settings`} className="text-accent hover:underline">Edit rate</Link>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {invoiceText ? <BillingCopyButton text={invoiceText} /> : null}

          {report && (report.status === "ready" || report.status === "final") ? (
            <form action={setBillingReportFinalized}>
              <input type="hidden" name="reportId" value={report.id} />
              <input type="hidden" name="finalize" value={locked ? "0" : "1"} />
              <button
                type="submit"
                className="h-9 rounded-lg border border-line bg-panel px-3 text-caption font-semibold text-text hover:border-accent"
              >
                {locked ? "Un-finalize" : "Finalize"}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {report?.error ? (
        <p className="rounded-card border border-warn/30 bg-warn/[0.06] px-4 py-3 text-body text-text-muted">
          {report.error}
        </p>
      ) : null}

      {report && report.status === "running" && report.runs.length === 0 ? (
        <p className="rounded-card border border-line bg-panel-soft px-4 py-3 text-body text-text-muted">
          Sent to <span className="font-medium text-text">{report.agentSlug}</span>. This legacy run
          predates the embedded Billing transcript; regenerate it to track future output here.
        </p>
      ) : null}

      {report?.runs.some((run) => !["discarded", "superseded"].includes(run.status)) ? (
        <div className="space-y-2">
          <h2 className="text-body font-semibold text-text">Summary runs</h2>
          {report.runs
            .filter((run) => !["discarded", "superseded"].includes(run.status))
            .map((run) => <BillingRunPanel key={run.id} run={run} />)}
        </div>
      ) : null}

      {!report ? (
        <p className="rounded-card border border-dashed border-line bg-panel-soft/30 px-4 py-6 text-center text-body text-text-muted">
          No saved summary for {formatBillingPeriod(period)}. Use the <span className="font-medium text-text">+</span> button to create one.
        </p>
      ) : null}

      {report && rows.length === 0 && ledger ? (
        <div className="space-y-3">
          <p className="text-caption text-text-muted">
            {ledger.totals.days} day{ledger.totals.days === 1 ? "" : "s"} with commits ·{" "}
            {ledger.totals.commits} commits · +{ledger.totals.insertions} −{ledger.totals.deletions}
          </p>
          <ol className="space-y-2">
            {ledger.days.map((day) => (
              <li key={day.day} className="rounded-card border border-line bg-panel-soft px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-caption font-medium text-text">{day.day}</span>
                  <span className="font-mono text-micro text-text-muted">{factsLine({ ...day, id: day.day, summary: "", rationale: null, estimatedMinutes: 0, overrideMinutes: null, excluded: false })}</span>
                </div>
                <ul className="mt-2 space-y-1 text-caption text-text-muted">
                  {day.commits.map((commit) => (
                    <li key={commit.hash} className="break-words">
                      <span className="font-mono text-accent">{commit.shortHash}</span> {commit.subject}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {rows.length > 0 ? (
        <details className="rounded-card border border-line bg-panel">
          <summary className="cursor-pointer list-none px-4 py-4 marker:hidden">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div>
                <div className="text-caption font-semibold text-text">Main updates</div>
                <p className="mt-1 line-clamp-3 text-body leading-6 text-text-muted">{overview}</p>
              </div>
              <div className="flex items-baseline gap-3 md:text-right">
                <span className="font-mono text-body font-semibold text-accent">{view.totalHours} h</span>
                {view.totalAmountCents !== null && rate ? <span className="font-mono text-body font-semibold text-text">{formatCents(view.totalAmountCents, rate.currency)}</span> : null}
              </div>
            </div>
          </summary>
          <div className="border-t border-line">
            <div className="hidden grid-cols-[10rem_minmax(0,1fr)_6rem_9rem] gap-3 bg-panel-soft px-4 py-2 text-nano font-semibold uppercase tracking-wider text-text-muted md:grid">
              <span>Date</span><span>Description</span><span className="text-right">Hours</span><span className="text-right">Amount</span>
            </div>
            <ol>
              {view.days.map((day) => (
                <li key={day.id} className={`border-t border-line px-4 py-3 first:border-t-0 ${day.excluded ? "bg-panel-soft/40 opacity-60" : ""}`}>
                  <div className="grid gap-2 md:grid-cols-[10rem_minmax(0,1fr)_6rem_9rem] md:gap-3">
                    <div><div className="font-mono text-caption font-medium text-text">{day.label}</div><div className="mt-0.5 font-mono text-micro text-text-muted">{day.factsLine}</div></div>
                    <div><p className="break-words text-body text-text">{day.summary}</p>{day.rationale ? <p className="mt-1 break-words text-caption text-text-muted">{day.rationale}</p> : null}</div>
                    <div className="font-mono text-caption font-semibold text-accent md:text-right">{day.excluded ? "—" : `${day.hours} h`}</div>
                    <div className="font-mono text-caption text-text md:text-right">{!day.excluded && day.amountCents !== null && rate ? formatCents(day.amountCents, rate.currency) : "—"}</div>
                  </div>
                  {!locked ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2 md:ml-[10.75rem]">
                      <form action={setBillingDayOverride} className="flex items-center gap-2">
                        <input type="hidden" name="dayId" value={day.id} />
                        <label className="text-micro uppercase tracking-wider text-text-muted">Override h</label>
                        <input type="number" step="0.25" min="0" name="overrideHours" defaultValue={day.overrideMinutes !== null ? (day.overrideMinutes / 60).toFixed(2) : ""} placeholder={(day.estimatedMinutes / 60).toFixed(1)} className="h-8 w-24 rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent" />
                        <button type="submit" className="text-micro font-semibold text-accent hover:underline">Save</button>
                      </form>
                      <form action={toggleBillingDayExcluded}>
                        <input type="hidden" name="dayId" value={day.id} />
                        <button type="submit" className="text-micro text-text-muted hover:text-text hover:underline">{day.excluded ? "Include" : "Exclude"}</button>
                      </form>
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        </details>
      ) : null}

      {invoiceText ? (
        <details className="rounded-card border border-line bg-panel">
          <summary className="cursor-pointer px-4 py-3 text-caption font-semibold text-text">
            Invoice text
          </summary>
          <pre className="overflow-x-auto border-t border-line px-4 py-3 font-mono text-caption text-text-muted">
            {invoiceText}
          </pre>
        </details>
      ) : null}

      <BillingHistory entries={history} showProject={false} />
      <BillingCreateDialog
        mode="project"
        projects={[{ id: project.id, slug: project.slug, name: project.name }]}
        agents={agents}
        defaultAgent={agentSlug}
      />
    </div>
  );
}
