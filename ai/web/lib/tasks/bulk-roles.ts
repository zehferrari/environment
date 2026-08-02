"use server";

import { revalidatePath } from "next/cache";
import {
  accessibleTaskWhere,
  assertAgentAssignmentAllowed,
  requireOwner,
  requireProjectAccess,
} from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { revalidateTaskShell } from "@/lib/tasks/cache";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";

export type BulkTaskRoleField = "assigneeId" | "actingManagerId" | "reporterId";

const MAX_BULK_TASKS = 200;

export async function bulkUpdateTaskRole(
  taskIds: string[],
  slug: string,
  field: BulkTaskRoleField,
  targetUserId: string | null,
): Promise<{ updatedCount: number }> {
  const actor = await requireOwner();
  const requestedIds = [...new Set(taskIds)].filter(Boolean);
  if (!slug || requestedIds.length === 0) return { updatedCount: 0 };
  if (requestedIds.length > MAX_BULK_TASKS) {
    throw new Error(`Select no more than ${MAX_BULK_TASKS} tasks at once.`);
  }
  if (!["assigneeId", "actingManagerId", "reporterId"].includes(field)) {
    throw new Error("Unknown task role.");
  }
  await requireProjectAccess(actor, { slug });

  const tasks = await db.task.findMany({
    where: accessibleTaskWhere(actor, {
      id: { in: requestedIds },
      project: { slug },
      archivedAt: null,
      deletedAt: null,
    }),
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      epicId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      assignee: { select: { username: true } },
      actingManager: { select: { username: true } },
      reporter: { select: { username: true } },
    },
  });
  if (tasks.length !== requestedIds.length) throw new Error("Not authorized");

  let target: { id: string; username: string } | null = null;
  if (targetUserId) {
    const candidate = await db.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        username: true,
        kind: true,
        status: true,
        agent: { select: { role: true, deactivatedAt: true } },
      },
    });
    const assignable = candidate?.status === "active" && (
      candidate.kind === "human" ||
      (candidate.kind === "agent" && candidate.agent?.role === "coding" && !candidate.agent.deactivatedAt)
    );
    if (!candidate || !assignable) throw new Error("Selected user is not an active assignable principal.");
    target = { id: candidate.id, username: candidate.username };
  }

  const changed = tasks.filter((task) => task[field] !== targetUserId);
  if (changed.length === 0) return { updatedCount: 0 };
  await assertAgentAssignmentAllowed(
    actor,
    changed.flatMap((task) => [task[field], targetUserId]),
  );

  const data = field === "assigneeId"
    ? {
        assigneeId: targetUserId,
        approvedOn: null,
        approvedById: null,
      }
    : field === "actingManagerId"
      ? { actingManagerId: targetUserId }
      : { reporterId: targetUserId };
  const activityKind = field === "assigneeId"
    ? "task.assign"
    : field === "actingManagerId"
      ? "task.acting_manager"
      : "task.reporter";

  await db.$transaction([
    db.task.updateMany({
      where: { id: { in: changed.map((task) => task.id) } },
      data,
    }),
    ...changed.flatMap((task) => {
      const previousUsername = field === "assigneeId"
        ? task.assignee?.username ?? null
        : field === "actingManagerId"
          ? task.actingManager?.username ?? null
          : task.reporter?.username ?? null;
      const logs = [
        db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: actor.id,
            kind: activityKind,
            payload: JSON.stringify({
              from: previousUsername,
              to: target?.username ?? null,
              ...(field === "assigneeId" ? { assignedBy: "human-bulk-edit" } : {}),
            }),
          },
        }),
      ];
      if (field === "assigneeId") {
        logs.push(db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: actor.id,
            kind: "task.action_plan.reset",
            payload: JSON.stringify({
              reason: "assignee_changed",
              from: previousUsername,
              to: target?.username ?? null,
            }),
          },
        }));
      }
      return logs;
    }),
  ]);

  // Role changes are workflow events, not merely labels. Wake the new worker
  // or reviewer with the same guidance used by the single-task editor.
  if (targetUserId && field === "assigneeId") {
    for (const task of changed) {
      if (task.status !== "Backlog" && task.status !== "To Do") continue;
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId,
        actor,
        reason: task.status === "Backlog" ? "backlog_plan_requested" : "todo_start_required",
        body: task.status === "Backlog"
          ? [
              `You have been assigned to "${task.title}" while it is in Backlog.`,
              "Read the full task context and existing comments. Post one concise technical implementation plan in Action Plan.",
              "Do not change task status and do not start work until the task is moved to To Do.",
            ].join("\n")
          : [
              `Task "${task.title}" is now in To Do and assigned to you.`,
              "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
              "Do not move it to In Progress until approved_on is set.",
            ].join("\n"),
      });
    }
  }
  if (targetUserId && field === "actingManagerId") {
    for (const task of changed) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId,
        actor,
        reason: "reviewer_plan_requested",
        body: [
          `You have been set as Reviewer for "${task.title}".`,
          "If the task has no assignee, read the full task context and post one reviewer plan of action in Action Plan, including the subtasks/topics/items that must be addressed or watched.",
          "Do not start implementation or move status. After the reporter approves the plan, call action=assign_after_plan_approval so PM can assign an eligible coding agent and move Backlog to To Do if needed.",
        ].join("\n"),
      });
    }
  }

  for (const task of changed) revalidateTaskShell(task.id);
  revalidatePath(`/projects/${slug}`);
  for (const epicId of new Set(changed.map((task) => task.epicId).filter(Boolean))) {
    revalidatePath(`/projects/${slug}/epics/${epicId}`);
  }
  publishBoardTouch(changed[0].projectId);
  return { updatedCount: changed.length };
}
