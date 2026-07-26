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

  // Own branch per task: an Epic child works on its own branch (derived from its
  // human work-item key) so multiple pool agents can implement independent parts
  // of the same Epic in parallel without ever colliding on a single shared
  // branch. Branch-keyed serialization (lib/tasks/auto-start.ts) then guarantees
  // no two tasks on the same effective branch are In Progress at once. Managers
  // force co-development by giving tasks an explicit shared branchName. The
  // Epic's own branch is only a fallback for a legacy task with no key.
  // NOTE: a dependent task (Blocked By) that must build on a predecessor's
  // not-yet-merged work needs the Epic integration branch as its base — that
  // git-orchestration piece lives in claim-branch (host tooling), tracked
  // separately. The Blocked By gate keeps such a task from starting early.
  const ownBranch = branchNameFromWorkItemKey(task.workItemKey);
  if (ownBranch) return ownBranch;

  return task.epic ? effectiveEpicBranchName(task.epic) : null;
}
