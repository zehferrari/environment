export type ReviewOwnerTask = {
  actingManagerId: string | null;
  reporterId: string | null;
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

export function epicAllowsAgentAction(task: { epic: { status: string } | null }) {
  return !task.epic || task.epic.status === "Open";
}
