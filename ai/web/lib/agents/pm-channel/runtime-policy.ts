/** Staged rollout: keep legacy gateways and in-flight turns compatible. */
export function compactTaskRuntimeEnabled() {
  return process.env.PM_TASK_RUNTIME_V2 === "1";
}

/** PM bookkeeping still consumes the observable tool budget, never both budgets. */
export function countsAgainstWorkflowEpisodeBudget(intent: string) {
  if (intent === "checkpoint") return false;
  return !(compactTaskRuntimeEnabled() && ["add_subtask", "complete_subtask", "remove_subtask"].includes(intent));
}
