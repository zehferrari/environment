export type ReviewOwnerTask = {
  actingManagerId: string | null;
  reporterId: string | null;
  project?: {
    onlyReportersCanApproveActionPlans?: boolean;
    onlyReportersCanSetTasksDone?: boolean;
  } | null;
  epic: {
    status: string;
    actingManagerId: string | null;
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

export function canApproveActionPlanForActor(
  task: ReviewOwnerTask,
  actorId: string,
): boolean {
  if (task.project?.onlyReportersCanApproveActionPlans) {
    return actorId === task.reporterId;
  }
  return actorId === task.reporterId || actorId === resolveReviewOwnerId(task);
}

export function epicAllowsAgentAction(task: { epic: { status: string } | null }) {
  // To Do epics are approved-and-queued: an agent starting one of their tasks
  // is exactly what flips the epic to In Progress, so allow it here too.
  return !task.epic || isActionableEpicStatus(task.epic.status);
}
