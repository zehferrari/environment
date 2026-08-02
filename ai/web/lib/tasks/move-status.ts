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
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { refillEpicQueue } from "@/lib/epics/queue";
import { runTaskReviewHandoff } from "@/lib/tasks/review-handoff";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { revalidateTaskShell } from "@/lib/tasks/cache";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";

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

/**
 * The one authoritative browser task-status action. Both drag-and-drop and
 * bulk editors call this so Review handoff, worktree provisioning, Epic
 * promotion/sync, and queue refill cannot be bypassed by a bulk database edit.
 */
export async function moveTaskStatus(
  taskId: string,
  status: string,
  slug: string,
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
      projectId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      deletedAt: true,
      epicId: true,
      repositoryRun: { select: { phase: true } },
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!current || current.deletedAt) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  }
  await requireProjectAccess(actor, { id: current.projectId });
  if (current.status === status) return { ok: true };
  if (current.repositoryRun?.phase === "finalizing") {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Repository finalization is running; wait for it to complete before changing status.",
    };
  }

  // Browser-session human moves are authoritative. Agent/generic automation
  // still follows the stricter workflow edge policy.
  if (actor.kind !== "human") {
    const check = checkStatusTransition({
      from: current.status,
      to: status,
      actor,
    });
    if (!check.ok) {
      return { ok: false, code: check.code, message: check.message };
    }
  }
  if (actor.kind !== "human" && status === "In Progress" && !current.approvedOn) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Action Plan must be approved before this task can move to In Progress.",
    };
  }
  if (status === "In Progress") {
    try {
      await ensureTaskCodeWorktree(current.id, actor.id);
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
    for (const assigned of handoff.refillAssignments) {
      revalidatePath(`/projects/${slug}/tasks/${assigned.taskId}`);
    }
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${slug}`);
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  // Review feedback returned to To Do takes priority; all other moves append.
  const toTopOfTodo = current.status === "Review" && status === "To Do";
  let nextRank: number;
  if (toTopOfTodo) {
    const minRank = await db.task.aggregate({
      where: { status: "To Do", archivedAt: null, deletedAt: null },
      _min: { rank: true },
    });
    nextRank = (minRank._min.rank ?? 0) - 1;
  } else {
    const maxRank = await db.task.aggregate({
      where: { status, archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    nextRank = (maxRank._max.rank ?? 0) + 1;
  }
  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: {
        status,
        rank: nextRank,
        statusChangedAt: new Date(),
      },
    }),
    db.activityLog.create({
      data: {
        projectId: current.projectId,
        taskId,
        userId: actor.id,
        kind: "task.move",
        payload: JSON.stringify({
          from: current.status,
          to: status,
          via: actor.kind === "human" ? "human-board-move" : "agent-board-move",
        }),
      },
    }),
  ]);
  await syncEpicOnHumanTaskStatus(db, {
    epicId: current.epicId,
    projectId: current.projectId,
    taskId,
    actorId: actor.id,
    actorKind: actor.kind,
    targetStatus: status,
    via: "human-board-move",
  });
  if (status === "In Progress" && current.epicId) {
    await promoteEpicOnTaskInProgress(db, {
      epicId: current.epicId,
      projectId: current.projectId,
      actorId: actor.id,
      via: "board_move",
    });
  }
  if (status === "To Do" && current.assigneeId) {
    const approved = Boolean(current.approvedOn);
    await sendTaskWorkflowNotification({
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
            "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
            "Do not move it to In Progress until approved_on is set.",
          ].join("\n"),
    });
  }
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
