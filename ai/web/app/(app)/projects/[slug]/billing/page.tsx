import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { auth } from "@/lib/auth";
import { listRepoBranches } from "@/lib/tasks/git-changes";
import { listRepoAuthors } from "@/lib/billing/git-ledger";
import { normalizeBillingPeriod, formatBillingPeriod } from "@/lib/billing/period";
import { formatCents, formatRate } from "@/lib/billing/rate";
import {
  findBillingReport,
  parseAuthorEmails,
  parseLedger,
  resolveProjectBillingRate,
} from "@/lib/billing/report";
import { listBillingAgents, selectBillingAgentSlug } from "@/lib/billing/run";
import { buildBillingView, billingInvoiceText, factsLine, type BillingDayRow } from "@/lib/billing/view";
import {
  runBillingReport,
  refreshBillingLedger,
  setBillingDayOverride,
  toggleBillingDayExcluded,
  setBillingReportFinalized,
} from "@/lib/billing/actions";
import BillingCopyButton from "@/components/billing-copy-button";

export const dynamic = "force-dynamic";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const inputClass =
  "h-9 rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent";

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
    select: { id: true, name: true, repositoryPath: true, defaultGitUserEmail: true },
  });
  if (!project) notFound();
  if (!project.repositoryPath) notFound();

  const period = normalizeBillingPeriod(single(sp.from), single(sp.to));
  const requestedBranch = single(sp.branch)?.trim() || "";
  const requestedAgent = single(sp.agent)?.trim() || "";

  const [branches, authors, agents, rateInfo] = await Promise.all([
    listRepoBranches(project.repositoryPath),
    listRepoAuthors({
      repositoryPath: project.repositoryPath,
      from: period.from,
      to: period.to,
      branchName: requestedBranch || null,
    }),
    listBillingAgents(),
    resolveProjectBillingRate(project.id),
  ]);

  const selectedBranch = branches.some((b) => b.name === requestedBranch) ? requestedBranch : "";
  const agentSlug = (await selectBillingAgentSlug(requestedAgent)) ?? "";

  // Default the author to the project's git identity when it is someone who
  // actually committed in this period; otherwise leave it on everyone, because a
  // silent filter that matches nobody looks identical to a quiet fortnight.
  const requestedAuthors = sp.authorEmail
    ? (Array.isArray(sp.authorEmail) ? sp.authorEmail : [sp.authorEmail]).map((v) => v.toLowerCase())
    : null;
  const projectEmail = project.defaultGitUserEmail?.toLowerCase() ?? null;
  const selectedAuthors =
    requestedAuthors ??
    (projectEmail && authors.some((a) => a.email.toLowerCase() === projectEmail) ? [projectEmail] : []);

  const report = userId && agentSlug
    ? await findBillingReport({
        projectId: project.id,
        period,
        agentSlug,
        requestedById: userId,
      })
    : null;

  const storedRate =
    report?.rateCents && report.currency && report.rateSource
      ? {
          rateCents: report.rateCents,
          currency: report.currency,
          source: report.rateSource as "project" | "workspace",
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
  const reportAuthors = parseAuthorEmails(report?.authorEmails);

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
      <form className="flex flex-wrap items-end gap-3 rounded-card border border-line bg-panel p-3 text-body">
        <label className="block">
          <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">From</span>
          <input type="date" name="from" defaultValue={period.from} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">To</span>
          <input type="date" name="to" defaultValue={period.to} className={inputClass} />
        </label>
        <label className="block">
          <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">Author</span>
          <select name="authorEmail" defaultValue={selectedAuthors[0] ?? ""} className={`${inputClass} min-w-[14rem]`}>
            <option value="">Everyone</option>
            {authors.map((author) => (
              <option key={author.email} value={author.email}>
                {author.email} ({author.commits})
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">Branch</span>
          <select name="branch" defaultValue={selectedBranch} className={`${inputClass} min-w-[12rem]`}>
            <option value="">All branches</option>
            {branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">Agent</span>
          <select name="agent" defaultValue={agentSlug} className={`${inputClass} min-w-[12rem]`}>
            {agents.map((agent) => (
              <option key={agent.slug} value={agent.slug}>
                {agent.name} · {agent.role}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="h-9 rounded-lg border border-line bg-panel px-3 text-caption font-semibold text-text hover:border-accent"
        >
          Apply
        </button>
      </form>

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
              {formatRate(rate)} · {rate.source === "project" ? "project override" : "workspace rate"}
              {rateInfo.workspace ? ` (${rateInfo.workspace.name})` : ""}
            </>
          ) : (
            <>No hourly rate set — hours only. Add one in project or workspace settings.</>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {invoiceText ? <BillingCopyButton text={invoiceText} /> : null}

          <form action={refreshBillingLedger}>
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="from" value={period.from} />
            <input type="hidden" name="to" value={period.to} />
            <input type="hidden" name="branch" value={selectedBranch} />
            <input type="hidden" name="agentSlug" value={agentSlug} />
            {selectedAuthors.map((email) => (
              <input key={email} type="hidden" name="authorEmail" value={email} />
            ))}
            <button
              type="submit"
              disabled={locked}
              className="h-9 rounded-lg border border-line bg-panel px-3 text-caption font-semibold text-text hover:border-accent disabled:opacity-50"
            >
              Read commits
            </button>
          </form>

          <form action={runBillingReport}>
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="from" value={period.from} />
            <input type="hidden" name="to" value={period.to} />
            <input type="hidden" name="branch" value={selectedBranch} />
            <input type="hidden" name="agentSlug" value={agentSlug} />
            {selectedAuthors.map((email) => (
              <input key={email} type="hidden" name="authorEmail" value={email} />
            ))}
            <button
              type="submit"
              disabled={locked}
              className="h-9 rounded-lg bg-accent px-4 text-caption font-semibold text-bg hover:opacity-90 disabled:opacity-50"
            >
              Run
            </button>
          </form>

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

      {report && report.status === "running" ? (
        <p className="rounded-card border border-line bg-panel-soft px-4 py-3 text-body text-text-muted">
          Sent to <span className="font-medium text-text">{report.agentSlug}</span>. The summary and
          estimates appear here when it answers —{" "}
          <Link href={`/agents/${report.agentSlug}/chat`} className="text-accent hover:underline">
            follow the run
          </Link>
          , then reload.
        </p>
      ) : null}

      {report && reportAuthors.length > 0 ? (
        <p className="text-caption text-text-muted">
          Filtered to {reportAuthors.join(", ")}
          {report.branchFilter ? ` on ${report.branchFilter}` : " across all branches"}.
        </p>
      ) : null}

      {!report ? (
        <p className="rounded-card border border-dashed border-line bg-panel-soft/30 px-4 py-6 text-center text-body text-text-muted">
          Choose a period and press <span className="font-medium text-text">Read commits</span> to see
          what was committed, or <span className="font-medium text-text">Run</span> to have{" "}
          {agentSlug || "an agent"} summarise it and estimate the time.
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
        <ol className="space-y-2">
          {view.days.map((day) => (
            <li
              key={day.id}
              className={`rounded-card border px-4 py-3 ${
                day.excluded ? "border-dashed border-line bg-panel-soft/40 opacity-60" : "border-line bg-panel-soft"
              }`}
            >
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-caption font-medium text-text">{day.label}</span>
                    <span className="font-mono text-micro text-text-muted">{day.factsLine}</span>
                  </div>
                  <p className="mt-1 break-words text-body text-text">{day.summary}</p>
                  {day.rationale ? (
                    <p className="mt-1 break-words text-caption text-text-muted">{day.rationale}</p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-caption font-semibold text-accent">{day.hours} h</span>
                  {day.amountCents !== null ? (
                    <span className="font-mono text-caption text-text">{formatCents(day.amountCents)}</span>
                  ) : null}
                </div>
              </div>

              {!locked ? (
                <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
                  <form action={setBillingDayOverride} className="flex items-center gap-2">
                    <input type="hidden" name="dayId" value={day.id} />
                    <label className="text-micro uppercase tracking-wider text-text-muted">Override h</label>
                    <input
                      type="number"
                      step="0.25"
                      min="0"
                      name="overrideHours"
                      defaultValue={day.overrideMinutes !== null ? (day.overrideMinutes / 60).toFixed(2) : ""}
                      placeholder={(day.estimatedMinutes / 60).toFixed(1)}
                      className="h-8 w-24 rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent"
                    />
                    <button type="submit" className="text-micro font-semibold text-accent hover:underline">
                      Save
                    </button>
                  </form>
                  <form action={toggleBillingDayExcluded}>
                    <input type="hidden" name="dayId" value={day.id} />
                    <button type="submit" className="text-micro text-text-muted hover:text-text hover:underline">
                      {day.excluded ? "Include" : "Exclude"}
                    </button>
                  </form>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {report?.notes ? (
        <p className="rounded-card border border-line bg-panel px-4 py-3 text-body text-text-muted">
          {report.notes}
        </p>
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
    </div>
  );
}
