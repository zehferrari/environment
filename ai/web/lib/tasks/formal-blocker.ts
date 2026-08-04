type TaskActivityKindRow = {
  taskId: string | null;
  kind: string;
};

const FORMAL_BLOCKER_KINDS = new Set([
  "task.blocker",
  "task.extra_work.blocker",
  "task.blocker.cleared",
]);

/**
 * Resolve the current formal-blocker state from task activity ordered newest
 * first. `alertReporter` cannot be used for this because repository and
 * administrative alerts share that broader flag.
 */
export function activeFormalBlockerTaskIds(
  newestFirstRows: readonly TaskActivityKindRow[],
) {
  const resolved = new Set<string>();
  const active = new Set<string>();

  for (const row of newestFirstRows) {
    if (!row.taskId || resolved.has(row.taskId) || !FORMAL_BLOCKER_KINDS.has(row.kind)) {
      continue;
    }
    resolved.add(row.taskId);
    if (row.kind !== "task.blocker.cleared") active.add(row.taskId);
  }

  return active;
}
