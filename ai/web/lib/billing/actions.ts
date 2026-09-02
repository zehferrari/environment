"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { publicOriginFromHeaders } from "@/lib/http/public-origin";
import { normalizeBillingPeriod } from "@/lib/billing/period";
import {
  acceptBillingRun,
  createBillingGeneration,
  createOrReplaceBillingReport,
  discardBillingRun,
  clampMinutes,
  isBillingReportLocked,
} from "@/lib/billing/report";
import { selectBillingAgentSlug, triggerBillingRun } from "@/lib/billing/run";

async function requireUserId() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Unauthenticated");
  return userId;
}

function emailList(formData: FormData) {
  return [
    ...new Set(
      formData
        .getAll("authorEmail")
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

async function projectBySlug(slug: string) {
  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, slug: true },
  });
  if (!project) throw new Error("Project not found");
  return project;
}

// Reads the ledger and hands the run to the agent. The report is stored before
// dispatch, so a failed dispatch leaves the facts in place to re-run against
// rather than losing the whole period.
export async function runBillingReport(formData: FormData) {
  const userId = await requireUserId();
  const slug = String(formData.get("projectSlug") ?? "").trim();
  const project = await projectBySlug(slug);

  const period = normalizeBillingPeriod(formData.get("from"), formData.get("to"));
  const branchFilter = String(formData.get("branch") ?? "").trim() || null;
  const agentSlug = await selectBillingAgentSlug(String(formData.get("agentSlug") ?? ""));
  if (!agentSlug) {
    throw new Error("No active monitor agent is available to run this report.");
  }

  const created = await createBillingGeneration({
    projectId: project.id,
    period,
    authorEmails: emailList(formData),
    branchFilter,
    agentSlug,
    requestedById: userId,
  });
  if (!created.ok) throw new Error(created.error);

  const origin = publicOriginFromHeaders(await headers());
  const dispatched = await triggerBillingRun({
    reportId: created.reportId,
    runId: created.runId,
    actorId: userId,
    origin,
  });
  if (!dispatched.ok) throw new Error(dispatched.error);

  revalidatePath(`/projects/${slug}/billing`);
}

export async function runWorkspaceBillingReports(formData: FormData) {
  const userId = await requireUserId();
  const workspaceSlug = String(formData.get("workspaceSlug") ?? "").trim();
  const selectedIds = [...new Set(formData.getAll("projectId").map(String).filter(Boolean))];
  if (selectedIds.length === 0) throw new Error("Select at least one project.");

  const workspace = await db.workspace.findFirst({
    where: { slug: workspaceSlug, archivedAt: null },
    select: {
      id: true,
      projects: {
        where: { projectId: { in: selectedIds } },
        select: { project: { select: { id: true, deletedAt: true, repositoryPath: true } } },
      },
    },
  });
  if (!workspace) throw new Error("Workspace not found");
  const projects = workspace.projects
    .map((link) => link.project)
    .filter((project) => !project.deletedAt && project.repositoryPath && selectedIds.includes(project.id));
  if (projects.length === 0) throw new Error("None of the selected projects has a repository configured.");

  const period = normalizeBillingPeriod(formData.get("from"), formData.get("to"));
  const agentSlug = await selectBillingAgentSlug(String(formData.get("agentSlug") ?? ""));
  if (!agentSlug) throw new Error("No active agent is available.");
  const origin = publicOriginFromHeaders(await headers());
  let dispatchedCount = 0;
  const errors: string[] = [];
  for (const project of projects) {
    const created = await createBillingGeneration({
      projectId: project.id,
      period,
      // Workspace runs deliberately cover the entire repository. Fine-grained
      // author/branch questions remain available on the project Billing tab.
      authorEmails: [],
      branchFilter: null,
      agentSlug,
      requestedById: userId,
      workspaceId: workspace.id,
    });
    if (!created.ok) {
      errors.push(created.error);
      continue;
    }
    const dispatched = await triggerBillingRun({
      reportId: created.reportId,
      runId: created.runId,
      actorId: userId,
      origin,
    });
    if (dispatched.ok) dispatchedCount += 1;
    else errors.push(dispatched.error);
  }
  revalidatePath(`/workspaces/${workspaceSlug}/billing`);
  if (dispatchedCount === 0) throw new Error(errors[0] ?? "No summaries could be started.");
}

export async function reviewBillingRun(formData: FormData) {
  await requireUserId();
  const runId = String(formData.get("runId") ?? "").trim();
  const decision = String(formData.get("decision") ?? "").trim();
  const run = await db.billingRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      report: {
        select: {
          requestedById: true,
          project: { select: { slug: true, workspaces: { select: { workspace: { select: { slug: true } } } } } },
        },
      },
    },
  });
  const userId = (await auth())?.user?.id;
  if (!run || !userId || run.report.requestedById !== userId) throw new Error("Billing run not found");
  const result = decision === "accept" ? await acceptBillingRun(run.id) : await discardBillingRun(run.id);
  if (!result.ok) throw new Error(result.error);
  revalidatePath(`/projects/${run.report.project.slug}/billing`);
  for (const link of run.report.project.workspaces) {
    revalidatePath(`/workspaces/${link.workspace.slug}/billing`);
  }
}

// The ledger without the agent — useful on its own, and the fast path when you
// only want to see what was committed.
export async function refreshBillingLedger(formData: FormData) {
  const userId = await requireUserId();
  const slug = String(formData.get("projectSlug") ?? "").trim();
  const project = await projectBySlug(slug);

  const period = normalizeBillingPeriod(formData.get("from"), formData.get("to"));
  const agentSlug = await selectBillingAgentSlug(String(formData.get("agentSlug") ?? ""));
  if (!agentSlug) throw new Error("No active agent is available.");

  const created = await createOrReplaceBillingReport({
    projectId: project.id,
    period,
    authorEmails: emailList(formData),
    branchFilter: String(formData.get("branch") ?? "").trim() || null,
    agentSlug,
    requestedById: userId,
  });
  if (!created.ok) throw new Error(created.error);
  revalidatePath(`/projects/${slug}/billing`);
}

async function editableReport(reportId: string) {
  const report = await db.billingReport.findUnique({
    where: { id: reportId },
    select: { id: true, status: true, project: { select: { slug: true } } },
  });
  if (!report) throw new Error("Report not found");
  if (isBillingReportLocked(report.status)) {
    throw new Error("This report is finalized. Un-finalize it to make changes.");
  }
  return report;
}

// The agent's estimate is never overwritten — the override is a separate field,
// so the report always shows both what was proposed and what is being billed.
export async function setBillingDayOverride(formData: FormData) {
  await requireUserId();
  const dayId = String(formData.get("dayId") ?? "").trim();
  const day = await db.billingReportDay.findUnique({
    where: { id: dayId },
    select: { id: true, reportId: true },
  });
  if (!day) throw new Error("Day not found");
  const report = await editableReport(day.reportId);

  const raw = String(formData.get("overrideHours") ?? "").trim();
  const overrideMinutes = raw === "" ? null : clampMinutes(Math.round(Number(raw) * 60));
  await db.billingReportDay.update({
    where: { id: day.id },
    data: { overrideMinutes },
  });
  revalidatePath(`/projects/${report.project.slug}/billing`);
}

export async function toggleBillingDayExcluded(formData: FormData) {
  await requireUserId();
  const dayId = String(formData.get("dayId") ?? "").trim();
  const day = await db.billingReportDay.findUnique({
    where: { id: dayId },
    select: { id: true, reportId: true, excluded: true },
  });
  if (!day) throw new Error("Day not found");
  const report = await editableReport(day.reportId);

  await db.billingReportDay.update({
    where: { id: day.id },
    data: { excluded: !day.excluded },
  });
  revalidatePath(`/projects/${report.project.slug}/billing`);
}

export async function setBillingReportFinalized(formData: FormData) {
  const userId = await requireUserId();
  const reportId = String(formData.get("reportId") ?? "").trim();
  const finalize = String(formData.get("finalize") ?? "") === "1";

  const report = await db.billingReport.findUnique({
    where: { id: reportId },
    select: { id: true, status: true, projectId: true, project: { select: { slug: true } } },
  });
  if (!report) throw new Error("Report not found");
  if (finalize && report.status !== "ready") {
    throw new Error("Only a completed report can be finalized.");
  }

  await db.billingReport.update({
    where: { id: report.id },
    data: finalize
      ? { status: "final", finalizedAt: new Date() }
      : { status: "ready", finalizedAt: null },
  });
  await db.activityLog.create({
    data: {
      projectId: report.projectId,
      userId,
      kind: finalize ? "project.billing.finalize" : "project.billing.unfinalize",
      payload: JSON.stringify({ reportId: report.id }),
    },
  });
  revalidatePath(`/projects/${report.project.slug}/billing`);
}
