export const repositoryFinalizationFenceSelect = {
  phase: true,
  repoTouched: true,
  baseSha: true,
  candidateSha: true,
  reviewedSha: true,
} as const;

export type RepositoryFinalizationFence = {
  phase: string;
  repoTouched: boolean | null;
  baseSha: string | null;
  candidateSha: string | null;
  reviewedSha: string | null;
} | null | undefined;

const ACCEPTED_FINALIZATION_PHASES = new Set([
  "finalizing",
  "operational_error",
  "completed",
]);

/**
 * True once a reviewer has accepted one immutable repository candidate.
 *
 * `reviewedSha` is the durable acceptance marker. It deliberately survives an
 * operational finalization failure, while ordinary review feedback clears it.
 * Board adapters, agent workflow routes, and recovery nudges must all respect
 * this fence: cleanup trouble is not new implementation feedback.
 */
export function repositoryFinalizationOwnsTask(
  repository: RepositoryFinalizationFence,
): boolean {
  if (!repository || !ACCEPTED_FINALIZATION_PHASES.has(repository.phase)) {
    return false;
  }
  const acceptedCandidate = repository.repoTouched === true
    ? repository.candidateSha
    : repository.baseSha;
  return Boolean(
    acceptedCandidate && repository.reviewedSha === acceptedCandidate,
  );
}

export const REPOSITORY_FINALIZATION_FENCE_MESSAGE =
  "Review is already accepted and repository finalization owns this task. Fix any reported operational problem, then retry review_done for the same immutable candidate; do not reopen implementation or resubmit the branch.";

/** A finalization retry reuses the accepted lease; it is not a new review. */
export function canRetryAcceptedRepositoryReview(state: {
  status: string;
  repositoryRun?: RepositoryFinalizationFence;
  activeReviewRun?: { status: string; candidateSha: string } | null;
}): boolean {
  return state.status === "Review"
    && state.repositoryRun?.phase === "operational_error"
    && repositoryFinalizationOwnsTask(state.repositoryRun)
    && state.activeReviewRun?.status === "accepted"
    && state.activeReviewRun.candidateSha === state.repositoryRun.reviewedSha;
}
