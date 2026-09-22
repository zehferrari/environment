export type NotificationOutcome =
  | { status: "delivered"; channel: "human" | "agent" }
  | { status: "skipped"; reason: string }
  | { status: "retryable_failure" | "permanent_failure"; error: string };

export function obsoleteTaskNotificationReason(
  reason: string, status: string, cycleId?: string | null, activeCycleId?: string | null,
): string | null {
  if (cycleId && cycleId !== activeCycleId && reason !== "review_done") return "workflow_cycle_superseded";
  if (status === "Done" && reason !== "review_done") return "task_completed";
  if (reason === "review_done" && status !== "Done") return "task_reopened";
  const stages: Record<string, string[]> = {
    backlog_plan_requested: ["Backlog"],
    todo_start_required: ["To Do"],
    review_requested: ["Review"],
    action_plan_review_requested: ["Backlog", "To Do"],
    action_plan_feedback_received: ["Backlog", "To Do"],
    reviewer_plan_requested: ["Backlog", "To Do"],
    reviewer_assignment_requested: ["Backlog", "To Do"],
  };
  return stages[reason] && !stages[reason].includes(status) ? "workflow_stage_passed" : null;
}

export function agentDeliveryOutcome(delivery: { ok: boolean; status?: number; error?: string }): NotificationOutcome {
  if (delivery.ok) return { status: "delivered", channel: "agent" };
  const retryable = !delivery.status || delivery.status >= 500 || [408, 409, 425, 429].includes(delivery.status);
  return {
    status: retryable ? "retryable_failure" : "permanent_failure",
    error: delivery.error ?? `Agent notification delivery failed (${delivery.status ?? "transport"}).`,
  };
}

