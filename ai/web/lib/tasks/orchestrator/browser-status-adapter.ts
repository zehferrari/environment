import type { Viewer } from "@/lib/auth/permissions";
import type { MoveTaskResult } from "@/lib/tasks/move-status";
import { submitWorkflowCommand } from "@/lib/tasks/orchestrator";
import type { TaskWorkflowStatus } from "@/lib/tasks/transition-kernel";

const TASK_STATUSES = new Set<TaskWorkflowStatus>([
  "Backlog",
  "To Do",
  "In Progress",
  "Review",
  "Done",
]);

export type BrowserStatusOverrideSurface =
  | "project-board"
  | "workspace-board"
  | "workspace-landing"
  | "task-detail";

export function isTaskWorkflowStatus(value: string): value is TaskWorkflowStatus {
  return TASK_STATUSES.has(value as TaskWorkflowStatus);
}

/**
 * Translate one already-authorized browser status request into the canonical
 * human override command. Callers own their project/workspace membership
 * checks and pass the workflow version read with that authorization snapshot.
 * A command rejection is returned directly; there is no legacy retry path.
 */
export async function submitBrowserStatusOverride(args: {
  actor: Viewer;
  taskId: string;
  currentStatus: TaskWorkflowStatus;
  targetStatus: TaskWorkflowStatus;
  expectedWorkflowVersion: number;
  activeWorkflowCycleId: string | null;
  surface: BrowserStatusOverrideSurface;
}): Promise<MoveTaskResult> {
  if (args.actor.kind !== "human") {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Only an authenticated human can override a task status from the browser.",
    };
  }
  // A same-status Done request is still meaningful when historical/manual
  // state left an active cycle behind. Send it through the command boundary
  // so the cycle is closed atomically and audited.
  if (args.currentStatus === args.targetStatus && !args.activeWorkflowCycleId) return { ok: true };

  const result = await submitWorkflowCommand({
    taskId: args.taskId,
    intent: "override_status",
    actor: {
      id: args.actor.id,
      kind: "human",
      username: args.actor.username,
    },
    expectedWorkflowVersion: args.expectedWorkflowVersion,
    workflowCycleId: args.activeWorkflowCycleId,
    source: "browser",
    idempotencyKey: [
      "browser-status-override",
      args.surface,
      args.actor.id,
      args.taskId,
      `v${args.expectedWorkflowVersion}`,
      args.targetStatus,
    ].join(":"),
    payload: {
      targetStatus: args.targetStatus,
      reason: `Authenticated human status change from ${args.surface}.`,
    },
  });

  if (result.status === "accepted" || result.status === "replayed") {
    return { ok: true };
  }
  if (result.status === "stale") {
    return {
      ok: false,
      code: "STALE_VERSION",
      message: "The task changed while this status update was pending. Refresh the board and try again.",
    };
  }
  return {
    ok: false,
    code: "EXPLICIT_USER_ACTION_REQUIRED",
    message: result.reason,
  };
}
