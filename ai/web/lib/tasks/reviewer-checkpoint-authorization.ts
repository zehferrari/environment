import type { Prisma } from "@prisma/client";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { activeFormalBlockersByTask, blockerPermissionGrantForComment } from "@/lib/tasks/formal-blocker";
import { permissionRequiresOwner } from "@/lib/tasks/permission-review";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";

/** Rechecked at admission AND runner execution. Agent prose alone is never a grant. */
export async function isReviewerCheckpointAuthorization(client: Prisma.TransactionClient, taskId: string, commentId: string): Promise<boolean> {
  const task = await client.task.findUnique({ where: { id: taskId }, select: {
    id: true, assigneeId: true, actingManagerId: true, reporterId: true, approvedOn: true, status: true,
    activeWorkflowCycleId: true, workItemKey: true, branchName: true,
    project: { select: { deploymentProductionBranch: true } },
    actionPlan: { select: { id: true, version: true, status: true } },
    epic: { select: { status: true, actingManagerId: true, workItemKey: true, branchName: true } },
  } });
  if (!task || task.status !== "In Progress" || !task.approvedOn || task.actionPlan?.status !== "approved") return false;
  const reviewerId = resolveReviewOwnerId({ actingManagerId: task.actingManagerId, reporterId: task.reporterId, epic: task.epic });
  if (!reviewerId || reviewerId === task.assigneeId) return false;
  const authorization = await client.comment.findFirst({ where: { id: commentId, taskId, deletedAt: null }, select: { userId: true, createdAt: true, user: { select: { status: true } } } });
  if (!authorization || authorization.userId !== reviewerId || authorization.user.status !== "active" || authorization.createdAt < task.approvedOn) return false;
  const rows = await client.activityLog.findMany({ where: { taskId, kind: { in: ["task.blocker", "task.extra_work.blocker", "task.blocker.cleared", "task.blocker.permission.granted", "task.blocker.permission.reviewed"] } }, orderBy: { createdAt: "desc" } });
  const active = activeFormalBlockersByTask(rows).get(taskId);
  if (!active?.commentId || active.permissionRequest?.kind !== "publish_checkpoint" || permissionRequiresOwner(active.permissionRequest.context)) return false;
  if (active.permissionRequest.taskBranch !== effectiveTaskBranchName(task) || (active.permissionRequest.epicBranch ?? null) !== (task.epic ? effectiveEpicBranchName(task.epic) : null)) return false;
  if (["main", "master", task.project.deploymentProductionBranch].includes(active.permissionRequest.epicBranch ?? active.permissionRequest.taskBranch ?? "")) return false;
  if (!await client.comment.findFirst({ where: { id: active.commentId, taskId, deletedAt: null }, select: { id: true } })) return false;
  if (blockerPermissionGrantForComment(rows, active.commentId)?.authorizationCommentId !== commentId) return false;
  return rows.some(row => {
    if (row.kind !== "task.blocker.permission.reviewed" || row.userId !== reviewerId) return false;
    try {
      const p = JSON.parse(row.payload ?? "{}");
      return p.decision === "approve" && p.blockerCommentId === active.commentId && p.authorizationCommentId === commentId
        && p.actionPlanId === task.actionPlan!.id && p.actionPlanVersion === task.actionPlan!.version
        && p.cycleId === task.activeWorkflowCycleId && p.assigneeId === task.assigneeId;
    } catch { return false; }
  });
}
