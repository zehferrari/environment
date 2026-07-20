// Proactive epic queue refill: assign unassigned, unblocked To Do tasks to
// every free pool worker and wake each assignee. This is the single engine
// entry point fired by every "a worker may have just become free" or "the
// queue may have new work" event: task Done, ready_for_review, human
// unassign/pull-back, epic action-plan approval.
import { db } from "@/lib/db";
import { assignOpenEpicTasks } from "@/lib/epics/assignment";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";

type Actor = {
  id: string;
  username?: string | null;
  kind: "human" | "agent";
};

export async function refillEpicQueue(args: {
  epicId: string;
  actor: Actor;
  via: string;
  // Optional first line for the assignee notification, e.g. what event freed
  // the queue ("Previous epic task X was accepted...").
  contextLine?: string;
}) {
  const epic = await db.epic.findFirst({
    where: { id: args.epicId, deletedAt: null, private: false },
    select: {
      id: true,
      status: true,
      approvedOn: true,
      projectId: true,
      actingManagerId: true,
      reporterId: true,
      project: { select: { slug: true } },
    },
  });
  if (!epic || epic.status !== "In Progress" || !epic.approvedOn) {
    return { assignments: [], skipped: "epic_not_ready" as const, epic: null };
  }

  const assignment = await db.$transaction((tx) =>
    assignOpenEpicTasks(tx, {
      epicId: epic.id,
      projectId: epic.projectId,
      actorUserId: args.actor.id,
      excludeUserIds: [epic.actingManagerId, epic.reporterId],
      via: args.via,
    }),
  );

  for (const assigned of assignment.assignments) {
    await sendTaskWorkflowNotification({
      taskId: assigned.task.id,
      targetUserId: assigned.worker.id,
      actor: args.actor,
      reason: "todo_start_required",
      body: [
        ...(args.contextLine ? [args.contextLine] : []),
        `Task "${assigned.task.title}" is now assigned to you in To Do.`,
        assigned.approvedPlan
          ? "Its Action Plan is already approved: move the task to In Progress through the workflow endpoint and start immediately."
          : "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
        "If you have unresolved review feedback on another Review-stage task, address that feedback first — it stays your top priority.",
      ].join("\n"),
    });
  }

  return { ...assignment, epic };
}
