import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { normalizeWorkspaceSlug } from "@/lib/workspaces/service";
import { normalizeBillingPeriod, formatBillingPeriod, formatBillingDay } from "@/lib/billing/period";
import { formatCents, resolveBillingRate } from "@/lib/billing/rate";
import { buildWorkspaceRollup, type BillingRollupInput } from "@/lib/billing/rollup";
import type { BillingDayRow } from "@/lib/billing/view";
import { selectBillingAgentSlug, listBillingAgents } from "@/lib/billing/run";
import { runWorkspaceBillingReports } from "@/lib/billing/actions";
import BillingProjectSelection from "@/components/billing-project-selection";
import BillingRunPanel from "@/components/billing-run-panel";
import BillingHistory from "@/components/billing-history";
import { listBillingHistory } from "@/lib/billing/history";

export const dynamic = "force-dynamic";

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

const inputClass =
  "h-9 rounded-lg border border-line bg-bg px-2 text-caption outline-none focus:border-accent";

// Workspace Billing launches one independently persisted run per selected
// project, then rolls up each accepted project report.
export default async function WorkspaceBillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const session = await auth();
  const userId = session?.user?.id ?? null;

  const workspace = await db.workspace.findUnique({
    where: { slug: normalizeWorkspaceSlug(slug) },
    select: {
      id: true,
      slug: true,
      name: true,
      hourlyRateCents: true,
      billingCurrency: true,
      projects: {
        select: {
          project: {
            select: {
              id: true,
              slug: true,
              name: true,
              repositoryPath: true,
              hourlyRateCents: true,
              deletedAt: true,
            },
          },
        },
      },
    },
  });
  if (!workspace) notFound();

  const period = normalizeBillingPeriod(single(sp.from), single(sp.to));
  const requestedAgent = single(sp.agent)?.trim() || "";
  const [agents, agentSlug, globalRate] = await Promise.all([
    listBillingAgents(),
    selectBillingAgentSlug(requestedAgent),
    db.systemSettings.findUnique({
      where: { id: "system" },
      select: { hourlyRateCents: true, billingCurrency: true },
    }),
  ]);

  const projects = workspace.projects
    .map((link) => link.project)
    .filter((project) => !project.deletedAt && project.repositoryPath);

  const reports = userId && agentSlug && projects.length > 0
    ? await db.billingReport.findMany({
        where: {
          projectId: { in: projects.map((project) => project.id) },
          fromDate: period.from,
          toDate: period.to,
          agentSlug,
          requestedById: userId,
        },
        include: {
          days: { orderBy: { day: "asc" } },
          runs: {
            orderBy: { generation: "desc" },
            take: 3,
            include: {
              days: { orderBy: { day: "asc" } },
              events: { orderBy: { seq: "asc" } },
            },
          },
        },
      })
    : [];
  const byProject = new Map(reports.map((report) => [report.projectId, report]));
  const history = userId
    ? await listBillingHistory({
        projectIds: projects.map((project) => project.id),
        requestedById: userId,
        excludeReportIds: reports.map((report) => report.id),
        take: 100,
      })
    : [];

  const inputs: BillingRollupInput[] = projects.map((project) => {
    const report = byProject.get(project.id);
    // The report's snapshot wins, so a finished report keeps the rate it was
    // priced at even after the workspace rate moves.
    const rate =
      report?.rateCents && report.currency && report.rateSource
        ? {
            rateCents: report.rateCents,
            currency: report.currency,
            source: report.rateSource as "project" | "workspace" | "global",
          }
        : resolveBillingRate({
            project: { hourlyRateCents: project.hourlyRateCents },
            workspace: {
              hourlyRateCents: workspace.hourlyRateCents,
              billingCurrency: workspace.billingCurrency,
            },
            global: globalRate,
          });

    const days: BillingDayRow[] = (report?.days ?? []).map((day) => ({
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

    return {
      projectId: project.id,
      slug: project.slug,
      name: project.name,
      status: report?.status ?? "none",
      reportId: report?.id ?? null,
      rate,
      days,
    };
  });

  const rollup = buildWorkspaceRollup(inputs);
  const mixedCurrencies = rollup.currencyTotals.length > 1;

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
          <span className="mb-1 block text-nano font-semibold uppercase tracking-wider text-text-muted">Agent</span>
          <select name="agent" defaultValue={agentSlug ?? ""} className={`${inputClass} min-w-[12rem]`}>
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
        <span className="ml-auto self-center text-caption text-text-muted">
          {formatBillingPeriod(period)}
        </span>
      </form>

      <form id="workspace-billing-run" action={runWorkspaceBillingReports}>
        <input type="hidden" name="workspaceSlug" value={workspace.slug} />
        <input type="hidden" name="from" value={period.from} />
        <input type="hidden" name="to" value={period.to} />
        <input type="hidden" name="agentSlug" value={agentSlug ?? ""} />
      </form>
      {projects.length > 0 ? <BillingProjectSelection formId="workspace-billing-run" total={projects.length} /> : null}
      <p className="text-caption text-text-muted">
        Rate precedence: project → workspace → global. Edit the{" "}
        <Link href={`/workspaces/${workspace.slug}/settings`} className="text-accent hover:underline">workspace rate</Link>
        {" "}or the <Link href="/system/settings" className="text-accent hover:underline">global default</Link>;
        project overrides live in each project&apos;s Settings tab.
      </p>

      <div className="flex flex-wrap items-baseline gap-4 rounded-card border border-line bg-panel-soft px-4 py-3">
        <div>
          <div className="text-caption text-text-muted">Total</div>
          <div className="text-body font-semibold text-text">{rollup.totalHours} h</div>
        </div>
        {rollup.currencyTotals.map((total) => (
          <div key={total.currency}>
            <div className="text-caption text-text-muted">{total.currency}</div>
            <div className="text-body font-semibold text-text">
              {formatCents(total.amountCents, total.currency)}
            </div>
          </div>
        ))}
        {mixedCurrencies ? (
          <p className="text-caption text-text-muted">
            Projects in this workspace bill in more than one currency, so they are sub-totalled
            rather than added together.
          </p>
        ) : null}
      </div>

      {projects.length === 0 ? (
        <p className="rounded-card border border-dashed border-line bg-panel-soft/30 px-4 py-6 text-center text-body text-text-muted">
          No project in this workspace has a repository path configured.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-panel">
          <table className="w-full min-w-[46rem] border-collapse text-body">
            <thead>
              <tr className="border-b border-line bg-panel-soft text-nano uppercase tracking-wider text-text-muted">
                <th className="w-10 px-3 py-2 text-left font-semibold"><span className="sr-only">Select</span></th>
                <th className="px-4 py-2 text-left font-semibold">Project</th>
                <th className="px-4 py-2 text-left font-semibold">Rate</th>
                <th className="px-4 py-2 text-left font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">Days</th>
                <th className="px-4 py-2 text-right font-semibold">Hours</th>
                <th className="px-4 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rollup.projects.map((project) => (
                <tr key={project.projectId} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      form="workspace-billing-run"
                      name="projectId"
                      value={project.projectId}
                      aria-label={`Select ${project.name}`}
                      className="h-4 w-4 rounded border-line accent-accent"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/projects/${project.slug}/billing?from=${period.from}&to=${period.to}`}
                      className="text-text hover:text-accent hover:underline"
                    >
                      {project.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-caption text-text-muted">
                    {project.rate
                      ? `${formatCents(project.rate.rateCents, project.rate.currency)}/h · ${
                          project.rate.source === "project"
                            ? "project override"
                            : project.rate.source === "workspace"
                              ? "workspace"
                              : "global default"
                        }`
                      : "hours only"}
                  </td>
                  <td className="px-4 py-2 text-caption text-text-muted">
                    {project.status === "none" ? "not run" : project.status}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-caption text-text-muted">
                    {project.dayCount}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-caption font-semibold text-accent">
                    {project.hours}
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums text-caption text-text">
                    {project.amountCents !== null ? formatCents(project.amountCents) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reports.some((report) => report.runs.some((run) => !["discarded", "superseded"].includes(run.status))) ? (
        <div className="space-y-3">
          <h2 className="text-body font-semibold text-text">Summary output</h2>
          {reports.map((report) => {
            const run = report.runs.find((item) => !["discarded", "superseded"].includes(item.status));
            const project = projects.find((item) => item.id === report.projectId);
            return run && project ? (
              <div key={report.id} className="space-y-1">
                <Link href={`/projects/${project.slug}/billing?from=${period.from}&to=${period.to}&agent=${agentSlug ?? ""}`} className="text-caption font-semibold text-text hover:text-accent hover:underline">
                  {project.name}
                </Link>
                <BillingRunPanel run={run} />
              </div>
            ) : null;
          })}
        </div>
      ) : null}

      {rollup.byDay.length > 0 ? (
        <div>
          <h2 className="mb-2 text-body font-semibold text-text">By day</h2>
          <ul className="space-y-1">
            {rollup.byDay.map((day) => (
              <li
                key={day.day}
                className="flex items-baseline justify-between rounded-lg border border-line bg-panel-soft px-3 py-1.5 text-caption"
              >
                <span className="font-mono text-text">{formatBillingDay(day.day)}</span>
                <span className="font-mono tabular-nums font-semibold text-accent">{day.hours} h</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-caption text-text-muted">
          Nothing to roll up yet. Select projects above and request their summaries for this period.
        </p>
      )}

      <BillingHistory entries={history} showProject />
    </div>
  );
}
