export const EPIC_ACTION_PLAN_APPROVED_STATUS = "In Progress";

export function shouldPromoteEpicOnActionPlanApproval(status: string | null | undefined) {
  return status === "Backlog";
}

export function buildEpicActionPlanApprovalUpdate(args: {
  currentStatus: string | null | undefined;
  approvedAt: Date;
  actorId: string;
}) {
  const shouldPromote = shouldPromoteEpicOnActionPlanApproval(args.currentStatus);
  return {
    data: {
      approvedOn: args.approvedAt,
      approvedById: args.actorId,
      ...(shouldPromote
        ? {
            status: EPIC_ACTION_PLAN_APPROVED_STATUS,
            statusChangedAt: args.approvedAt,
          }
        : {}),
    },
    promotedToInProgress: shouldPromote,
  };
}
