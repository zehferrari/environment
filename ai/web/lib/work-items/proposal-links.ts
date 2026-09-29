export function proposalReviewPath(proposalId: string) {
  return `/proposals#proposal-${encodeURIComponent(proposalId)}`;
}
