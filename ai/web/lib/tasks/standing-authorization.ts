import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { parseDevPublicationConfig, devConfigFingerprint } from "@/lib/projects/dev-publication-config";
import { effectiveTaskBranchName, effectiveEpicBranchName } from "@/lib/work-items/branches";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";

const taskSelection = {
  id: true, projectId: true, description: true, status: true, approvedOn: true, assigneeId: true, actingManagerId: true, reporterId: true,
  activeWorkflowCycleId: true, workItemKey: true, branchName: true,
  actionPlan: { select: { id: true, version: true, status: true, contentHash: true, delegatedApproverId: true, delegatedById: true } },
  epic: { select: { status: true, actingManagerId: true, workItemKey: true, branchName: true } },
  project: { select: { repositoryPath: true, devPublicationPolicy: true, devPublicationConfig: true, deploymentProductionBranch: true, agentChangeBlockedBranches: true, onlyReportersCanApproveActionPlans: true, onlyReportersCanSetTasksDone: true } },
} as const;

export function standingScopeFingerprint(contentHash: string | null, description: string | null): string {
  return createHash("sha256").update(JSON.stringify([contentHash, description])).digest("hex");
}

/** Called in the approval transaction, never lazily for historical approved plans. */
export async function createStandingAuthorizationForApprovedPlan(tx: Prisma.TransactionClient, args: { taskId: string; approvedById: string }) {
  const task = await tx.task.findUnique({ where: { id: args.taskId }, select: taskSelection });
  if (!task || task.project.devPublicationPolicy !== "standing") return null;
  const config = parseDevPublicationConfig(task.project.devPublicationConfig);
  if (!config || !task.assigneeId || !task.actionPlan || task.actionPlan.status !== "approved" || !task.approvedOn) return null;
  const branch = task.epic ? effectiveEpicBranchName(task.epic) : effectiveTaskBranchName(task);
  if (!branch || ["main", "master", task.project.deploymentProductionBranch].includes(branch) || isProtectedBranch(task.project.agentChangeBlockedBranches, branch)) return null;
  if (task.project.repositoryPath !== config.repositoryPath) return null;
  const fingerprint = devConfigFingerprint(config);
  const existing = await tx.taskStandingAuthorization.findFirst({ where: { taskId: task.id, actionPlanId: task.actionPlan.id, actionPlanVersion: task.actionPlan.version, configFingerprint: fingerprint, status: "active" } });
  if (existing) return existing;
  return tx.taskStandingAuthorization.create({ data: {
    taskId: task.id, actionPlanId: task.actionPlan.id, actionPlanVersion: task.actionPlan.version,
    workflowCycleId: task.activeWorkflowCycleId, assigneeId: task.assigneeId, reviewerId: resolveReviewOwnerId(task), grantedById: args.approvedById,
    repositoryPath: config.repositoryPath, branch, configFingerprint: fingerprint,
    scopeFingerprint: standingScopeFingerprint(task.actionPlan.contentHash, task.description),
    allowedOperations: JSON.stringify(config.allowedOperations), target: config.target, environmentId: config.environmentId,
  } });
}

/** Recheck current authority at admission and immediately before runner effects. */
export async function validateStandingAuthorization(client: Prisma.TransactionClient, args: { taskId: string; grantId: string; assigneeId?: string }) {
  const task = await client.task.findUnique({ where: { id: args.taskId }, select: taskSelection });
  const grant = await client.taskStandingAuthorization.findUnique({ where: { id: args.grantId } });
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!task || !grant || grant.taskId !== task.id || grant.status !== "active" || grant.revokedAt) return fail("Standing publication authorization is missing or revoked.");
  if (task.project.devPublicationPolicy !== "standing" || !task.approvedOn || task.actionPlan?.status !== "approved") return fail("The task plan or standing publication policy is no longer approved.");
  if (grant.actionPlanId !== task.actionPlan.id || grant.actionPlanVersion !== task.actionPlan.version || grant.scopeFingerprint !== standingScopeFingerprint(task.actionPlan.contentHash, task.description)) return fail("The approved plan or task scope changed; a fresh approval is required.");
  if (grant.assigneeId !== task.assigneeId || args.assigneeId && args.assigneeId !== task.assigneeId || grant.reviewerId !== resolveReviewOwnerId(task)) return fail("The task's assignee or reviewer changed; reauthorize publication.");
  const principal = await client.user.findUnique({ where: { id: grant.grantedById }, select: { status: true } });
  if (principal?.status !== "active") return fail("The authorizing principal is no longer active.");
  const config = parseDevPublicationConfig(task.project.devPublicationConfig);
  const branch = task.epic ? effectiveEpicBranchName(task.epic) : effectiveTaskBranchName(task);
  if (!config || devConfigFingerprint(config) !== grant.configFingerprint || config.repositoryPath !== task.project.repositoryPath || grant.repositoryPath !== config.repositoryPath || branch !== grant.branch || grant.target !== config.target || grant.environmentId !== config.environmentId) return fail("The repository, target or deployment configuration changed; reauthorize publication.");
  if (["main", "master", task.project.deploymentProductionBranch].includes(branch) || isProtectedBranch(task.project.agentChangeBlockedBranches, branch)) return fail("Standing authorization cannot publish a production or protected branch.");
  return { ok: true as const, grant, config };
}
