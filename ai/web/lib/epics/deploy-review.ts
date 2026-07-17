import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { generateClientMessageId } from "@/lib/agents/ops/client-message-id";
import { effectiveEpicBranchName } from "@/lib/work-items/branches";
import { effectiveCommitPrefix } from "@/lib/work-items/keys";

export const DEFAULT_DEPLOY_REVIEW_PROMPT = "Give me a summary of the changes done in the source code (including details of the local and origin branches) plus a report confirming each request of the Epic has been properly addressed and the changes pose no harm to the system in terms of security and data integrity.";

export function cleanDeployReviewPrompt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function normalizeDeployReviewPrompt(value: unknown): string {
  return cleanDeployReviewPrompt(value) ?? DEFAULT_DEPLOY_REVIEW_PROMPT;
}

type Tx = Prisma.TransactionClient;

async function archiveActiveEpicActionPlan(tx: Tx, args: {
  projectId: string;
  epicId: string;
  actorId: string;
  now: Date;
}) {
  const scopeWhere = {
    projectId: args.projectId,
    taskId: null,
    epicId: args.epicId,
    agentSlug: "room",
    archiveId: null,
  } as const;
  const messages = await tx.agentChatMessage.findMany({
    where: scopeWhere,
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, baseArchiveId: true },
  });
  if (messages.length === 0) return null;

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const parentArchiveId = messages.find((m) => m.baseArchiveId)?.baseArchiveId ?? null;
  const archive = await tx.agentChatRoomArchive.create({
    data: {
      projectId: args.projectId,
      taskId: null,
      epicId: args.epicId,
      archivedById: args.actorId,
      parentArchiveId,
      summary: "Action Plan before deploy review",
      startedAt: first.createdAt,
      endedAt: last.createdAt,
      messageCount: messages.length,
    },
    select: { id: true },
  });
  await tx.agentChatMessage.updateMany({
    where: scopeWhere,
    data: { archiveId: archive.id },
  });
  await tx.activityLog.create({
    data: {
      projectId: args.projectId,
      userId: args.actorId,
      kind: "epic.chat.archive",
      payload: JSON.stringify({
        archiveId: archive.id,
        parentArchiveId,
        messageCount: messages.length,
        summary: "Action Plan before deploy review",
        reason: "ready_to_deploy",
      }),
    },
  });
  return archive.id;
}

export async function resetEpicActionPlanForDeployReview(tx: Tx, args: {
  projectId: string;
  epicId: string;
  actorId: string;
  now: Date;
}) {
  await archiveActiveEpicActionPlan(tx, args);
  await tx.epic.update({
    where: { id: args.epicId },
    data: { approvedOn: null, approvedById: null },
  });
  await tx.activityLog.create({
    data: {
      projectId: args.projectId,
      userId: args.actorId,
      kind: "epic.action_plan.reset",
      payload: JSON.stringify({ epicId: args.epicId, reason: "ready_to_deploy" }),
    },
  });
}

async function resolveMonitorAgentSlug() {
  const monitor = await db.agent.findFirst({
    where: { role: "monitor", deactivatedAt: null, user: { is: { status: "active" } } },
    orderBy: { createdAt: "asc" },
    select: { slug: true },
  });
  return monitor?.slug ?? null;
}

export function resolveDeployReviewPromptValue(projectPrompt: unknown, systemPrompt: unknown) {
  return cleanDeployReviewPrompt(projectPrompt)
    ?? cleanDeployReviewPrompt(systemPrompt)
    ?? DEFAULT_DEPLOY_REVIEW_PROMPT;
}

export function selectDeployReviewerSlug(reviewerSlug: string | null | undefined, monitorSlug: string | null | undefined) {
  return reviewerSlug ?? monitorSlug ?? null;
}

export async function resolveDeployReviewPrompt(projectId: string) {
  const [project, system] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { deployReviewPrompt: true } }),
    db.systemSettings.findUnique({ where: { id: "system" }, select: { deployReviewPrompt: true } }),
  ]);
  return resolveDeployReviewPromptValue(project?.deployReviewPrompt, system?.deployReviewPrompt);
}

export async function triggerDeployReview(args: {
  projectSlug: string;
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
      branchName: true,
      commitPrefix: true,
      projectId: true,
      project: { select: { slug: true, repositoryPath: true } },
      deployReviewer: { select: { agent: { select: { slug: true, deactivatedAt: true } }, status: true } },
    },
  });
  if (!epic || epic.project.slug !== args.projectSlug) return;

  const reviewerSlug = epic.deployReviewer?.status === "active" && !epic.deployReviewer.agent?.deactivatedAt
    ? epic.deployReviewer.agent?.slug ?? null
    : null;
  const targetSlug = selectDeployReviewerSlug(reviewerSlug, await resolveMonitorAgentSlug());
  if (!targetSlug) {
    await db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: args.actorId,
        kind: "epic.deploy_review.dispatch_skipped",
        targetAgent: null,
        payload: JSON.stringify({ epicId: epic.id, reason: "no_deploy_reviewer_or_monitor" }),
      },
    });
    return;
  }

  const prompt = await resolveDeployReviewPrompt(epic.projectId);
  const branchName = effectiveEpicBranchName(epic);
  const commitPrefix = effectiveCommitPrefix({
    commitPrefix: epic.commitPrefix,
    workItemKey: epic.workItemKey,
  });
  const notify = new FormData();
  notify.set("messageId", generateClientMessageId());
  notify.set("projectSlug", args.projectSlug);
  notify.set("epicId", epic.id);
  notify.set("discussionTarget", `agent:${targetSlug}`);
  notify.set("body", [
    `PM deploy-review request for @${targetSlug}:`,
    "",
    `Epic: ${epic.workItemKey ? `${epic.workItemKey} ` : ""}${epic.title}`,
    `Repository: ${epic.project.repositoryPath ?? "(not configured)"}`,
    `Epic branch: ${branchName ?? "(not configured)"}`,
    `Commit prefix: ${commitPrefix ?? "(not configured)"}`,
    "",
    "Deploy-review prompt:",
    prompt,
    "",
    "Inspect the current local worktree/branch and origin branch state for this Epic, then report in the Epic Action Plan whether every Epic request is addressed and whether the changes introduce security or data-integrity risk. Do not post an acknowledgement-only response.",
  ].join("\n"));

  const { sendAgentChatMessage } = await import("@/lib/agents/chat/actions");
  await sendAgentChatMessage(notify);
  await db.activityLog.create({
    data: {
      projectId: epic.projectId,
      userId: args.actorId,
      kind: "epic.deploy_review.dispatch",
      targetAgent: targetSlug,
      payload: JSON.stringify({ epicId: epic.id, reviewer: targetSlug, fallback: reviewerSlug ? false : true }),
    },
  });
}
