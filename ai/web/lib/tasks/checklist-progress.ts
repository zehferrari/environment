/** Counts only the currently actionable round, never historical completed work. */
export function activeChecklistProgress(task: {
  checklist: Array<{ kind: string; groupKey: string; completedAt: Date | string | null; minutesSpent: number | null }>;
  reviewFindings: Array<{ reviewRunId: string }>;
  reviewRuns: Array<{ id: string }>;
}, hidden = false) {
  const feedback = task.reviewFindings[0]; // query sorts by source review, newest first
  const currentReview = task.reviewRuns[0];
  const implementation = task.checklist.filter(item => item.kind !== "review" && item.groupKey === (feedback ? `feedback:${feedback.reviewRunId}` : "initial"));
  const review = task.checklist.filter(item => item.kind === "review" && item.groupKey === (currentReview ? `review:${currentReview.id}` : "initial"));
  return {
    subtaskImplTotal: hidden ? 0 : implementation.length,
    subtaskImplDone: hidden ? 0 : implementation.filter(item => item.completedAt !== null).length,
    subtaskReviewTotal: hidden ? 0 : review.length,
    subtaskReviewDone: hidden ? 0 : review.filter(item => item.completedAt !== null).length,
  };
}

/** Shared query for project and both workspace boards. */
export const checklistProgressSelect = {
  checklist: { select: { completedAt: true, minutesSpent: true, kind: true, groupKey: true } },
  reviewFindings: { orderBy: { reviewRun: { createdAt: "desc" as const } }, take: 1, select: { reviewRunId: true } },
  reviewRuns: { orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }], take: 1, select: { id: true } },
};
