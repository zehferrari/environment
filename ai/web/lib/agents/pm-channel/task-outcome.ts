import { db } from "@/lib/db";
import { pmChannelRunTargetKey } from "./runs";
import type { PmChannelReplyTarget } from "./openclaw";

// Model completion and workflow completion are different facts. A planning
// notification needs a durable plan, not a prose reply saying tools are absent.
export async function flagMissingTaskPlanOutcome(target: PmChannelReplyTarget) {
  if (target.kind !== "task-chat" && target.kind !== "task-comment") return false;
  return db.$transaction(async (tx) => {
    const run = await tx.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      include: { jobs: { select: { payload: true }, take: 1 } },
    });
    if (!run || run.status !== "completed" || run.settledByAction || run.lastAction === "submit_plan") return false;
    let expectedAction: unknown;
    try {
      const payload = JSON.parse(run.jobs[0]?.payload ?? "{}");
      expectedAction = payload.expectedWorkflowAction;
    } catch { return false; }
    if (expectedAction !== "submit_plan") return false;
    const task = await tx.task.findUnique({
      where: { id: target.taskId },
      include: { assignee: { select: { agent: { select: { slug: true } } } }, actionPlan: { select: { updatedAt: true } } },
    });
    if (!task || task.deletedAt || task.archivedAt || task.approvedOn
      || !["Backlog", "To Do"].includes(task.status) || task.assignee?.agent?.slug !== target.agentSlug
      || (task.actionPlan && task.actionPlan.updatedAt >= run.createdAt)) return false;
    const message = "Planning turn ended without submitting an Action Plan. Check runtime/tool access or the agent's clarification before retrying; resetting the task will not repair the runtime.";
    const dedupeKey = `task-plan-outcome-missing:${run.id}`;
    if (await tx.activityLog.findUnique({ where: { dedupeKey } })) return false;
    await tx.activityLog.create({ data: {
      taskId: task.id, projectId: task.projectId, targetAgent: target.agentSlug,
      kind: "task.workflow.outcome_missing", dedupeKey,
      payload: JSON.stringify({ runId: run.id, expectedAction: "submit_plan", message }),
    } });
    await tx.pmChannelRun.update({ where: { id: run.id }, data: {
      completionAnomaly: message, completionAnomalyAt: new Date(), disposition: "failed",
    } });
    await tx.task.update({ where: { id: task.id }, data: { alertReporter: true } });
    return true;
  });
}
