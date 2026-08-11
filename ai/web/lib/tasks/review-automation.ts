import { db } from "@/lib/db";
import { resolveDoneOwnerId, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { assignOpenEpicTasks, type EpicTaskAssignment } from "@/lib/epics/assignment";
import {
  applyTaskTransition,
  enqueueWorkflowEffects,
  type WorkflowEffect,
} from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import {
  applyPmChannelRunWorkflowAction,
  type PmChannelWorkflowActionArgs,
} from "@/lib/agents/pm-channel/runs";

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
  workflowAction?: PmChannelWorkflowActionArgs;
}) {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      workflowVersion: true,
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
      repositoryRun: {
        select: {
          phase: true,
          repoTouched: true,
          baseSha: true,
          candidateSha: true,
          reviewedSha: true,
        },
      },
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
      const candidateSha = task.repositoryRun.repoTouched
        ? task.repositoryRun.candidateSha
        : task.repositoryRun.baseSha;
      if (!candidateSha) {
        return { completed: false as const, reason: "repository_candidate_missing" as const };
      }
      const reviewRun = await db.reviewRun.findUnique({
        where: { taskId_candidateSha: { taskId: task.id, candidateSha } },
        select: { id: true, status: true },
      });
      if (!reviewRun || reviewRun.status !== "awaiting_review") {
        return { completed: false as const, reason: "candidate_not_awaiting_review" as const };
      }
      const acceptedAt = new Date();
      const accepted = await db.$transaction(async (tx) => {
        const claimed = await tx.reviewRun.updateMany({
          where: { id: reviewRun.id, status: "awaiting_review" },
          data: { status: "accepted", reviewerId: args.actor.id, reviewedAt: acceptedAt },
        });
        if (claimed.count !== 1) return false;
        await tx.taskRepositoryRun.update({
          where: { taskId: task.id },
          data: {
            phase: "finalizing",
            reviewedSha: candidateSha,
            lastError: null,
            version: { increment: 1 },
          },
        });
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: args.actor.id,
            kind: "task.review.accepted",
            payload: JSON.stringify({
              via: args.via,
              commentId: args.commentId ?? null,
              repositoryFinalization: true,
              reviewRunId: reviewRun.id,
              candidateSha,
            }),
          },
        });
        await enqueueWorkflowEffects(tx, {
          taskId: task.id,
          projectId: task.projectId,
          aggregateVersion: task.workflowVersion,
          effects: [
            {
              type: "review_finalize",
              key: `review-finalize:${candidateSha}`,
              payload: {
                taskId: task.id,
                projectId: task.projectId,
                requestedByUserId: args.actor.id,
                requestedByUsername: args.actor.username,
                candidateSha,
              },
            },
            { type: "board_touch", key: `board-finalizing:${candidateSha}`, payload: {} },
          ],
        });
        if (args.workflowAction) {
          await applyPmChannelRunWorkflowAction(tx, {
            ...args.workflowAction,
            taskState: "Review",
          });
        }
        return true;
      });
      if (!accepted) {
        return { completed: false as const, reason: "candidate_already_reviewed" as const };
      }
      await drainWorkflowOutbox({ limit: 2 }).catch((error) =>
        console.error("[pm] finalization workflow outbox drain deferred:", task.id, error),
      );
    } else if (args.workflowAction) {
      // Exact replay after the acceptance transaction: the durable ReviewRun,
      // repository phase, and finalization outbox already own the work. Settle
      // any still-live copy of the same reviewer turn without enqueueing a
      // second finalization effect.
      await db.$transaction((tx) => applyPmChannelRunWorkflowAction(tx, {
        ...args.workflowAction!,
        taskState: "Review",
      }));
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
    const transition = await applyTaskTransition(tx, {
      taskId: task.id,
      projectId: task.projectId,
      actorUserId: args.actor.id,
      intent: "accept_review",
      from: "Review",
      to: "Done",
      source: args.via,
      idempotencyKey: `review-done:${args.workflowAction?.messageId ?? args.commentId ?? `${args.via}:v${task.workflowVersion + 1}`}`,
      evidence: {
        commentId: args.commentId ?? null,
        repositoryFinalized: args.repositoryFinalized ?? false,
        reviewedSha: task.repositoryRun?.reviewedSha ?? null,
      },
    });

    let nextAssignments: EpicTaskAssignment[] = [];
    let skipReason: string | null = null;
    let epicRolledToReview = false;

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

      // The last accepted child does NOT complete the Epic. It freezes the
      // implementation boundary by moving the Epic to Review; the repository
      // runner must publish and validate the combined candidate before waking
      // the configured Deploy Reviewer (or Monitor fallback). Done is reserved
      // for a passing whole-Epic acceptance review.
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
            data: {
              status: "Review",
              statusChangedAt: now,
              completionReviewStatus: "Preparing",
              completionReviewCandidateSha: null,
              completionReviewRequestedAt: null,
              completionReviewCompletedAt: null,
              completionReviewLastError: null,
            },
          });
          await tx.activityLog.create({
            data: {
              projectId: task.projectId,
              userId: args.actor.id,
              kind: "epic.status",
              payload: JSON.stringify({
                epicId: task.epicId,
                from: task.epic.status,
                to: "Review",
                via: args.via,
                action: "completion_review_required",
              }),
            },
          });
          epicRolledToReview = true;
        }
      }
    }

    const effects: WorkflowEffect[] = [
      { type: "board_touch", key: "board-done", payload: {} },
    ];
    // Whole-Epic candidate preparation is an external repository effect. Keep
    // it in ENV-118's durable outbox so the Task Done transition and the
    // obligation to prepare acceptance either commit together or not at all.
    if (epicRolledToReview && task.epicId) {
      effects.push({
        type: "epic_completion_review",
        key: `epic-completion-review:${task.epicId}`,
        payload: { epicId: task.epicId },
      });
    }
    for (const assigned of nextAssignments) {
      effects.push({
        type: "task_notification",
        key: `next-task:${assigned.task.id}:${assigned.worker.id}`,
        payload: {
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
        },
      });
    }
    const previousAssigneeGotNext = nextAssignments.some(
      (assigned) => assigned.worker.id === task.assigneeId,
    );
    if (!previousAssigneeGotNext && task.assigneeId) {
      effects.push({
        type: "task_notification",
        key: `review-done:${task.assigneeId}`,
        payload: {
          taskId: task.id,
          targetUserId: task.assigneeId,
          actor: args.actor,
          reason: "review_done",
          body: [
            `Task "${task.title}" was reviewed and moved to Done by @${args.actor.username}.`,
            "No further action is required unless the task is reopened.",
          ].join("\n"),
        },
      });
    }
    await enqueueWorkflowEffects(tx, {
      taskId: task.id,
      projectId: task.projectId,
      aggregateVersion: transition.transition.workflowVersion,
      transitionId: transition.transition.id,
      effects,
    });
    if (args.workflowAction) {
      await applyPmChannelRunWorkflowAction(tx, {
        ...args.workflowAction,
        taskState: "Done",
      });
    }
    return { nextAssignments, epicRolledToReview, effectCount: effects.length };
  });
  await drainWorkflowOutbox({ limit: completion.effectCount }).catch((error) =>
    console.error("[pm] completion workflow outbox drain deferred:", task.id, error),
  );

  const nextTasks = completion.nextAssignments.map((assigned) => ({
    id: assigned.task.id,
    title: assigned.task.title,
    projectSlug: assigned.task.project.slug,
  }));
  const nextTask = nextTasks[0] ?? null;

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
