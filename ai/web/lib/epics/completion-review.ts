import { db } from "@/lib/db";
import { sendEpicWorkflowNotification } from "@/lib/agents/workflow/notifications/epic";
import { effectiveEpicBranchName } from "@/lib/work-items/branches";
import { effectiveCommitPrefix } from "@/lib/work-items/keys";
import { resolveActiveMonitorAgent } from "@/lib/tasks/repository-state";

export const COMPLETION_REVIEW_STATUSES = [
  "Not Required",
  "Preparing",
  "Pending",
  "Approval Pending",
  "Approved",
  "Changes Requested",
  "Operational Error",
] as const;

export type CompletionReviewStatus = (typeof COMPLETION_REVIEW_STATUSES)[number];
export type CompletionReviewFindingStatus = "Pass" | "Partial" | "Fail";
export type CompletionReviewTestStatus = "Pass" | "Fail";

export type CompletionReviewReport = {
  summary: string;
  requirements: Array<{
    requirement: string;
    status: CompletionReviewFindingStatus;
    evidence: string;
  }>;
  tests: Array<{
    command: string;
    status: CompletionReviewTestStatus;
    evidence: string;
  }>;
  residualRisks: string;
};

function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

export function parseCompletionReviewReport(value: unknown): CompletionReviewReport | null {
  if (!value || typeof value !== "object") return null;
  if (JSON.stringify(value).length > 30_000) return null;
  const raw = value as Record<string, unknown>;
  const summary = cleanText(raw.summary, 8000);
  const residualRisks = cleanText(raw.residualRisks, 8000);
  if (!summary || !residualRisks || !Array.isArray(raw.requirements) || !Array.isArray(raw.tests)) {
    return null;
  }
  if (raw.requirements.length === 0 || raw.requirements.length > 50 || raw.tests.length === 0 || raw.tests.length > 30) {
    return null;
  }

  const requirements = raw.requirements.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const requirement = cleanText(row.requirement, 1000);
    const evidence = cleanText(row.evidence, 4000);
    const status = row.status;
    if (!requirement || !evidence || (status !== "Pass" && status !== "Partial" && status !== "Fail")) return [];
    return [{ requirement, evidence, status: status as CompletionReviewFindingStatus }];
  });
  const tests = raw.tests.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const command = cleanText(row.command, 1000);
    const evidence = cleanText(row.evidence, 4000);
    const status = row.status;
    if (!command || !evidence || (status !== "Pass" && status !== "Fail")) return [];
    return [{ command, evidence, status: status as CompletionReviewTestStatus }];
  });
  if (requirements.length !== raw.requirements.length || tests.length !== raw.tests.length) return null;
  return { summary, requirements, tests, residualRisks };
}

export function completionReviewReportCanApprove(report: CompletionReviewReport) {
  return report.requirements.every((item) => item.status === "Pass")
    && report.tests.every((item) => item.status === "Pass");
}

export function renderCompletionReviewReport(report: CompletionReviewReport, outcome: "APPROVED" | "CHANGES REQUESTED") {
  const lines = [
    `## Whole-Epic acceptance review — ${outcome}`,
    "",
    report.summary,
    "",
    "### Requirement matrix",
    "",
    "| Requirement | Result | Evidence |",
    "|---|---|---|",
    ...report.requirements.map((item) => `| ${escapeTable(item.requirement)} | ${item.status} | ${escapeTable(item.evidence)} |`),
    "",
    "### Combined validation",
    "",
    "| Command/check | Result | Evidence |",
    "|---|---|---|",
    ...report.tests.map((item) => `| ${escapeTable(item.command)} | ${item.status} | ${escapeTable(item.evidence)} |`),
    "",
    "### Residual risks",
    "",
    report.residualRisks,
  ];
  return lines.join("\n");
}

function escapeTable(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

async function resolveCompletionReviewer(epic: {
  deployReviewer: {
    status: string;
    agent: { slug: string; deactivatedAt: Date | null } | null;
  } | null;
}) {
  if (
    epic.deployReviewer?.status === "active" &&
    epic.deployReviewer.agent?.slug &&
    !epic.deployReviewer.agent.deactivatedAt
  ) {
    return { slug: epic.deployReviewer.agent.slug, fallback: false };
  }
  const monitor = await resolveActiveMonitorAgent();
  return { slug: monitor.ok ? monitor.agentSlug : null, fallback: true };
}

export async function triggerCompletionReview(args: {
  epicId: string;
  actorId: string;
}) {
  const epic = await db.epic.findUnique({
    where: { id: args.epicId },
    select: {
      id: true,
      title: true,
      workItemKey: true,
      description: true,
      status: true,
      completionReviewStatus: true,
      completionReviewCandidateSha: true,
      branchName: true,
      commitPrefix: true,
      projectId: true,
      project: { select: { slug: true, repositoryPath: true } },
      deployReviewer: {
        select: {
          status: true,
          agent: { select: { slug: true, deactivatedAt: true } },
        },
      },
      tasks: {
        where: { parentTaskId: null, deletedAt: null },
        orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          workItemKey: true,
          title: true,
          status: true,
          repositoryRun: { select: { reviewedSha: true, validationOutcome: true } },
        },
      },
    },
  });
  if (!epic || epic.status !== "Review" || epic.completionReviewStatus !== "Pending") return false;

  const reviewer = await resolveCompletionReviewer(epic);
  if (!reviewer.slug) {
    await db.epic.update({
      where: { id: epic.id },
      data: {
        completionReviewStatus: "Operational Error",
        completionReviewLastError: "No active Deploy Reviewer or unique Monitor Agent is available.",
      },
    });
    await db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: args.actorId,
        kind: "epic.completion_review.dispatch_skipped",
        payload: JSON.stringify({ epicId: epic.id, reason: "no_active_deploy_reviewer_or_unique_monitor" }),
      },
    });
    return false;
  }

  const branchName = effectiveEpicBranchName(epic);
  const commitPrefix = effectiveCommitPrefix({ commitPrefix: epic.commitPrefix, workItemKey: epic.workItemKey });
  const taskManifest = epic.tasks.map((task) => [
    `- ${task.workItemKey ? `${task.workItemKey} ` : ""}${task.title} (${task.id})`,
    `  status=${task.status}; reviewed candidate=${task.repositoryRun?.reviewedSha ?? "non-repository"}; validation=${task.repositoryRun?.validationOutcome ?? "not applicable"}`,
  ].join("\n"));
  const body = [
    `PM whole-Epic acceptance-review request for @${reviewer.slug}:`,
    "",
    `Epic: ${epic.workItemKey ? `${epic.workItemKey} ` : ""}${epic.title}`,
    `Repository: ${epic.project.repositoryPath ?? "(not configured)"}`,
    `Frozen candidate: ${epic.completionReviewCandidateSha ?? "non-repository Epic"}`,
    `Epic branch: ${branchName ?? "(not configured)"}`,
    `Commit prefix: ${commitPrefix ?? "(not configured)"}`,
    "",
    "Child-task evidence manifest:",
    ...taskManifest,
    "",
    "Perform the acceptance review of the COMBINED Epic, not another isolated task review. Read the original Epic request and attachments, then inspect each child task's outcome and material review feedback. Inspect the frozen combined diff and repository/worktree state. Run the repository's complete required regression gate plus any end-to-end scenario necessary to prove the Epic request.",
    "",
    "Resolve the review through the Epic workflow endpoint with one structured report:",
    "- `completion_review_approve` only when every original requirement is Pass and every combined validation check is Pass.",
    "- `completion_review_reject` when any requirement is Partial/Fail, any validation fails, the candidate is unsafe, or evidence is missing. Include the offending taskId when one existing task owns the repair; otherwise PM creates a focused repair task.",
    "- Include report.summary, report.requirements[], report.tests[], and report.residualRisks. Do not post an acknowledgement-only or raw tool-output comment.",
    "The candidate SHA is immutable: PM re-verifies origin and all reviewed child candidates after approval, before allowing Done and cleanup.",
  ].join("\n");
  const actor = await db.user.findUnique({
    where: { id: args.actorId },
    select: { id: true, username: true, kind: true },
  });
  if (!actor || (actor.kind !== "human" && actor.kind !== "agent")) {
    await db.epic.update({
      where: { id: epic.id },
      data: {
        completionReviewStatus: "Operational Error",
        completionReviewLastError: "The acceptance-review dispatch actor is no longer active.",
      },
    });
    return false;
  }
  const delivery = await sendEpicWorkflowNotification({
    epicId: epic.id,
    targetAgentSlug: reviewer.slug,
    actor: { id: actor.id, username: actor.username, kind: actor.kind },
    reason: "completion_review_required",
    body,
    linkedTasks: epic.tasks.map((task) => ({
      id: task.id,
      label: `${task.workItemKey ? `${task.workItemKey} ` : ""}${task.title}`,
    })),
  });
  await db.activityLog.create({
    data: {
      projectId: epic.projectId,
      userId: args.actorId,
      kind: "epic.completion_review.dispatch",
      targetAgent: reviewer.slug,
      payload: JSON.stringify({
        epicId: epic.id,
        reviewer: reviewer.slug,
        fallback: reviewer.fallback,
        candidateSha: epic.completionReviewCandidateSha,
        delivered: delivery.ok,
      }),
    },
  });
  if (!delivery.ok) {
    await db.epic.update({
      where: { id: epic.id },
      data: {
        completionReviewStatus: "Operational Error",
        completionReviewLastError: `Reviewer dispatch failed: ${delivery.delivery?.error ?? delivery.delivery?.status ?? "unknown delivery error"}`.slice(0, 4000),
      },
    });
  }
  return delivery.ok;
}
