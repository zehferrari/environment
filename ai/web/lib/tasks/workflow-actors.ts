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

export function resolveReviewOwnerId(task: ReviewOwnerTask): string | null {
  if (task.actingManagerId) return task.actingManagerId;
  if (task.epic?.status === "Open" && task.epic.actingManagerId) {
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
  return !task.epic || task.epic.status === "Open";
}
