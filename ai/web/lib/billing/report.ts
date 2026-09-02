import { db } from "@/lib/db";
import { getPrimaryWorkspaceDefaults } from "@/lib/settings/effective";
import { readBillingLedger, type BillingLedger } from "@/lib/billing/git-ledger";
import { resolveBillingRate, type BillingRate } from "@/lib/billing/rate";
import type { BillingPeriod } from "@/lib/billing/period";

export type BillingReportStatus = "queued" | "running" | "ready" | "failed" | "final";

export const BILLING_REPORT_STATUSES: BillingReportStatus[] = [
  "queued",
  "running",
  "ready",
  "failed",
  "final",
];

export function isBillingReportStatus(value: unknown): value is BillingReportStatus {
  return typeof value === "string" && (BILLING_REPORT_STATUSES as string[]).includes(value);
}

// A finalized report is the version that was sent to a client. Nothing rewrites
// it — not a re-run, not an override, not a later rate change.
export function isBillingReportLocked(status: string) {
  return status === "final";
}

export function parseAuthorEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

export function parseLedger(raw: string | null | undefined): BillingLedger | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BillingLedger;
  } catch {
    return null;
  }
}

// The project's own rate, then the rate of the workspace it primarily belongs
// to, then the system-wide Billing default.
// "Primary" follows getPrimaryWorkspaceDefaults — the oldest non-archived link —
// which is the convention every other inherited setting in this app already uses,
// so a project in two workspaces resolves the same way here as everywhere else.
export async function resolveProjectBillingRate(projectId: string): Promise<{
  rate: BillingRate | null;
  workspace: { id: string; slug: string; name: string } | null;
}> {
  const [project, workspace, global] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId },
      select: { hourlyRateCents: true },
    }),
    db.workspace.findFirst({
      where: { projects: { some: { projectId } }, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, slug: true, name: true, hourlyRateCents: true, billingCurrency: true },
    }),
    db.systemSettings.findUnique({
      where: { id: "system" },
      select: { hourlyRateCents: true, billingCurrency: true },
    }),
  ]);
  if (!project) return { rate: null, workspace: null };

  const rate = resolveBillingRate({
    project: { hourlyRateCents: project.hourlyRateCents },
    workspace: workspace
      ? { hourlyRateCents: workspace.hourlyRateCents, billingCurrency: workspace.billingCurrency }
      : null,
    global,
  });
  return {
    rate,
    workspace: workspace ? { id: workspace.id, slug: workspace.slug, name: workspace.name } : null,
  };
}

export type CreateBillingReportArgs = {
  projectId: string;
  period: BillingPeriod;
  authorEmails: string[];
  branchFilter: string | null;
  agentSlug: string;
  requestedById: string;
  workspaceId?: string | null;
};

export type CreateBillingReportResult =
  | { ok: true; reportId: string; ledger: BillingLedger; rate: BillingRate | null }
  | { ok: false; error: string };

export type CreateBillingGenerationResult =
  | { ok: true; reportId: string; runId: string; ledger: BillingLedger; rate: BillingRate | null }
  | { ok: false; error: string };

async function readBillingInputs(args: CreateBillingReportArgs) {
  const project = await db.project.findFirst({
    where: { id: args.projectId, deletedAt: null },
    select: { id: true, repositoryPath: true },
  });
  if (!project) return { ok: false as const, error: "Project not found." };
  if (!project.repositoryPath) {
    return { ok: false as const, error: "This project has no repository path configured." };
  }

  const ledger = await readBillingLedger({
    repositoryPath: project.repositoryPath,
    from: args.period.from,
    to: args.period.to,
    authorEmails: args.authorEmails,
    branchName: args.branchFilter,
  });
  if (ledger.error) return { ok: false as const, error: ledger.error };
  const { rate, workspace } = await resolveProjectBillingRate(args.projectId);
  return { ok: true as const, ledger, rate, workspace };
}

// Creates an immutable generation. Existing accepted rows are untouched until
// acceptBillingRun is called; the first successful generation is auto-accepted.
export async function createBillingGeneration(
  args: CreateBillingReportArgs,
): Promise<CreateBillingGenerationResult> {
  const inputs = await readBillingInputs(args);
  if (!inputs.ok) return inputs;

  const existing = await db.billingReport.findUnique({
    where: {
      projectId_fromDate_toDate_agentSlug_requestedById: {
        projectId: args.projectId,
        fromDate: args.period.from,
        toDate: args.period.to,
        agentSlug: args.agentSlug,
        requestedById: args.requestedById,
      },
    },
    select: { id: true, status: true, acceptedRunId: true, _count: { select: { days: true } } },
  });
  if (existing && isBillingReportLocked(existing.status)) {
    return { ok: false, error: "This report is finalized. Un-finalize it before regenerating." };
  }

  const workspaceId = args.workspaceId ?? inputs.workspace?.id ?? null;
  const serializedLedger = JSON.stringify(inputs.ledger);
  const serializedAuthors = JSON.stringify(args.authorEmails);
  const result = await db.$transaction(async (tx) => {
    const report = existing
      ? await tx.billingReport.update({
          where: { id: existing.id },
          data: existing._count.days === 0 && !existing.acceptedRunId
            ? {
                workspaceId,
                authorEmails: serializedAuthors,
                branchFilter: args.branchFilter,
                ledger: serializedLedger,
                status: "queued",
                error: null,
                rateCents: inputs.rate?.rateCents ?? null,
                currency: inputs.rate?.currency ?? null,
                rateSource: inputs.rate?.source ?? null,
              }
            : {},
          select: { id: true },
        })
      : await tx.billingReport.create({
          data: {
            projectId: args.projectId,
            workspaceId,
            fromDate: args.period.from,
            toDate: args.period.to,
            authorEmails: serializedAuthors,
            branchFilter: args.branchFilter,
            agentSlug: args.agentSlug,
            status: "queued",
            ledger: serializedLedger,
            rateCents: inputs.rate?.rateCents ?? null,
            currency: inputs.rate?.currency ?? null,
            rateSource: inputs.rate?.source ?? null,
            requestedById: args.requestedById,
          },
          select: { id: true },
        });

    const latest = await tx.billingRun.findFirst({
      where: { reportId: report.id },
      orderBy: { generation: "desc" },
      select: { generation: true },
    });
    const run = await tx.billingRun.create({
      data: {
        reportId: report.id,
        generation: (latest?.generation ?? 0) + 1,
        authorEmails: serializedAuthors,
        branchFilter: args.branchFilter,
        ledger: serializedLedger,
        workspaceId,
        rateCents: inputs.rate?.rateCents ?? null,
        currency: inputs.rate?.currency ?? null,
        rateSource: inputs.rate?.source ?? null,
      },
      select: { id: true },
    });
    return { reportId: report.id, runId: run.id };
  });

  return { ok: true, ...result, ledger: inputs.ledger, rate: inputs.rate };
}

// Reads the ledger, snapshots the rate, and stores a queued report. The unique
// key is (project, period, agent, requester), so asking the same question twice
// replaces the draft instead of littering the project with near-identical rows.
export async function createOrReplaceBillingReport(
  args: CreateBillingReportArgs,
): Promise<CreateBillingReportResult> {
  const inputs = await readBillingInputs(args);
  if (!inputs.ok) return inputs;
  const { ledger, rate, workspace } = inputs;

  const existing = await db.billingReport.findUnique({
    where: {
      projectId_fromDate_toDate_agentSlug_requestedById: {
        projectId: args.projectId,
        fromDate: args.period.from,
        toDate: args.period.to,
        agentSlug: args.agentSlug,
        requestedById: args.requestedById,
      },
    },
    select: { id: true, status: true, _count: { select: { days: true } } },
  });
  if (existing && isBillingReportLocked(existing.status)) {
    return { ok: false, error: "This report is finalized. Un-finalize it before running again." };
  }
  if (existing && existing._count.days > 0) {
    return { ok: false, error: "This report already has a summary. Use Regenerate to refresh it safely." };
  }

  const data = {
    projectId: args.projectId,
    workspaceId: args.workspaceId ?? workspace?.id ?? null,
    fromDate: args.period.from,
    toDate: args.period.to,
    authorEmails: JSON.stringify(args.authorEmails),
    branchFilter: args.branchFilter,
    agentSlug: args.agentSlug,
    status: "queued",
    runMessageId: null,
    error: null,
    ledger: JSON.stringify(ledger),
    notes: null,
    rateCents: rate?.rateCents ?? null,
    currency: rate?.currency ?? null,
    rateSource: rate?.source ?? null,
    requestedById: args.requestedById,
    finalizedAt: null,
  };

  const report = await db.$transaction(async (tx) => {
    if (existing) {
      return tx.billingReport.update({
        where: { id: existing.id },
        data,
        select: { id: true },
      });
    }
    return tx.billingReport.create({ data, select: { id: true } });
  });

  return { ok: true, reportId: report.id, ledger, rate };
}

export async function getBillingReport(reportId: string) {
  return db.billingReport.findUnique({
    where: { id: reportId },
    include: {
      days: { orderBy: { day: "asc" } },
      project: { select: { id: true, slug: true, name: true, repositoryPath: true } },
    },
  });
}

export async function findBillingReport(args: {
  projectId: string;
  period: BillingPeriod;
  agentSlug: string;
  requestedById: string;
}) {
  return db.billingReport.findUnique({
    where: {
      projectId_fromDate_toDate_agentSlug_requestedById: {
        projectId: args.projectId,
        fromDate: args.period.from,
        toDate: args.period.to,
        agentSlug: args.agentSlug,
        requestedById: args.requestedById,
      },
    },
    include: {
      days: { orderBy: { day: "asc" } },
      runs: {
        orderBy: { generation: "desc" },
        take: 6,
        include: {
          days: { orderBy: { day: "asc" } },
          events: { orderBy: { seq: "asc" } },
        },
      },
    },
  });
}

export type SubmittedBillingDay = {
  day: string;
  summary: string;
  estimatedMinutes: number;
  rationale?: string | null;
};

export type ApplyBillingResultArgs = {
  reportId: string;
  days: SubmittedBillingDay[];
  notes?: string | null;
};

type PreparedBillingRow = {
  day: string;
  summary: string;
  estimatedMinutes: number;
  rationale: string | null;
  commitCount: number;
  insertions: number;
  deletions: number;
  filesTouched: number;
  firstCommitAt: string | null;
  lastCommitAt: string | null;
};

function prepareBillingRows(ledger: BillingLedger, submittedDays: SubmittedBillingDay[]) {
  const byDay = new Map(ledger.days.map((day) => [day.day, day]));
  const rows: PreparedBillingRow[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const submitted of submittedDays) {
    const facts = byDay.get(submitted.day);
    if (!facts || seen.has(submitted.day)) {
      skipped.push(submitted.day);
      continue;
    }
    seen.add(submitted.day);
    rows.push({
      day: facts.day,
      summary: String(submitted.summary ?? "").trim().slice(0, 2000),
      estimatedMinutes: clampMinutes(submitted.estimatedMinutes),
      rationale: submitted.rationale ? String(submitted.rationale).trim().slice(0, 4000) : null,
      commitCount: facts.commitCount,
      insertions: facts.insertions,
      deletions: facts.deletions,
      filesTouched: facts.filesTouched,
      firstCommitAt: facts.firstCommitAt,
      lastCommitAt: facts.lastCommitAt,
    });
  }
  for (const facts of ledger.days) {
    if (seen.has(facts.day)) continue;
    rows.push({
      day: facts.day,
      summary: facts.commits[0]?.subject ?? "No summary returned for this day.",
      estimatedMinutes: 0,
      rationale: "The agent did not return an estimate for this day.",
      commitCount: facts.commitCount,
      insertions: facts.insertions,
      deletions: facts.deletions,
      filesTouched: facts.filesTouched,
      firstCommitAt: facts.firstCommitAt,
      lastCommitAt: facts.lastCommitAt,
    });
  }
  rows.sort((a, b) => a.day.localeCompare(b.day));
  return { rows, skipped };
}

export async function acceptBillingRun(runId: string) {
  const run = await db.billingRun.findUnique({
    where: { id: runId },
    include: { days: { orderBy: { day: "asc" } }, report: { select: { id: true, status: true, acceptedRunId: true } } },
  });
  if (!run) return { ok: false as const, error: "Billing run not found." };
  if (run.report.status === "final") return { ok: false as const, error: "This report is finalized." };
  if (run.status !== "ready" && run.status !== "accepted") {
    return { ok: false as const, error: "Only a completed candidate can be accepted." };
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.billingReportDay.deleteMany({ where: { reportId: run.reportId } });
    for (const day of run.days) {
      await tx.billingReportDay.create({
        data: {
          reportId: run.reportId,
          day: day.day,
          summary: day.summary,
          estimatedMinutes: day.estimatedMinutes,
          overrideMinutes: null,
          excluded: false,
          rationale: day.rationale,
          commitCount: day.commitCount,
          insertions: day.insertions,
          deletions: day.deletions,
          filesTouched: day.filesTouched,
          firstCommitAt: day.firstCommitAt,
          lastCommitAt: day.lastCommitAt,
        },
      });
    }
    if (run.report.acceptedRunId && run.report.acceptedRunId !== run.id) {
      await tx.billingRun.updateMany({
        where: { id: run.report.acceptedRunId, status: "accepted" },
        data: { status: "superseded" },
      });
    }
    await tx.billingRun.update({
      where: { id: run.id },
      data: { status: "accepted", acceptedAt: now, discardedAt: null },
    });
    await tx.billingReport.update({
      where: { id: run.reportId },
      data: {
        acceptedRunId: run.id,
        workspaceId: run.workspaceId,
        authorEmails: run.authorEmails,
        branchFilter: run.branchFilter,
        ledger: run.ledger,
        notes: run.notes,
        rateCents: run.rateCents,
        currency: run.currency,
        rateSource: run.rateSource,
        status: "ready",
        error: null,
      },
    });
  });
  return { ok: true as const, reportId: run.reportId };
}

export async function discardBillingRun(runId: string) {
  const run = await db.billingRun.findUnique({
    where: { id: runId },
    select: { id: true, status: true, report: { select: { status: true } } },
  });
  if (!run) return { ok: false as const, error: "Billing run not found." };
  if (run.report.status === "final") return { ok: false as const, error: "This report is finalized." };
  if (run.status !== "ready") return { ok: false as const, error: "Only a ready candidate can be discarded." };
  await db.billingRun.update({
    where: { id: run.id },
    data: { status: "discarded", discardedAt: new Date() },
  });
  return { ok: true as const };
}

export async function applyBillingRunResult(args: {
  runId: string;
  days: SubmittedBillingDay[];
  notes?: string | null;
}) {
  const run = await db.billingRun.findUnique({
    where: { id: args.runId },
    select: { id: true, status: true, ledger: true, reportId: true, report: { select: { acceptedRunId: true, status: true } } },
  });
  if (!run) return { ok: false as const, error: "Billing run not found." };
  if (run.report.status === "final") return { ok: false as const, error: "This report is finalized." };
  if (run.status === "ready" || run.status === "accepted" || run.status === "discarded" || run.status === "superseded") {
    return { ok: false as const, error: "This generation has already been submitted." };
  }
  const ledger = parseLedger(run.ledger);
  if (!ledger) return { ok: false as const, error: "This generation has no readable ledger." };
  const { rows, skipped } = prepareBillingRows(ledger, args.days);
  const notes = args.notes ? String(args.notes).trim().slice(0, 4000) : null;
  await db.$transaction(async (tx) => {
    await tx.billingRunDay.deleteMany({ where: { runId: run.id } });
    for (const row of rows) await tx.billingRunDay.create({ data: { ...row, runId: run.id } });
    await tx.billingRun.update({
      where: { id: run.id },
      data: { status: "ready", notes, error: null, completedAt: new Date() },
    });
  });
  // First result has nothing to compare against, so it becomes the accepted
  // draft immediately. Later generations wait for an explicit operator choice.
  if (!run.report.acceptedRunId) {
    const accepted = await acceptBillingRun(run.id);
    if (!accepted.ok) return accepted;
  }
  return { ok: true as const, written: rows.length, skipped };
}

// Writes the agent's answer, but only for days the ledger actually contains and
// only with the ledger's own facts. The agent supplies judgement; it never gets
// to state what was committed, so an invented day is dropped rather than billed.
export async function applyBillingResult(args: ApplyBillingResultArgs): Promise<
  { ok: true; written: number; skipped: string[] } | { ok: false; error: string }
> {
  const report = await db.billingReport.findUnique({
    where: { id: args.reportId },
    select: { id: true, status: true, ledger: true },
  });
  if (!report) return { ok: false, error: "Report not found." };
  if (isBillingReportLocked(report.status)) {
    return { ok: false, error: "This report is finalized." };
  }

  const ledger = parseLedger(report.ledger);
  if (!ledger) return { ok: false, error: "This report has no readable ledger." };
  const byDay = new Map(ledger.days.map((day) => [day.day, day]));

  const rows: {
    day: string;
    summary: string;
    estimatedMinutes: number;
    rationale: string | null;
    commitCount: number;
    insertions: number;
    deletions: number;
    filesTouched: number;
    firstCommitAt: string | null;
    lastCommitAt: string | null;
  }[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();

  for (const submitted of args.days) {
    const facts = byDay.get(submitted.day);
    if (!facts || seen.has(submitted.day)) {
      skipped.push(submitted.day);
      continue;
    }
    seen.add(submitted.day);
    rows.push({
      day: facts.day,
      summary: String(submitted.summary ?? "").trim().slice(0, 2000),
      estimatedMinutes: clampMinutes(submitted.estimatedMinutes),
      rationale: submitted.rationale ? String(submitted.rationale).trim().slice(0, 4000) : null,
      commitCount: facts.commitCount,
      insertions: facts.insertions,
      deletions: facts.deletions,
      filesTouched: facts.filesTouched,
      firstCommitAt: facts.firstCommitAt,
      lastCommitAt: facts.lastCommitAt,
    });
  }

  // A day the agent left out is still a day that was worked. Carry it with a
  // zero estimate and an explicit note so it shows up for a human rather than
  // silently vanishing from the invoice.
  for (const facts of ledger.days) {
    if (seen.has(facts.day)) continue;
    rows.push({
      day: facts.day,
      summary: facts.commits[0]?.subject ?? "No summary returned for this day.",
      estimatedMinutes: 0,
      rationale: "The agent did not return an estimate for this day.",
      commitCount: facts.commitCount,
      insertions: facts.insertions,
      deletions: facts.deletions,
      filesTouched: facts.filesTouched,
      firstCommitAt: facts.firstCommitAt,
      lastCommitAt: facts.lastCommitAt,
    });
  }

  rows.sort((a, b) => a.day.localeCompare(b.day));

  await db.$transaction(async (tx) => {
    await tx.billingReportDay.deleteMany({ where: { reportId: report.id } });
    for (const row of rows) {
      await tx.billingReportDay.create({ data: { ...row, reportId: report.id } });
    }
    await tx.billingReport.update({
      where: { id: report.id },
      data: {
        status: "ready",
        error: null,
        notes: args.notes ? String(args.notes).trim().slice(0, 4000) : null,
      },
    });
  });

  return { ok: true, written: rows.length, skipped };
}

// A day is minutes, not weeks. The cap stops a misplaced decimal in an agent
// response turning into a five-figure line on an invoice.
export function clampMinutes(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.round(parsed), 24 * 60);
}

export async function markBillingReportFailed(reportId: string, error: string) {
  await db.billingReport.update({
    where: { id: reportId },
    data: { status: "failed", error: error.slice(0, 2000) },
  });
}

export async function markBillingReportRunning(reportId: string, runMessageId: string | null) {
  await db.billingReport.update({
    where: { id: reportId },
    data: { status: "running", runMessageId, error: null },
  });
}

export async function markBillingRunFailed(runId: string, error: string) {
  const run = await db.billingRun.update({
    where: { id: runId },
    data: { status: "failed", error: error.slice(0, 2000), completedAt: new Date() },
    select: { reportId: true, report: { select: { acceptedRunId: true } } },
  });
  if (!run.report.acceptedRunId) {
    await db.billingReport.update({
      where: { id: run.reportId },
      data: { status: "failed", error: error.slice(0, 2000) },
    });
  }
}

export async function markBillingRunRunning(runId: string, messageId: string) {
  const run = await db.billingRun.update({
    where: { id: runId },
    data: { status: "running", messageId, error: null },
    select: { reportId: true, report: { select: { acceptedRunId: true } } },
  });
  if (!run.report.acceptedRunId) {
    await db.billingReport.update({
      where: { id: run.reportId },
      data: { status: "running", runMessageId: messageId, error: null },
    });
  }
}
