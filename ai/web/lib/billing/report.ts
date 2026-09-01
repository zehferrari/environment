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

// The project's own rate, and the rate of the workspace it primarily belongs to.
// "Primary" follows getPrimaryWorkspaceDefaults — the oldest non-archived link —
// which is the convention every other inherited setting in this app already uses,
// so a project in two workspaces resolves the same way here as everywhere else.
export async function resolveProjectBillingRate(projectId: string): Promise<{
  rate: BillingRate | null;
  workspace: { id: string; slug: string; name: string } | null;
}> {
  const [project, workspace] = await Promise.all([
    db.project.findUnique({
      where: { id: projectId },
      select: { hourlyRateCents: true },
    }),
    db.workspace.findFirst({
      where: { projects: { some: { projectId } }, archivedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, slug: true, name: true, hourlyRateCents: true, billingCurrency: true },
    }),
  ]);
  if (!project) return { rate: null, workspace: null };

  const rate = resolveBillingRate({
    project: { hourlyRateCents: project.hourlyRateCents },
    workspace: workspace
      ? { hourlyRateCents: workspace.hourlyRateCents, billingCurrency: workspace.billingCurrency }
      : null,
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

// Reads the ledger, snapshots the rate, and stores a queued report. The unique
// key is (project, period, agent, requester), so asking the same question twice
// replaces the draft instead of littering the project with near-identical rows.
export async function createOrReplaceBillingReport(
  args: CreateBillingReportArgs,
): Promise<CreateBillingReportResult> {
  const project = await db.project.findFirst({
    where: { id: args.projectId, deletedAt: null },
    select: { id: true, repositoryPath: true },
  });
  if (!project) return { ok: false, error: "Project not found." };
  if (!project.repositoryPath) {
    return { ok: false, error: "This project has no repository path configured." };
  }

  const ledger = await readBillingLedger({
    repositoryPath: project.repositoryPath,
    from: args.period.from,
    to: args.period.to,
    authorEmails: args.authorEmails,
    branchName: args.branchFilter,
  });
  if (ledger.error) return { ok: false, error: ledger.error };

  const { rate, workspace } = await resolveProjectBillingRate(args.projectId);

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
    select: { id: true, status: true },
  });
  if (existing && isBillingReportLocked(existing.status)) {
    return { ok: false, error: "This report is finalized. Un-finalize it before running again." };
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
      // A re-run answers the same question again, so the previous answer goes.
      await tx.billingReportDay.deleteMany({ where: { reportId: existing.id } });
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
    include: { days: { orderBy: { day: "asc" } } },
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
