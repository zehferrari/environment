// Approving an epic's Action Plan is the "approved to execute" signal — it
// promotes a Backlog epic to To Do (mirroring how a Task's approved plan lands
// it in To Do). The epic only flips to In Progress once a child task actually
// starts (see promoteEpicOnTaskInProgress).
export const EPIC_ACTION_PLAN_APPROVED_STATUS = "To Do";

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
    promoted: shouldPromote,
  };
}
