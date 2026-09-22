import { db } from "@/lib/db";
import { canApproveActionPlanForActor, canSetTaskDoneForActor, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import type { SendPmChannelTurnArgs } from "./openclaw";

export type PmEffortPolicy = { mode: "normal" | "manager"; reason: "default" | "planning" | "review" | "manager" };
type TaskRoleState = Parameters<typeof resolveReviewOwnerId>[0] & { status: string; assigneeId: string | null; approvedOn: Date | null };

export function taskEffortPolicy(task: TaskRoleState, userId: string): PmEffortPolicy {
  if (["Backlog", "To Do"].includes(task.status) && !task.approvedOn) {
    if (task.assigneeId === userId) return { mode: "manager", reason: "planning" };
    if (canApproveActionPlanForActor(task, userId)) return { mode: "manager", reason: "review" };
  }
  if (task.assigneeId !== userId && task.status === "Review" && canSetTaskDoneForActor(task, userId)) return { mode: "manager", reason: "review" };
  if (task.assigneeId !== userId && resolveReviewOwnerId(task) === userId) return { mode: "manager", reason: "manager" };
  return { mode: "normal", reason: "default" };
}

/** Recompute at dispatch, including queued jobs; prose never assigns a role. */
export async function resolvePmEffortPolicy(args: SendPmChannelTurnArgs): Promise<PmEffortPolicy> {
  const normal: PmEffortPolicy = { mode: "normal", reason: "default" };
  const target = args.replyTarget;
  if (target.kind === "direct") return normal;
  const user = await db.user.findFirst({ where: { kind: "agent", status: "active", agent: { is: { slug: args.agentSlug, deactivatedAt: null } } }, select: { id: true } });
  if (!user) return normal;
  if (target.kind === "epic-chat") {
    const epic = await db.epic.findUnique({ where: { id: target.epicId }, select: { actingManagerId: true, reporterId: true } });
    return epic && (epic.actingManagerId ?? epic.reporterId) === user.id ? { mode: "manager", reason: "manager" } : normal;
  }
  const task = await db.task.findUnique({ where: { id: target.taskId }, select: {
    status: true, assigneeId: true, actingManagerId: true, reporterId: true, approvedOn: true,
    project: { select: { onlyReportersCanApproveActionPlans: true, onlyReportersCanSetTasksDone: true } },
    epic: { select: { status: true, actingManagerId: true, approvedOn: true } },
  } });
  return task ? taskEffortPolicy(task, user.id) : normal;
}
