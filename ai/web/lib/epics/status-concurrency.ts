export function epicStatusRevision(statusChangedAt: Date | null | undefined): string {
  return statusChangedAt?.toISOString() ?? "";
}

export function canApplySubmittedEpicStatus(args: {
  submittedRevision: string | null | undefined;
  currentStatusChangedAt: Date | null | undefined;
}): boolean {
  return (
    typeof args.submittedRevision === "string" &&
    args.submittedRevision === epicStatusRevision(args.currentStatusChangedAt)
  );
}
