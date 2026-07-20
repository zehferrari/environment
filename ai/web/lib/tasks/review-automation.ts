import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { resolveDoneOwnerId, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { assignOpenEpicTasks, type EpicTaskAssignment } from "@/lib/epics/assignment";
import { resetEpicActionPlanForDeployReview, triggerDeployReview } from "@/lib/epics/deploy-review";

type Actor = {
  id: string;
  username: string;
  kind: "human" | "agent";
};

// WORKFLOW.md § reviewing documents exactly one auto-complete keyword:
// "looks good, ship it". The previous fuzzy classifier (POSITIVE_REVIEW /
// NO_ISSUES_APPROVAL regexes) closed tasks against explicit reviewer intent
// — e.g. "not review_done" evaded the reject list via the underscore — and
// armed Ready-to-Deploy on unverified work. Auto-complete now fires ONLY on
// the documented unmistakable keyword; everything else must use the
// review_done workflow endpoint.
const APPROVAL_KEYWORD = /\blooks\s+good\W+ship\s+it\b/i;

export function isReviewerApprovalComment(body: string) {
  const text = body.trim();
  if (!text) return false;
  return APPROVAL_KEYWORD.test(text);
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
    let promotedEpicToReadyToDeploy = false;
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

    let nextAssignments: EpicTaskAssignment[] = [];
    let skipReason: string | null = null;

    if (!task.epicId) {
      skipReason = "no_epic";
    } else {
      const assignment = await assignOpenEpicTasks(tx, {
        epicId: task.epicId,
        projectId: task.projectId,
        actorUserId: args.actor.id,
        excludeUserIds: [reviewerId, task.reporterId, task.epic?.actingManagerId],
        via: args.via,
      });
      nextAssignments = assignment.assignments;
      skipReason = assignment.skipped;
    }

    if (nextAssignments.length === 0) {
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

      if (task.epicId && task.epic?.status === "In Progress") {
        const remainingOpenTasks = await tx.task.count({
          where: {
            epicId: task.epicId,
            parentTaskId: null,
            archivedAt: null,
            deletedAt: null,
            status: { not: "Done" },
          },
        });
        if (remainingOpenTasks === 0) {
          const now = new Date();
          await tx.epic.update({
            where: { id: task.epicId },
            data: { status: "Ready to Deploy", statusChangedAt: now },
          });
          await tx.activityLog.create({
            data: {
              projectId: task.projectId,
              userId: args.actor.id,
              kind: "epic.status",
              payload: JSON.stringify({
                epicId: task.epicId,
                from: task.epic.status,
                to: "Ready to Deploy",
                via: args.via,
                action: "last_task_done",
              }),
            },
          });
          await resetEpicActionPlanForDeployReview(tx, {
            projectId: task.projectId,
            epicId: task.epicId,
            actorId: args.actor.id,
            now,
          });
          promotedEpicToReadyToDeploy = true;
        }
      }
    }

    return { nextAssignments, promotedEpicToReadyToDeploy };
  });

  const nextTasks = completion.nextAssignments.map((assigned) => ({
    id: assigned.task.id,
    title: assigned.task.title,
    projectSlug: assigned.task.project.slug,
  }));
  const nextTask = nextTasks[0] ?? null;

  if (completion.promotedEpicToReadyToDeploy && task.epicId) {
    await triggerDeployReview({ projectSlug: task.project.slug, epicId: task.epicId, actorId: args.actor.id });
  }

  for (const assigned of completion.nextAssignments) {
    await sendTaskWorkflowNotification({
      taskId: assigned.task.id,
      targetUserId: assigned.worker.id,
      actor: args.actor,
      reason: "todo_start_required",
      body: [
        `Previous epic task "${task.title}" was accepted by @${args.actor.username}.`,
        `Next task "${assigned.task.title}" is now assigned to you in To Do.`,
        assigned.approvedPlan
          ? "Its Action Plan is already approved: move the task to In Progress through the workflow endpoint and start immediately."
          : "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
        "If you have unresolved review feedback on another Review-stage task, address that feedback first; otherwise begin this task now.",
      ].join("\n"),
    });
  }

  const previousAssigneeGotNext = completion.nextAssignments.some(
    (assigned) => assigned.worker.id === task.assigneeId,
  );
  if (!previousAssigneeGotNext && task.assigneeId) {
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
    nextTasks,
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
