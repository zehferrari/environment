"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  checkStatusTransition,
  type WorkflowErrorCode,
} from "@/lib/workflow";
import {
  accessibleTaskWhere,
  requireProjectAccess,
  requireViewer,
} from "@/lib/auth/permissions";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { refillEpicQueue } from "@/lib/epics/queue";
import { runTaskReviewHandoff } from "@/lib/tasks/review-handoff";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { revalidateTaskShell } from "@/lib/tasks/cache";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { findInProgressStartConflict } from "@/lib/tasks/auto-start";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";
import { epicAllowsAgentAction } from "@/lib/tasks/workflow-actors";
import {
  transitionTask,
  type TaskTransitionIntent,
  type TaskWorkflowStatus,
  type WorkflowEffect,
} from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";

const TASK_STATUSES: readonly string[] = [
  "Backlog",
  "To Do",
  "In Progress",
  "Review",
  "Done",
];

export type MoveTaskResult =
  | { ok: true }
  | { ok: false; code: WorkflowErrorCode | "UNKNOWN_COLUMN"; message: string };

export type MoveTaskOptions = {
  /**
   * Explicit break-glass repair for a wedged state machine. Admin-only and
   * always an opt-in flag on the request — the server never falls back to it.
   */
  operatorOverride?: boolean;
};

/**
 * The one authoritative browser task-status action. Both drag-and-drop and
 * bulk editors call this so Review handoff, worktree provisioning, Epic
 * promotion/sync, and queue refill cannot be bypassed by a bulk database edit.
 */
export async function moveTaskStatus(
  taskId: string,
  status: string,
  slug: string,
  options?: MoveTaskOptions,
): Promise<MoveTaskResult> {
  const actor = await requireViewer();
  if (!TASK_STATUSES.includes(status)) {
    return {
      ok: false,
      code: "UNKNOWN_COLUMN",
      message: `Unknown column: ${status}`,
    };
  }
  const current = await db.task.findFirst({
    where: accessibleTaskWhere(actor, { id: taskId }),
    select: {
      id: true,
      title: true,
      status: true,
      workflowVersion: true,
      projectId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      deletedAt: true,
      epicId: true,
      blockedById: true,
      blockedBy: { select: { status: true, workItemKey: true } },
      branchName: true,
      workItemKey: true,
      repositoryRun: { select: { phase: true } },
      epic: { select: { status: true, actingManagerId: true, branchName: true, workItemKey: true } },
    },
  });
  if (!current || current.deletedAt) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  }
  await requireProjectAccess(actor, { id: current.projectId });
  if (current.status === status) return { ok: true };

  // Operator override: an explicit, admin-only escape hatch for a wedged
  // state machine. It deliberately bypasses the finalizing fence, the
  // plan/assignee/blocker/epic/WIP gates, worktree provisioning, Review
  // handoff and Done automation — an override repairs board state, it does
  // not perform the work those hooks automate. The kernel still enforces
  // CAS (workflowVersion) + idempotency and writes a WorkflowTransition row
  // with intent "operator_override", so every forced move stays auditable.
  if (options?.operatorOverride) {
    if (actor.kind !== "human" || !actor.isOwner) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Operator override is restricted to the human operator (admin).",
      };
    }
    await transitionTask({
      taskId,
      projectId: current.projectId,
      actorUserId: actor.id,
      intent: "operator_override",
      from: current.status as TaskWorkflowStatus,
      to: status as TaskWorkflowStatus,
      source: "human-board-move",
      idempotencyKey: `board-override:${actor.id}:v${current.workflowVersion + 1}:${status}`,
      expectedVersion: current.workflowVersion,
      evidence: { operatorOverride: true },
      effects: [{ type: "board_touch", key: "board:operator_override", payload: {} }],
    });
    await drainWorkflowOutbox({ limit: 1 }).catch(() => {});
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${slug}`);
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  if (current.repositoryRun?.phase === "finalizing") {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Repository finalization is running; wait for it to complete before changing status.",
    };
  }

  if (actor.kind !== "human") {
    const check = checkStatusTransition({ from: current.status, to: status, actor });
    if (!check.ok) return { ok: false, code: check.code, message: check.message };
  }
  // A browser move is an adapter to the same workflow, not an implicit
  // operator override. Unsafe shortcuts need a separate reason-bearing
  // override action instead of silently bypassing plan/start gates.
  if (status === "In Progress" && !current.approvedOn) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Action Plan must be approved before this task can move to In Progress.",
    };
  }
  if (status === "In Progress") {
    if (!current.assigneeId) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Assign an implementation owner before moving this task to In Progress.",
      };
    }
    if (current.blockedById && current.blockedBy?.status !== "Done") {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: `Task is blocked by ${current.blockedBy?.workItemKey ?? "another task"}, which must reach Done first.`,
      };
    }
    if (!epicAllowsAgentAction(current)) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "The parent Epic must be In Progress before this task can start.",
      };
    }
    const conflict = await findInProgressStartConflict(db, {
      taskId: current.id,
      projectId: current.projectId,
      assigneeId: current.assigneeId,
      candidateBranch: effectiveTaskBranchName(current),
    });
    if (conflict) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: conflict.kind === "wip"
          ? `The assignee already has an In Progress task in this project (${conflict.activeTask.workItemKey ?? conflict.activeTask.title}).`
          : `Another In Progress task uses this effective branch (${conflict.activeTask.workItemKey ?? conflict.activeTask.title}).`,
      };
    }
    try {
      await ensureTaskCodeWorktree(current.id, current.assigneeId);
    } catch (err) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: err instanceof TaskWorktreeError
          ? err.message
          : "Task worktree could not be created or validated.",
      };
    }
  }

  if (current.status === "Review" && status === "Done" && (actor.isOwner || actor.kind === "agent")) {
    const actorUser = await db.user.findUnique({
      where: { id: actor.id },
      select: { username: true },
    });
    const completion = await completeReviewedTaskAndAssignNext({
      taskId,
      actor: {
        id: actor.id,
        username: actorUser?.username ?? "unknown",
        kind: actor.kind,
      },
      via: "board-move",
    });
    if (!completion.completed) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Could not complete this reviewed task.",
      };
    }
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${slug}`);
    for (const next of completion.nextTasks ?? []) {
      revalidateTaskShell(next.id);
      revalidatePath(`/projects/${slug}/tasks/${next.id}`);
    }
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  if (status === "Review") {
    if (current.status !== "In Progress") {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "A task can enter Review only through validation from In Progress.",
      };
    }
    const actorUser = await db.user.findUnique({
      where: { id: actor.id },
      select: { username: true },
    });
    const handoff = await runTaskReviewHandoff({
      taskId,
      actor: { id: actor.id, kind: actor.kind, username: actorUser?.username ?? null },
      via: "human-board-move",
      movedFromStatus: current.status,
    });
    if (handoff.error || handoff.status !== "Review" && handoff.repositoryPhase !== "validating") {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: handoff.error ?? "Task did not pass the Review handoff gates.",
      };
    }
    for (const assigned of handoff.refillAssignments) {
      revalidatePath(`/projects/${slug}/tasks/${assigned.taskId}`);
    }
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${slug}`);
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  const edge = `${current.status}->${status}`;
  const intentByEdge: Record<string, TaskTransitionIntent> = {
    "Backlog->To Do": "triage",
    "To Do->In Progress": "start",
    "In Progress->To Do": "queue",
    "Review->To Do": "request_changes",
    "Done->To Do": "reopen",
    "To Do->Backlog": "cancel",
    "In Progress->Backlog": "cancel",
    "Review->Backlog": "cancel",
  };
  const intent = intentByEdge[edge];
  if (!intent) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: `The ${edge} edge requires a dedicated workflow action; board drag cannot override it.`,
    };
  }
  const effects: WorkflowEffect[] = [
    { type: "board_touch", key: `board:${intent}`, payload: {} },
  ];
  if (status === "To Do" && current.assigneeId) {
    const approved = Boolean(current.approvedOn);
    effects.push({
      type: "task_notification",
      key: `todo-start-required:${current.assigneeId}`,
      payload: {
        taskId,
        targetUserId: current.assigneeId,
        actor,
        reason: "todo_start_required",
        body: approved
          ? [
            `Task "${current.title}" is now in To Do and assigned to you.`,
            "The Action Plan is approved. Move it to In Progress through the workflow endpoint and start work immediately.",
            "Do not post a visible acknowledgement unless you have new task information to add.",
          ].join("\n")
          : [
            `Task "${current.title}" is now in To Do and assigned to you.`,
            "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. A plain chat reply is discussion only.",
            "Do not move it to In Progress until approved_on is set.",
          ].join("\n"),
      },
    });
  }
  await transitionTask({
    taskId,
    projectId: current.projectId,
    actorUserId: actor.id,
    intent,
    from: current.status as TaskWorkflowStatus,
    to: status as TaskWorkflowStatus,
    source: actor.kind === "human" ? "human-board-move" : "agent-board-move",
    idempotencyKey: `board:${actor.id}:v${current.workflowVersion + 1}:${status}`,
    expectedVersion: current.workflowVersion,
    rank: current.status === "Review" && status === "To Do" ? "front" : "back",
    effects,
    mutate: async ({ tx }) => {
      await syncEpicOnHumanTaskStatus(tx, {
        epicId: current.epicId,
        projectId: current.projectId,
        taskId,
        actorId: actor.id,
        actorKind: actor.kind,
        targetStatus: status,
        via: "human-board-move",
      });
      if (status === "In Progress" && current.epicId) {
        await promoteEpicOnTaskInProgress(tx, {
          epicId: current.epicId,
          projectId: current.projectId,
          actorId: actor.id,
          via: "board_move",
        });
      }
    },
  });
  await drainWorkflowOutbox({ limit: effects.length }).catch(() => {});
  if (
    current.epicId &&
    (status === "Done" || ((status === "To Do" || status === "Backlog") && !current.assigneeId))
  ) {
    const refill = await refillEpicQueue({
      epicId: current.epicId,
      actor,
      via: "board-move",
      contextLine: status === "Done"
        ? `"${current.title}" was completed.`
        : `"${current.title}" was returned to the queue.`,
    });
    for (const assigned of refill.assignments) {
      revalidateTaskShell(assigned.task.id);
      revalidatePath(`/projects/${slug}/tasks/${assigned.task.id}`);
    }
  }
  revalidateTaskShell(taskId);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(current.projectId);
  return { ok: true };
}
