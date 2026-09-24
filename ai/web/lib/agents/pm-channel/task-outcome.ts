import { db } from "@/lib/db";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";
import { resolveReviewOwnerId, canApproveActionPlanForActor } from "@/lib/tasks/workflow-actors";
import { pmChannelRunTargetKey } from "./runs";
import type { PmChannelReplyTarget, SendPmChannelTurnArgs } from "./openclaw";

// Model completion and workflow completion are different facts. Silence is a
// valid transport outcome, but does not satisfy an outstanding workflow action.
export async function flagMissingTaskPlanOutcome(target: PmChannelReplyTarget) {
  if (target.kind !== "task-chat" && target.kind !== "task-comment") return false;
  return db.$transaction(async (tx) => {
    const run = await tx.pmChannelRun.findUnique({
      where: { targetKey: pmChannelRunTargetKey(target) },
      include: { jobs: { select: { payload: true }, take: 1 } },
    });
    if (!run || run.status !== "completed" || run.settledByAction) return false;
    let payload: SendPmChannelTurnArgs & { workflowReason?: string };
    try { payload = JSON.parse(run.jobs[0]?.payload ?? "{}"); } catch { return false; }
    // Older dispatched reviews have a reason but no explicit outcome contract.
    const expectedAction = payload.expectedWorkflowAction
      ?? (payload.workflowReason === "action_plan_review_requested" ? "review_plan" : null);
    if (expectedAction !== "submit_plan" && expectedAction !== "review_plan") return false;
    const task = await tx.task.findUnique({
      where: { id: target.taskId },
      include: {
        assignee: { select: { agent: { select: { slug: true } } } },
        actionPlan: true,
        epic: { select: { status: true, actingManagerId: true, approvedOn: true } },
        project: { select: { onlyReportersCanApproveActionPlans: true } },
      },
    });
    if (!task || task.deletedAt || task.archivedAt || task.approvedOn
      || !["Backlog", "To Do"].includes(task.status)) return false;
    let reviewerId: string | null = null;
    if (expectedAction === "submit_plan") {
      if (run.lastAction === "submit_plan" || task.assignee?.agent?.slug !== target.agentSlug
        || (task.actionPlan && task.actionPlan.updatedAt >= run.createdAt)) return false;
    } else {
      const plan = task.actionPlan;
      if (!plan || plan.status !== "draft" || plan.approvedOn
        || (plan.reviewedAt && !canApproveActionPlanForActor(task, plan.reviewedById ?? ""))) return false;
      if (payload.expectedActionPlan
        ? plan.id !== payload.expectedActionPlan.id || plan.version !== payload.expectedActionPlan.version
        : plan.updatedAt > run.createdAt) return false;
      reviewerId = resolveReviewOwnerId(task);
      const reviewer = reviewerId ? await tx.user.findUnique({
        where: { id: reviewerId }, select: { status: true, agent: { select: { slug: true, deactivatedAt: true } } },
      }) : null;
      if (!reviewer || reviewer.status !== "active" || reviewer.agent?.deactivatedAt
        || reviewer.agent?.slug !== target.agentSlug) return false;
      // A newer wake owns the decision now; never revive the old generation.
      if (await tx.pmChannelRun.findFirst({ where: {
        taskId: task.id, agentSlug: target.agentSlug, createdAt: { gt: run.createdAt },
      }, select: { id: true } })) return false;
    }
    const message = expectedAction === "review_plan"
      ? "Plan review ended without a decision. Approve the current plan, accept review if approval belongs to another actor, or request consolidated changes; silence is not a review decision."
      : "Planning turn ended without submitting an Action Plan. Check runtime/tool access or the agent's clarification before retrying; resetting the task will not repair the runtime.";
    const dedupeKey = `task-plan-outcome-missing:${run.id}`;
    if (await tx.activityLog.findUnique({ where: { dedupeKey } })) return false;
    // At most one recovery per plan revision and reviewer, across callback
    // replays and newly completed retry turns. The existing outbox owns delivery.
    let recoveryQueued = false;
    if (expectedAction === "review_plan" && reviewerId && task.actionPlan && payload.actor?.id) {
      const recoveryKey = `plan-review-recovery:${task.actionPlan.id}:${task.actionPlan.version}:${reviewerId}`;
      if (!await tx.workflowOutbox.findUnique({ where: { dedupeKey: `${task.id}:v0:${recoveryKey}` } })) {
        await enqueueWorkflowEffects(tx, {
          taskId: task.id, projectId: task.projectId, aggregateVersion: 0,
          effects: [{ type: "task_notification", key: recoveryKey,
            payload: { taskId: task.id, targetUserId: reviewerId, actor: payload.actor,
              reason: "action_plan_review_requested", body: message,
              expectedActionPlan: { id: task.actionPlan.id, version: task.actionPlan.version } },
          }],
        });
        recoveryQueued = true;
      }
    }
    await tx.activityLog.create({ data: {
      taskId: task.id, projectId: task.projectId, targetAgent: target.agentSlug,
      kind: "task.workflow.outcome_missing", dedupeKey,
      payload: JSON.stringify({ runId: run.id, expectedAction, message, recoveryQueued }),
    } });
    await tx.pmChannelRun.update({ where: { id: run.id }, data: {
      completionAnomaly: message, completionAnomalyAt: new Date(), disposition: "failed",
    } });
    if (!recoveryQueued) await tx.task.update({ where: { id: task.id }, data: { alertReporter: true } });
    return true;
  });
}
