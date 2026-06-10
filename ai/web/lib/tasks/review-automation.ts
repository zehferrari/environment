import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/task-workflow-notifications";
import { resolveDoneOwnerId, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { assignFirstOpenEpicTask } from "@/lib/epics/assignment";

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

    let nextAssignment: Awaited<ReturnType<typeof assignFirstOpenEpicTask>> | null = null;
    let skipReason: string | null = null;

    if (!task.epicId) {
      skipReason = "no_epic";
    } else {
      nextAssignment = await assignFirstOpenEpicTask(tx, {
        epicId: task.epicId,
        projectId: task.projectId,
        actorUserId: args.actor.id,
        excludeUserIds: [reviewerId, task.reporterId, task.epic?.actingManagerId],
        via: args.via,
      });
      skipReason = nextAssignment.skipped;
    }

    if (!nextAssignment?.task || !nextAssignment.worker) {
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "task.workflow.next_assignment_skipped",
          payload: JSON.stringify({
            reason: skipReason,
            epicId: task.epicId,
            via: args.via,
            action: "review_done",
          }),
        },
      });
    }

    return { nextAssignment };
  });

  const nextTask = completion.nextAssignment?.task && completion.nextAssignment.worker
    ? {
        id: completion.nextAssignment.task.id,
        title: completion.nextAssignment.task.title,
        projectSlug: completion.nextAssignment.task.project.slug,
      }
    : null;

  if (completion.nextAssignment?.task && completion.nextAssignment.worker) {
    await sendTaskWorkflowNotification({
      taskId: completion.nextAssignment.task.id,
      targetUserId: completion.nextAssignment.worker.id,
      actor: args.actor,
      reason: "todo_start_required",
      body: [
        `Previous epic task "${task.title}" was accepted by @${args.actor.username}.`,
        `Next task "${completion.nextAssignment.task.title}" is now assigned to you in To Do.`,
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
