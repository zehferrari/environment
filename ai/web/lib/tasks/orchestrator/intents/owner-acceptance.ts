import type { Prisma } from "@prisma/client";
import { createProcedureRun } from "@/lib/tasks/orchestrator/procedure-runner";
import { acceptanceChecklistSnapshot } from "@/lib/tasks/acceptance";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";

/** Called inside the checkbox mutation transaction. This resumes the real
 * recorded reviewer decision; the owner is audited only as evidence author. */
export async function resumeReviewAfterOwnerAcceptance(tx: Prisma.TransactionClient, args: { taskId: string; actorUserId: string }) {
  const task = await tx.task.findUnique({ where: { id: args.taskId }, select: {
    status: true, deletedAt: true, projectId: true, activeWorkflowCycleId: true,
    repositoryRun: { select: { candidateSha: true, baseSha: true, repoTouched: true } },
  } });
  if (!task || task.deletedAt || task.status !== "Review" || !task.activeWorkflowCycleId) return;
  const review = await tx.reviewRun.findUnique({ where: { workflowCycleId: task.activeWorkflowCycleId } });
  if (!review || review.status !== "accepted_pending_owner" || !review.reviewerId) return;
  const snapshot = await acceptanceChecklistSnapshot(tx, args.taskId);
  const cycle = await tx.taskWorkflowCycle.findUnique({ where: { id: task.activeWorkflowCycleId }, select: { candidateSha: true } });
  const currentCandidate = task.repositoryRun
    ? (task.repositoryRun.repoTouched ? task.repositoryRun.candidateSha : task.repositoryRun.baseSha)
    : cycle?.candidateSha;
  if (review.acceptancePlanVersion !== snapshot.planVersion || review.acceptanceChecklistHash !== snapshot.checklistHash ||
      (currentCandidate && currentCandidate !== review.candidateSha)) {
    const reason = review.acceptancePlanVersion !== snapshot.planVersion ? "approved_plan_changed"
      : review.acceptanceChecklistHash !== snapshot.checklistHash ? "acceptance_criteria_changed" : "review_candidate_changed";
    const dedupeKey = `owner-acceptance-stale:${review.id}:${snapshot.checklistHash}:${currentCandidate ?? "none"}`;
    await tx.activityLog.upsert({ where: { dedupeKey }, update: {}, create: {
      projectId: task.projectId, taskId: args.taskId, userId: args.actorUserId,
      kind: "task.review.acceptance_stale", dedupeKey,
      payload: JSON.stringify({ reason, reviewRunId: review.id, reviewerId: review.reviewerId,
        acceptedCandidate: review.candidateSha, currentCandidate, ...snapshot }),
    } });
    await tx.task.update({ where: { id: args.taskId }, data: { alertReporter: true } });
    await enqueueWorkflowEffects(tx, { taskId: args.taskId, projectId: task.projectId,
      aggregateVersion: 0, workflowCycleId: task.activeWorkflowCycleId,
      effects: [{ type: "task_notification", key: dedupeKey, payload: {
        taskId: args.taskId, targetUserId: args.actorUserId, actor: { id: args.actorUserId, kind: "human" },
        reason: "owner_acceptance_required",
        body: `Owner evidence was saved, but the earlier reviewer verdict cannot be reused (${reason}). Request an Action Plan revision or reviewer feedback for the changed work; PM has not finalized this candidate.`,
      } }],
    });
    return;
  }
  const pending = await tx.subTask.count({ where: {
    taskId: args.taskId, kind: { not: "superseded" }, acceptanceGate: "task", completedAt: null,
  } });
  if (pending || await tx.reviewFinding.count({ where: { taskId: args.taskId, status: "open" } })) return;
  const claimed = await tx.reviewRun.updateMany({ where: { id: review.id, status: "accepted_pending_owner" }, data: { status: "accepted" } });
  if (!claimed.count) return;
  const procedure = await createProcedureRun(tx, {
    taskId: args.taskId, workflowCycleId: task.activeWorkflowCycleId,
    triggerTransitionId: `owner-acceptance:${review.id}`, type: "finalize_accepted_review",
    input: { reviewRunId: review.id, candidateSha: review.candidateSha },
  });
  await tx.activityLog.create({ data: {
    projectId: task.projectId, taskId: args.taskId, userId: args.actorUserId,
    kind: "task.review.owner_acceptance_completed", dedupeKey: `owner-acceptance:${review.id}`,
    payload: JSON.stringify({ reviewRunId: review.id, reviewerId: review.reviewerId,
      evidenceActorId: args.actorUserId, candidateSha: review.candidateSha, ...snapshot, procedureRunId: procedure.procedureRunId }),
  } });
}
