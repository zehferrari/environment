import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { resolveDoneOwnerId, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { assignOpenEpicTasks, type EpicTaskAssignment } from "@/lib/epics/assignment";
import {
  enqueueEpicDoneCleanup,
  enqueueTaskReviewFinalization,
} from "@/lib/deploy/epic-merge";
import { updateTaskRepositoryState } from "@/lib/tasks/repository-state";

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
  repositoryFinalized?: boolean;
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
      project: {
        select: {
          slug: true,
          repositoryPath: true,
          onlyReportersCanSetTasksDone: true,
        },
      },
      epic: { select: { status: true, actingManagerId: true } },
      repositoryRun: { select: { phase: true, repoTouched: true } },
    },
  });
  if (!task || task.deletedAt) return { completed: false as const, reason: "not_found" as const };
  if (task.status !== "Review") return { completed: false as const, reason: "not_review" as const };

  const reviewerId = resolveReviewOwnerId(task);
  const doneOwnerId = resolveDoneOwnerId(task);
  if (args.requireReviewerUserId && doneOwnerId !== args.requireReviewerUserId) {
    return { completed: false as const, reason: "not_reviewer" as const };
  }

  // Repository-backed tasks are accepted by the reviewer now but remain in
  // Review until the external repository runner publishes/merges, verifies,
  // and removes the local worktree. The runner calls this function again with
  // repositoryFinalized=true to perform the actual Done transition.
  if (task.project.repositoryPath && task.repositoryRun && !args.repositoryFinalized) {
    if (task.repositoryRun?.phase !== "review_ready" && task.repositoryRun?.phase !== "finalizing") {
      return { completed: false as const, reason: "repository_not_ready" as const };
    }
    if (task.repositoryRun.phase !== "finalizing") {
      const finalization = await enqueueTaskReviewFinalization({
        taskId: task.id,
        projectId: task.projectId,
        requestedByUserId: args.actor.id,
        requestedByUsername: args.actor.username,
      });
      if (finalization.blockedByFailedJob) {
        await db.$transaction([
          db.task.update({
            where: { id: task.id },
            data: { alertReporter: true },
          }),
          db.activityLog.create({
            data: {
              projectId: task.projectId,
              taskId: task.id,
              userId: args.actor.id,
              kind: "pm.repo.verify.operational_error",
              payload: JSON.stringify({
                via: args.via,
                error: "A failed repository finalization spool job requires operator recovery.",
              }),
            },
          }),
        ]);
        await updateTaskRepositoryState(task.id, {
          phase: "operational_error",
          validationOutcome: "operational_error",
          lastError: "A failed repository finalization spool job requires operator recovery.",
        });
        return {
          completed: false as const,
          reason: "repository_finalization_job_failed" as const,
        };
      }
      await updateTaskRepositoryState(task.id, {
        phase: "finalizing",
        lastError: null,
      });
      await db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "task.review.accepted",
          payload: JSON.stringify({
            via: args.via,
            commentId: args.commentId ?? null,
            repositoryFinalization: true,
          }),
        },
      });
    }
    return {
      completed: true as const,
      finalizing: true as const,
      status: "Review" as const,
      taskId: task.id,
      projectSlug: task.project.slug,
      nextTask: null,
      nextTasks: [],
    };
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

    let nextAssignments: EpicTaskAssignment[] = [];
    let skipReason: string | null = null;
    let epicRolledToDone = false;

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

      // When the last open child task of an epic reaches Done, the epic itself
      // is Done. (Deployment is a separate, optional post-Done step expressed
      // through the deploymentStatus field — see the epic deployment select —
      // NOT a workflow status, so nothing deploy-related fires here.)
      if (task.epicId && (task.epic?.status === "In Progress" || task.epic?.status === "To Do")) {
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
            data: { status: "Done", statusChangedAt: now },
          });
          await tx.activityLog.create({
            data: {
              projectId: task.projectId,
              userId: args.actor.id,
              kind: "epic.status",
              payload: JSON.stringify({
                epicId: task.epicId,
                from: task.epic.status,
                to: "Done",
                via: args.via,
                action: "last_task_done",
              }),
            },
          });
          epicRolledToDone = true;
        }
      }
    }

    return { nextAssignments, epicRolledToDone };
  });

  // Epic auto-rolled to Done: queue local child-branch cleanup for the
  // pm-epic-merge-runner (P6 — local-only branches + worktrees are removed
  // once merged into the pushed Epic branch). Outside the transaction: the
  // enqueue writes a spool file, and the runner re-checks the Epic is still
  // Done before touching anything.
  if (completion.epicRolledToDone && task.epicId) {
    await enqueueEpicDoneCleanup(task.epicId).catch((err) =>
      console.error("[pm] epic cleanup enqueue failed:", task.epicId, err),
    );
  }

  const nextTasks = completion.nextAssignments.map((assigned) => ({
    id: assigned.task.id,
    title: assigned.task.title,
    projectSlug: assigned.task.project.slug,
  }));
  const nextTask = nextTasks[0] ?? null;

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
    finalizing: false as const,
    status: "Done" as const,
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
