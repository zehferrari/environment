import { db } from "@/lib/db";
import { activeFormalBlockersByTask, blockerPermissionGrantForComment } from "@/lib/tasks/formal-blocker";
import { permissionReviewForComment } from "@/lib/tasks/permission-review";

export async function readTaskBlockerState(taskId: string) {
  const rows = await db.activityLog.findMany({ where: { taskId, kind: { in: [
    "task.blocker", "task.extra_work.blocker", "task.blocker.cleared", "task.blocker.permission.granted", "task.blocker.permission.reviewed",
  ] } }, orderBy: { createdAt: "desc" }, select: { taskId: true, kind: true, payload: true, createdAt: true } });
  const active = activeFormalBlockersByTask(rows).get(taskId);
  if (!active?.commentId) return null;
  return { ...active, review: permissionReviewForComment(rows, active.commentId), grant: blockerPermissionGrantForComment(rows, active.commentId) };
}

export async function readTaskPermissionState(taskId: string) {
  const active = await readTaskBlockerState(taskId);
  return active?.permissionRequest ? active : null;
}
