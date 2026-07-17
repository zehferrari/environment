export function sanitizeBranchComponent(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 180);
}

export function branchNameFromWorkItemKey(workItemKey: string | null | undefined) {
  if (!workItemKey) return null;
  return sanitizeBranchComponent(workItemKey) || null;
}

export function effectiveEpicBranchName(epic: {
  workItemKey: string | null;
  branchName: string | null;
}) {
  const existing = epic.branchName?.trim();
  return existing || branchNameFromWorkItemKey(epic.workItemKey);
}

export function effectiveTaskBranchName(task: {
  workItemKey: string | null;
  branchName: string | null;
  epic?: { workItemKey: string | null; branchName: string | null } | null;
}) {
  const taskBranch = task.branchName?.trim();
  if (taskBranch) return taskBranch;

  const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
  return epicBranch || branchNameFromWorkItemKey(task.workItemKey);
}
