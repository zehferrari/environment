import type { Viewer } from "@/lib/auth/permissions";
import type { MoveTaskResult } from "@/lib/tasks/move-status";
import { loadTaskStateSnapshot, submitWorkflowCommand } from "@/lib/tasks/orchestrator";
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

function browserResult(
  result: Awaited<ReturnType<typeof submitWorkflowCommand>>,
): MoveTaskResult {
  if (result.status === "accepted" || result.status === "replayed") return { ok: true };
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

  const state = await loadTaskStateSnapshot(args.taskId);
  if (!state) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Task not found.",
    };
  }
  const repositoryBacked = Boolean(state.project.repositoryPath || state.repositoryRun);

  // A repository-backed task may enter implementation only through the
  // canonical start command. That command opens the cycle and schedules the
  // worktree revalidation/recreation procedure before dispatching the agent.
  if (repositoryBacked && args.targetStatus === "In Progress") {
    if (args.currentStatus !== "To Do") {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Repository work can only start from To Do. Return the task to To Do first.",
      };
    }
    const result = await submitWorkflowCommand({
      taskId: args.taskId,
      intent: "start_implementation",
      actor: {
        id: args.actor.id,
        kind: "human",
        username: args.actor.username,
      },
      expectedWorkflowVersion: args.expectedWorkflowVersion,
      workflowCycleId: null,
      source: "browser",
      idempotencyKey: [
        "browser-start-implementation",
        args.surface,
        args.actor.id,
        args.taskId,
        `v${args.expectedWorkflowVersion}`,
      ].join(":"),
      payload: {},
      evidence: {
        policy: "human_start_request",
        assigneeLane: `${state.projectId}:${state.assigneeId ?? "unassigned"}`,
        selectedTaskId: state.id,
        selectedAssigneeId: state.assigneeId,
        expectedWorkflowVersion: args.expectedWorkflowVersion,
        via: `browser-status:${args.surface}`,
      },
    });
    return browserResult(result);
  }

  // Done for repository work is an immutable review decision, not a status
  // override. Acceptance schedules repository finalization; the finalizer
  // removes the local worktree/branch before its callback moves the task.
  if (repositoryBacked && args.targetStatus === "Done") {
    if (args.currentStatus !== "Review") {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Repository work can only be completed from Review after its candidate has been validated.",
      };
    }
    if (
      !state.activeWorkflowCycleId
      || !state.activeReviewRun
      || state.activeReviewRun.status !== "awaiting_review"
    ) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "This task does not have an active validated review candidate to accept.",
      };
    }
    const result = await submitWorkflowCommand({
      taskId: args.taskId,
      intent: "accept_review",
      actor: {
        id: args.actor.id,
        kind: "human",
        username: args.actor.username,
        role: "reviewer",
      },
      expectedWorkflowVersion: args.expectedWorkflowVersion,
      workflowCycleId: state.activeWorkflowCycleId,
      source: "browser",
      idempotencyKey: [
        "browser-status-accept-review",
        args.surface,
        args.actor.id,
        args.taskId,
        state.activeReviewRun.id,
        `v${args.expectedWorkflowVersion}`,
      ].join(":"),
      payload: {
        reviewRunId: state.activeReviewRun.id,
        candidateSha: state.activeReviewRun.candidateSha,
      },
      evidence: {
        reviewerComment: "Task marked complete by the authenticated human reviewer.",
        requestedVia: `browser-status:${args.surface}`,
      },
    });
    return browserResult(result);
  }

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

  return browserResult(result);
}
