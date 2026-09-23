import { isProtectedBranch } from "@/lib/projects/protected-branches";
import type { IntentExecutor } from "./types";
import { permissionRequiresOwner } from "@/lib/tasks/permission-review";
import { effectiveTaskBranchName, effectiveEpicBranchName } from "@/lib/work-items/branches";
import { blockerPermissionGrantActivityId } from "@/lib/tasks/blocker-permission-grant";

export const reviewPermissionExecutor: IntentExecutor<"review_permission"> = async (context) => {
  const { tx, state, command, decision } = context;
  const review = command.payload;
  const blocker = state.activeBlocker;
  const request = blocker?.permissionRequest;
  const plan = state.actionPlan;
  if (!blocker || blocker.commentId !== review.blockerCommentId || !request || blocker.permissionGrant || blocker.override
    || !plan || plan.status !== "approved" || plan.id !== review.actionPlanId || plan.version !== review.actionPlanVersion) {
    return { status: "stale", reason: "Refresh the active permission request and approved plan before deciding.", domainCode: "cycle_mismatch" };
  }
  const existing = await tx.activityLog.findUnique({ where: { id: `permission-review-${review.blockerCommentId}` } });
  if (existing) return { status: "stale", reason: "This request already has a reviewer decision.", domainCode: "cycle_mismatch" };
  const source = await tx.comment.findFirst({ where: { id: review.blockerCommentId, taskId: state.id, deletedAt: null } });
  if (!source) return { status: "stale", reason: "The permission request was deleted.", domainCode: "cycle_mismatch" };
  if (review.decision === "approve" && (permissionRequiresOwner(request.context)
    || !review.planStepIds.length || review.planStepIds.some(id => !plan.steps.some(step => step.stepId === id)))) {
    return { status: "forbidden", reason: "Approval requires a named non-production target, no scope/destructive/security change, and matching approved plan steps. Escalate to the reporter otherwise.", domainCode: "not_authorized" };
  }
  const task = await tx.task.findUniqueOrThrow({ where: { id: state.id }, select: {
    workItemKey: true, branchName: true, assignee: { select: { username: true } },
    project: { select: { deploymentProductionBranch: true, agentChangeBlockedBranches: true } },
    epic: { select: { workItemKey: true, branchName: true } },
  } });
  const taskBranch = effectiveTaskBranchName(task);
  const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
  if (review.decision === "approve" && request.kind === "publish_checkpoint" && (
    request.taskBranch !== taskBranch || (request.epicBranch ?? null) !== epicBranch
    || ["main", "master", task.project.deploymentProductionBranch].includes(epicBranch ?? taskBranch)
    || isProtectedBranch(task.project.agentChangeBlockedBranches, epicBranch ?? taskBranch)
  )) return { status: "forbidden", reason: "The publication target changed or is a production branch; owner review is required.", domainCode: "not_authorized" };
  const body = review.decision === "approve" ? [
    `@${task.assignee?.username} As the assigned reviewer, I authorize ${request.kind === "publish_checkpoint" ? `PM to publish the current checkpoint for ${task.workItemKey} / ${taskBranch} to ${epicBranch ?? taskBranch}` : "this exact action"}: ${request.scope}`,
    `Target: ${request.context!.environment} — ${request.context!.target}. Approved plan v${plan.version}, steps ${review.planStepIds.join(", ")}.`,
    `Scope assessment: ${review.rationale}`,
    `This single-request grant answers ${review.blockerCommentId}. Production, scope changes and unrelated operations remain excluded. Publication alone does not deploy anything.`,
  ].join("\n\n") : `Permission ${review.decision === "decline" ? "declined" : "escalated to reporter"}: ${request.scope}\n\n${review.rationale}`;
  const comment = await tx.comment.create({ data: { taskId: state.id, userId: command.actor.id, body,
    authorAgentSlug: command.actor.kind === "agent" ? command.actor.username : null,
    commentKind: "blocker_notice", runId: command.executionContext?.pmChannelRunId ?? null }, select: { id: true } });
  const authorizationCommentId = review.decision === "approve" ? comment.id : null;
  await tx.activityLog.create({ data: { id: `permission-review-${review.blockerCommentId}`, taskId: state.id, projectId: state.projectId, userId: command.actor.id,
    kind: "task.blocker.permission.reviewed", payload: JSON.stringify({ ...review, authorizationCommentId, cycleId: state.activeCycle?.id, assigneeId: state.assigneeId, permissionScope: request.scope, permissionContext: request.context }) } });
  if (authorizationCommentId) await tx.activityLog.create({ data: { id: blockerPermissionGrantActivityId(review.blockerCommentId), taskId: state.id, projectId: state.projectId, userId: command.actor.id,
    kind: "task.blocker.permission.granted", payload: JSON.stringify({ blockerCommentId: review.blockerCommentId, authorizationCommentId, permissionKind: request.kind, permissionScope: request.scope, authority: "reviewer" }) } });
  const cleared = review.decision === "decline" || (review.decision === "approve" && request.kind !== "publish_checkpoint");
  if (cleared) await tx.activityLog.create({ data: { taskId: state.id, projectId: state.projectId, userId: command.actor.id, kind: "task.blocker.cleared",
    payload: JSON.stringify({ blockerCommentId: review.blockerCommentId, action: `permission_${review.decision}`, authorizationCommentId }) } });
  await tx.task.update({ where: { id: state.id }, data: { alertReporter: review.decision === "escalate" } });
  const targetUserId = review.decision === "escalate" ? state.reporterId : state.assigneeId;
  if (targetUserId) decision.effects.push({ type: "task_notification", key: `permission-decision:${review.blockerCommentId}`, payload: {
    taskId: state.id, targetUserId, actor: command.actor, reason: "blocker_response",
    body: `${body}\n\n${authorizationCommentId ? `PM recorded authorizationCommentId=${authorizationCommentId}. ${cleared ? "The permission blocker is cleared; resume the authorized work." : "Use publish_checkpoint with this exact id, then verify the configured deployment separately."}` : review.decision === "decline" ? "No permission was granted. The request is closed. Use the reviewer feedback to choose an authorized approach or propose a plan revision." : "The reviewer cannot authorize this request. An explicit reporter/owner decision is required."}`,
  } });
  return context.helpers.executeDecisionWrites();
};
