import type { Prisma } from "@prisma/client";
import { createSubTaskItem } from "./subtasks";
import { parseReviewFindings, ReviewCorrectionError } from "./review-findings-input";
import type { ReviewFindingInput } from "./orchestrator/types";

/** Called only inside the review decision transaction; no partial checklist or wake. */
export async function createReviewFindingChecklist(tx: Prisma.TransactionClient, args: {
  taskId: string; reviewRunId: string; candidateSha: string; reviewerId: string; findings: ReviewFindingInput[];
}) {
  const parsed = parseReviewFindings(args.findings);
  if (!parsed.ok) throw new ReviewCorrectionError(parsed.message);
  const review = await tx.reviewRun.findFirst({ where: { id: args.reviewRunId, taskId: args.taskId, candidateSha: args.candidateSha } });
  if (!review) throw new ReviewCorrectionError("The review candidate changed; refresh before submitting findings.");
  const plan = await tx.actionPlan.findUnique({ where: { taskId: args.taskId }, select: { id: true, version: true } });
  for (const [position, input] of parsed.items.entries()) {
    const existing = await tx.reviewFinding.findUnique({ where: { reviewRunId_position: { reviewRunId: review.id, position } } });
    if (existing) throw new ReviewCorrectionError("Review findings already recorded; replay the original decision instead of replacing them.");
    const item = await createSubTaskItem({ taskId: args.taskId, text: input.title, groupKey: `feedback:${review.id}`, actorUserId: args.reviewerId, kind: "implementation", client: tx });
    if (!item?.created) throw new ReviewCorrectionError("Correction checklist item already exists; no partial review was saved.");
    await tx.reviewFinding.create({ data: {
      ...input, taskId: args.taskId, reviewRunId: review.id, position, candidateSha: review.candidateSha,
      reviewerId: args.reviewerId, subTaskId: item.id, actionPlanId: plan?.id, actionPlanVersion: plan?.version,
    } });
  }
}
