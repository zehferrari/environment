import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/task-workflow-notifications";
import { resolveDoneOwnerId, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import type { Prisma } from "@prisma/client";

type Actor = {
  id: string;
  username: string;
  kind: "human" | "agent";
};

const HARD_REVIEW_REJECT = [
  /\bnot\s+(?:approved|ready|done|accepted)\b/i,
  /\b(?:cannot|can't|wont|won't)\s+approve\b/i,
  /\bneeds?\s+(?:changes?|fix(?:es)?|work|follow-?up|another\s+pass)\b/i,
  /\bplease\s+(?:fix|add|remove|change|address|update|either)\b/i,
  /\b(?:blocking|blocker)\s+(?:issue|before|found|remaining)\b/i,
  /\bfail(?:ed|ing|s)?\b/i,
  /\bmissing\b/i,
];

const NO_ISSUES_APPROVAL = /\bno\b[^.\n]{0,140}\b(?:blockers?|issues?|concerns?|findings?)\b/i;
const POSITIVE_REVIEW = [
  /\breview\s+pass(?:ed)?\b/i,
  /\bapproved\b/i,
  /\bapproving\b/i,
  /\baccepted\b/i,
  /\bsatisfied\b/i,
  /\bhappy\s+with\b/i,
  /\bworks\s+for\s+me\b/i,
  /\blgtm\b/i,
  /\blooks\s+good\b/i,
  /\bready\s+(?:for\s+done|to\s+(?:merge|land|complete))\b/i,
  /\bno\s+further\s+action\b/i,
];

export function isReviewerApprovalComment(body: string) {
  const text = body.trim();
  if (!text) return false;
  if (HARD_REVIEW_REJECT.some((pattern) => pattern.test(text))) return false;
  if (NO_ISSUES_APPROVAL.test(text)) return true;
  return POSITIVE_REVIEW.some((pattern) => pattern.test(text));
}

async function findNextEpicTask(tx: Prisma.TransactionClient, epicId: string) {
  return tx.task.findFirst({
    where: {
      epicId,
      parentTaskId: null,
      archivedAt: null,
      deletedAt: null,
      status: "To Do",
    },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      assigneeId: true,
      actingManagerId: true,
      project: { select: { slug: true } },
    },
  });
}

export async function completeReviewedTaskAndAssignNext(args: {
  taskId: string;
  actor: Actor;
  via: string;
  requireReviewerUserId?: string | null;
  commentId?: string | null;
}) {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      epicId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      deletedAt: true,
      project: { select: { slug: true, onlyReportersCanSetTasksDone: true } },
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!task || task.deletedAt) return { completed: false as const, reason: "not_found" as const };
  if (task.status !== "Review") return { completed: false as const, reason: "not_review" as const };

  const reviewerId = resolveReviewOwnerId(task);
  const doneOwnerId = resolveDoneOwnerId(task);
  if (args.requireReviewerUserId && doneOwnerId !== args.requireReviewerUserId) {
    return { completed: false as const, reason: "not_reviewer" as const };
  }

  const completion = await db.$transaction(async (tx) => {
    const maxRank = await tx.task.aggregate({
      where: { status: "Done", archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    await tx.task.update({
      where: { id: task.id },
      data: {
        status: "Done",
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: new Date(),
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actor.id,
        kind: "task.move",
        payload: JSON.stringify({
          from: "Review",
          to: "Done",
          via: args.via,
          action: "review_done",
          commentId: args.commentId ?? null,
        }),
      },
    });

    let nextTask: Awaited<ReturnType<typeof findNextEpicTask>> | null = null;
    let targetAssigneeId: string | null = null;
    let skipReason: string | null = null;

    if (!task.epicId) {
      skipReason = "no_epic";
    } else {
      nextTask = await findNextEpicTask(tx, task.epicId);
      if (!nextTask) {
        skipReason = "no_todo_task";
      } else {
        targetAssigneeId = nextTask.assigneeId ?? task.assigneeId;
        if (!targetAssigneeId) {
          skipReason = "no_assignee_to_carry_forward";
        }
      }
    }

    if (nextTask && targetAssigneeId) {
      if (!nextTask.assigneeId) {
        await tx.task.update({
          where: { id: nextTask.id },
          data: { assigneeId: targetAssigneeId, approvedOn: null, approvedById: null },
        });
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: nextTask.id,
            userId: args.actor.id,
            kind: "task.assign",
            payload: JSON.stringify({
              from: null,
              to: "previous-assignee",
              via: args.via,
              action: "review_done",
              afterTaskId: task.id,
            }),
          },
        });
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: nextTask.id,
            userId: args.actor.id,
            kind: "task.action_plan.reset",
            payload: JSON.stringify({
              reason: "assignee_changed",
              via: args.via,
              action: "review_done",
              afterTaskId: task.id,
            }),
          },
        });
      }
      if (!nextTask.actingManagerId && reviewerId) {
        await tx.task.update({
          where: { id: nextTask.id },
          data: { actingManagerId: reviewerId },
        });
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: nextTask.id,
            userId: args.actor.id,
            kind: "task.acting_manager",
            payload: JSON.stringify({
              from: null,
              to: args.actor.username,
              via: args.via,
              action: "review_done",
              afterTaskId: task.id,
            }),
          },
        });
      }
    } else {
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "task.workflow.next_assignment_skipped",
          payload: JSON.stringify({
            reason: skipReason,
            epicId: task.epicId,
            carriedAssigneeId: task.assigneeId,
            via: args.via,
            action: "review_done",
          }),
        },
      });
    }

    return { nextTask, targetAssigneeId };
  });

  const nextTask = completion.nextTask && completion.targetAssigneeId
    ? {
        id: completion.nextTask.id,
        title: completion.nextTask.title,
        projectSlug: completion.nextTask.project.slug,
      }
    : null;

  if (completion.nextTask && completion.targetAssigneeId) {
    await sendTaskWorkflowNotification({
      taskId: completion.nextTask.id,
      targetUserId: completion.targetAssigneeId,
      actor: args.actor,
      reason: "todo_start_required",
      body: [
        `Previous epic task "${task.title}" was accepted by @${args.actor.username}.`,
        completion.nextTask.assigneeId
          ? `Next task "${completion.nextTask.title}" is already assigned to you in To Do.`
          : `Next task "${completion.nextTask.title}" is now assigned to you in To Do.`,
        "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
        "If you have unresolved review feedback on another Review-stage task, address that feedback first; otherwise prepare the Action Plan for this task now.",
      ].join("\n"),
    });
  }

  if (!nextTask && task.assigneeId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor: args.actor,
      reason: "review_done",
      body: [
        `Task "${task.title}" was reviewed and moved to Done by @${args.actor.username}.`,
        "No further action is required unless the task is reopened.",
      ].join("\n"),
    });
  }

  return {
    completed: true as const,
    taskId: task.id,
    projectSlug: task.project.slug,
    nextTask,
  };
}

export async function tryCompleteTaskFromReviewerComment(args: {
  taskId: string;
  commentId: string;
  body: string;
  agentUserId: string;
  agentSlug: string;
}) {
  if (!isReviewerApprovalComment(args.body)) {
    return { completed: false as const, reason: "not_approval" as const };
  }
  return completeReviewedTaskAndAssignNext({
    taskId: args.taskId,
    actor: {
      id: args.agentUserId,
      username: args.agentSlug,
      kind: "agent",
    },
    via: "agent-review-comment",
    requireReviewerUserId: args.agentUserId,
    commentId: args.commentId,
  });
}
