import type { Viewer } from "@/lib/auth/permissions";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";

export type BrowserPlanApprovalResult =
  | { ok: true; procedureId: string | null }
  | { ok: false; message: string; stale: boolean };

/**
 * Submit a task-detail Action Plan approval through the authoritative command
 * boundary. The caller resolves task access and the exact current plan
 * revision before invoking this adapter; a rejection is surfaced directly and
 * is never retried through the legacy transaction.
 */
export async function submitBrowserPlanApproval(args: {
  actor: Viewer;
  taskId: string;
  actionPlanId: string;
  actionPlanVersion: number;
  expectedWorkflowVersion: number;
}): Promise<BrowserPlanApprovalResult> {
  if (args.actor.kind !== "human") {
    return {
      ok: false,
      stale: false,
      message: "Only an authenticated human can approve an Action Plan from the browser.",
    };
  }

  const result = await submitWorkflowCommand({
    taskId: args.taskId,
    intent: "approve_plan",
    actor: {
      id: args.actor.id,
      kind: "human",
      username: args.actor.username,
    },
    expectedWorkflowVersion: args.expectedWorkflowVersion,
    workflowCycleId: null,
    source: "browser",
    idempotencyKey: [
      "browser-plan-approval",
      args.actor.id,
      args.taskId,
      `v${args.expectedWorkflowVersion}`,
      args.actionPlanId,
      `r${args.actionPlanVersion}`,
    ].join(":"),
    payload: {
      actionPlanId: args.actionPlanId,
      actionPlanVersion: args.actionPlanVersion,
    },
  });

  if (result.status === "accepted" || result.status === "replayed") {
    return { ok: true, procedureId: result.procedureId ?? null };
  }
  return {
    ok: false,
    stale: result.status === "stale",
    message: result.status === "stale"
      ? "The task or Action Plan changed while approval was pending. Refresh and try again."
      : result.reason,
  };
}
