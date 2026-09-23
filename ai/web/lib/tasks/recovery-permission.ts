import { db } from "@/lib/db";
import { isActiveOwnerPrincipal } from "@/lib/auth/roles";
import { activeFormalBlockerStatesByTask, formalBlockerNeedsExternalInput, type ActiveFormalBlockerState } from "@/lib/tasks/formal-blocker";
import { isReviewerCheckpointAuthorization } from "@/lib/tasks/reviewer-checkpoint-authorization";
import { activityPayloadUsesCheckpointAuthorization, validateCheckpointAuthorizationText } from "@/lib/deploy/checkpoint-authorization";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { ACTIVE_RUN_STATUSES } from "@/lib/workflow-invariants";

/** Shared monitor CLI boundary: recovery may not override an intentional wait
 * or race work already owned by the durable PM queue. */
export async function taskRecoveryWaitReason(taskId: string, agentSlug: string) {
  const task = await db.task.findUnique({ where: { id: taskId }, select: {
    status: true, deletedAt: true, activeWorkflowCycleId: true,
  } });
  if (!task || task.deletedAt || task.status === "Done" || task.status === "Backlog") return "task_not_actionable";
  if (task.status === "In Progress") {
    const permission = await recoveryPermissionWaitReason(taskId, await readRecoveryBlocker(taskId));
    if (permission) return permission;
  }
  if (task.status === "Review") {
    const review = await db.reviewRun.findFirst({ where: { taskId,
      ...(task.activeWorkflowCycleId ? { workflowCycleId: task.activeWorkflowCycleId } : {}) },
    orderBy: { createdAt: "desc" }, select: { status: true } });
    if (review?.status === "accepted_pending_owner") return "accepted_review_awaits_owner_evidence";
    if (review?.status === "accepted") return "accepted_review_finalization_owned";
  }
  if (await db.pmChannelRun.findFirst({ where: { taskId, agentSlug, status: { in: [...ACTIVE_RUN_STATUSES] } }, select: { id: true } })) return "task_has_active_turn";
  if (await db.pmChannelContinuation.findFirst({ where: { taskId, agentSlug, status: { in: ["armed", "queued", "dispatching"] } }, select: { id: true } })) return "task_has_durable_continuation";
  if (await db.taskProcedureRun.findFirst({ where: { taskId, status: { in: ["queued", "running"] } }, select: { id: true } })) return "task_has_active_procedure";
  return null;
}

export async function readRecoveryBlocker(taskId: string) {
  const rows = await db.activityLog.findMany({ where: { taskId, kind: { in: [
    "task.blocker", "task.extra_work.blocker", "task.blocker.cleared", "task.blocker.permission.granted",
  ] } }, orderBy: { createdAt: "desc" }, select: { taskId: true, kind: true, payload: true, createdAt: true } });
  return activeFormalBlockerStatesByTask(rows).get(taskId) ?? null;
}

/** Recovery never infers authority from an old "granted" activity alone.
 * Publication already admitted to the repository runner is its responsibility,
 * not a reason to wake the model and repeat a consumed capability. */
export async function recoveryPermissionWaitReason(taskId: string, blocker: ActiveFormalBlockerState | null): Promise<string | null> {
  if (!blocker) return null;
  if (formalBlockerNeedsExternalInput(blocker)) return "external_dependency";
  const authorizationCommentId = blocker.permissionGrant?.authorizationCommentId;
  if (!authorizationCommentId) return "external_dependency";
  const [task, authorization] = await Promise.all([
    db.task.findUnique({ where: { id: taskId }, select: {
      approvedOn: true, branchName: true, workItemKey: true,
      epic: { select: { branchName: true, workItemKey: true } },
    } }),
    db.comment.findUnique({ where: { id: authorizationCommentId }, select: {
      taskId: true, deletedAt: true, createdAt: true, body: true,
      user: { select: { kind: true, status: true, isOwner: true } },
    } }),
  ]);
  if (!task?.approvedOn || !authorization || authorization.taskId !== taskId || authorization.deletedAt
    || authorization.createdAt < task.approvedOn) return "permission_no_longer_valid";
  if (blocker.permissionRequest?.kind !== "publish_checkpoint") {
    return isActiveOwnerPrincipal(authorization.user) ? null : "permission_no_longer_valid";
  }
  const uses = await db.activityLog.findMany({ where: { taskId, kind: { in: [
    "task.repository.checkpoint.requested", "pm.repo.checkpoint.enqueue", "pm.repo.checkpoint.ok", "pm.repo.checkpoint.fail",
  ] } }, select: { payload: true } });
  if (uses.some(row => activityPayloadUsesCheckpointAuthorization(row.payload, authorizationCommentId))) {
    return "checkpoint_attempt_pending_settlement";
  }
  const taskBranch = effectiveTaskBranchName(task);
  if (!taskBranch) return "permission_no_longer_valid";
  if (isActiveOwnerPrincipal(authorization.user)) {
    return validateCheckpointAuthorizationText({ body: authorization.body, taskKey: task.workItemKey,
      taskBranch, epicBranch: task.epic ? effectiveEpicBranchName(task.epic) : null }).ok
      ? null : "permission_no_longer_valid";
  }
  return await db.$transaction(tx => isReviewerCheckpointAuthorization(tx, taskId, authorizationCommentId))
    ? null : "permission_no_longer_valid";
}
