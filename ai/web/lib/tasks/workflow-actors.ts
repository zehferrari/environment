export type ReviewOwnerTask = {
  assigneeId?: string | null;
  actionPlan?: { delegatedApproverId?: string | null; delegatedById?: string | null } | null;
  actingManagerId: string | null;
  reporterId: string | null;
  project?: {
    onlyReportersCanApproveActionPlans?: boolean;
    onlyReportersCanSetTasksDone?: boolean;
  } | null;
  epic?: {
    status: string;
    actingManagerId: string | null;
    approvedOn?: Date | string | null;
  } | null;
};

export function isActionableEpicStatus(status: string | null | undefined): boolean {
  return status === "To Do" || status === "In Progress";
}

export function resolveReviewOwnerId(task: ReviewOwnerTask): string | null {
  if (task.actingManagerId) return task.actingManagerId;
  if (isActionableEpicStatus(task.epic?.status) && task.epic?.actingManagerId) {
    return task.epic.actingManagerId;
  }
  return task.reporterId;
}

export function resolveDoneOwnerId(task: ReviewOwnerTask): string | null {
  if (task.project?.onlyReportersCanSetTasksDone) return task.reporterId;
  return resolveReviewOwnerId(task);
}

/**
 * Done is a review decision, never a generic agent/admin capability. Keep the
 * full decision-owner set here so every transport reaches the same boundary:
 * task reporter, task acting manager, and the actionable Epic acting manager
 * (the resolved reviewer fallback). Projects with the reporter-only policy
 * deliberately narrow that set to the reporter.
 */
export function canSetTaskDoneForActor(
  task: ReviewOwnerTask,
  actorId: string,
): boolean {
  if (task.project?.onlyReportersCanSetTasksDone) {
    return actorId === task.reporterId;
  }
  return actorId === task.reporterId
    || actorId === task.actingManagerId
    || (
      isActionableEpicStatus(task.epic?.status)
      && actorId === task.epic?.actingManagerId
    );
}

export function canApproveActionPlanForActor(
  task: ReviewOwnerTask,
  actorId: string,
): boolean {
  // Owner policy: approving an Epic delegates child-plan approval to its
  // manager while the Epic is actionable. It does not permit self-approval.
  if (task.epic?.approvedOn && isActionableEpicStatus(task.epic.status)
      && task.epic.actingManagerId === actorId && task.assigneeId !== actorId) return true;
  if (task.actionPlan?.delegatedById === task.reporterId && task.reporterId
      && task.actionPlan?.delegatedApproverId === actorId && actorId === resolveReviewOwnerId(task)) return true;
  if (task.project?.onlyReportersCanApproveActionPlans) {
    return actorId === task.reporterId;
  }
  return actorId === task.reporterId || actorId === resolveReviewOwnerId(task);
}

export function resolvePlanApproverId(task: ReviewOwnerTask): string | null {
  const reviewer = resolveReviewOwnerId(task);
  if (task.actionPlan?.delegatedById === task.reporterId && task.reporterId
      && task.actionPlan?.delegatedApproverId === reviewer) return reviewer;
  if (task.epic?.approvedOn && isActionableEpicStatus(task.epic.status)
      && task.epic.actingManagerId && task.epic.actingManagerId !== task.assigneeId) return task.epic.actingManagerId;
  return task.project?.onlyReportersCanApproveActionPlans ? task.reporterId : reviewer;
}

export function epicAllowsAgentAction(task: { epic: { status: string } | null }) {
  // To Do epics are approved-and-queued: an agent starting one of their tasks
  // is exactly what flips the epic to In Progress, so allow it here too.
  return !task.epic || isActionableEpicStatus(task.epic.status);
}
