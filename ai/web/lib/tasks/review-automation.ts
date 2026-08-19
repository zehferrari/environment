import { recordLegacyWorkflowBoundaryInvocation } from "@/lib/tasks/legacy-workflow-boundary";
import { db } from "@/lib/db";
import { canSetTaskDoneForActor, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
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
import { repositoryFinalizationOwnsTask } from "@/lib/tasks/repository-finalization";
import { recordWorkflowActionExecutionState } from "@/lib/agents/watchdog/transitions";

export type FinalizationProcedureCallback = {
  procedureRunId: string;
  procedureStepId: string;
  workflowCycleId: string | null;
  jobId: string;
};

// ORCH-07/P0-4: apply a finalization callback to a waiting procedure step.
// Called after the legacy finalization completes. If a procedure step is in
// waiting_callback for this task, applies the callback so the procedure
// engine can continue (verify_finalization → complete_review → Done).
export async function applyFinalizationCallbackToProcedure(
  taskId: string,
  candidateSha: string | null,
  ok: boolean,
  mergeSha?: string | null,
  error?: string,
  callback?: FinalizationProcedureCallback,
): Promise<void> {
  const step = callback
    ? await db.taskProcedureStep.findFirst({
        where: {
          id: callback.procedureStepId,
          procedureRunId: callback.procedureRunId,
          procedureRun: { taskId },
        },
        select: {
          id: true,
          procedureRunId: true,
          output: true,
          procedureRun: { select: { taskId: true, workflowCycleId: true } },
        },
      })
    : await db.taskProcedureStep.findFirst({
        where: {
          status: "waiting_callback",
          procedureRun: { taskId },
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          procedureRunId: true,
          output: true,
          procedureRun: { select: { taskId: true, workflowCycleId: true } },
        },
      });
  if (!step) {
    if (callback) {
      const task = await db.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
      if (task) {
        await db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId,
            kind: "task.workflow.procedure_callback_rejected",
            payload: JSON.stringify({ ...callback, candidateSha, reason: "Exact finalization procedure step not found for callback." }),
          },
        });
      }
    }
    return;
  }
  let jobId = callback?.jobId ?? "unknown";
  if (step.output) {
    try {
      const parsed = JSON.parse(step.output) as Record<string, unknown>;
      if (!callback && typeof parsed.jobId === "string") jobId = parsed.jobId;
    } catch { /* ignore */ }
  }
  const { applyProcedureCallback } = await import("@/lib/tasks/orchestrator/procedure-runner");
  const result = await applyProcedureCallback({
    procedureRunId: step.procedureRunId,
    stepId: step.id,
    taskId: step.procedureRun.taskId,
    workflowCycleId: callback?.workflowCycleId ?? step.procedureRun.workflowCycleId,
    jobId,
    candidateSha,
    data: { finalizationOk: ok, mergeSha: mergeSha ?? undefined, error: error ?? undefined },
  });
  if (!result.applied) {
    const task = await db.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
    if (task) {
      await db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId,
          kind: "task.workflow.procedure_callback_rejected",
          payload: JSON.stringify({
            procedureRunId: step.procedureRunId,
            procedureStepId: step.id,
            workflowCycleId: callback?.workflowCycleId ?? step.procedureRun.workflowCycleId,
            jobId,
            candidateSha,
            reason: result.reason,
          }),
        },
      });
    }
  }
}

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
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "review-decision-and-finalization",
    entryPoint: "completeReviewedTaskAndAssignNext",
  });
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      workflowVersion: true,
      activeWorkflowCycleId: true,
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
          validationOutcome: true,
          version: true,
        },
      },
    },
  });
  if (!task || task.deletedAt) return { completed: false as const, reason: "not_found" as const };
  if (task.status !== "Review") return { completed: false as const, reason: "not_review" as const };

  const reviewerId = resolveReviewOwnerId(task);
  let completionActor = args.actor;

  // Repository publication/cleanup is mechanical work, not review authority.
  // Recover the accepted review principal so a monitor executing cleanup can
  // never become the author of the eventual Done transition.
  if (args.repositoryFinalized && task.project.repositoryPath && task.repositoryRun) {
    const acceptedCandidate = task.repositoryRun.reviewedSha
      ?? (task.repositoryRun.repoTouched
        ? task.repositoryRun.candidateSha
        : task.repositoryRun.baseSha);
    if (!acceptedCandidate) {
      return { completed: false as const, reason: "repository_candidate_missing" as const };
    }
    const acceptedReview = await db.reviewRun.findFirst({
      where: task.activeWorkflowCycleId
        ? { workflowCycleId: task.activeWorkflowCycleId, candidateSha: acceptedCandidate }
        : { taskId: task.id, workflowCycleId: null, candidateSha: acceptedCandidate },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        reviewerId: true,
      },
    });
    if (
      !acceptedReview
      || (acceptedReview.status !== "accepted" && acceptedReview.status !== "completed")
      || !acceptedReview.reviewerId
    ) {
      return { completed: false as const, reason: "candidate_not_accepted" as const };
    }
    const acceptedReviewer = await db.user.findUnique({
      where: { id: acceptedReview.reviewerId },
      select: { id: true, username: true, kind: true },
    });
    if (
      !acceptedReviewer
      || (acceptedReviewer.kind !== "human" && acceptedReviewer.kind !== "agent")
    ) {
      return { completed: false as const, reason: "candidate_not_accepted" as const };
    }
    completionActor = {
      id: acceptedReviewer.id,
      username: acceptedReviewer.username,
      kind: acceptedReviewer.kind,
    };
  }

  if (!canSetTaskDoneForActor(task, completionActor.id)) {
    return { completed: false as const, reason: "not_reviewer" as const };
  }
  if (args.requireReviewerUserId && completionActor.id !== args.requireReviewerUserId) {
    return { completed: false as const, reason: "not_reviewer" as const };
  }

  // Repository-backed tasks are accepted by the reviewer now but remain in
  // Review until the external repository runner publishes/merges, verifies,
  // and removes the local worktree. The runner calls this function again with
  // repositoryFinalized=true to perform the actual Done transition.
  if (task.project.repositoryPath && task.repositoryRun && !args.repositoryFinalized) {
    const acceptedCandidate = task.repositoryRun.repoTouched
      ? task.repositoryRun.candidateSha
      : task.repositoryRun.baseSha;
    if (task.repositoryRun.phase === "operational_error" && repositoryFinalizationOwnsTask(task.repositoryRun)) {
      if (!acceptedCandidate) {
        return { completed: false as const, reason: "repository_candidate_missing" as const };
      }
      const acceptedReview = await db.reviewRun.findFirst({
        where: task.activeWorkflowCycleId
          ? { workflowCycleId: task.activeWorkflowCycleId, candidateSha: acceptedCandidate }
          : { taskId: task.id, workflowCycleId: null, candidateSha: acceptedCandidate },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, validationOutcome: true },
      });
      if (!acceptedReview || acceptedReview.status !== "accepted") {
        return { completed: false as const, reason: "candidate_not_accepted" as const };
      }
      const retryVersion = task.repositoryRun.version + 1;
      const retryQueued = await db.$transaction(async (tx) => {
        const claimed = await tx.taskRepositoryRun.updateMany({
          where: {
            taskId: task.id,
            phase: "operational_error",
            version: task.repositoryRun!.version,
            reviewedSha: acceptedCandidate,
          },
          data: {
            phase: "finalizing",
            validationOutcome: acceptedReview.validationOutcome === "valid_with_warning"
              ? "valid_with_warning"
              : "valid",
            lastError: null,
            version: { increment: 1 },
          },
        });
        if (claimed.count !== 1) return false;
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: args.actor.id,
            kind: "task.review.finalization_retry",
            payload: JSON.stringify({
              via: args.via,
              reviewRunId: acceptedReview.id,
              candidateSha: acceptedCandidate,
              repositoryVersion: retryVersion,
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
              key: `review-finalize-retry:${acceptedCandidate}:r${retryVersion}`,
              payload: {
                taskId: task.id,
                projectId: task.projectId,
                requestedByUserId: args.actor.id,
                requestedByUsername: args.actor.username,
                candidateSha: acceptedCandidate,
                workflowCycleId: task.activeWorkflowCycleId,
              },
            },
            { type: "board_touch", key: `board-finalization-retry:${acceptedCandidate}:r${retryVersion}`, payload: {} },
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
      if (retryQueued) {
        await drainWorkflowOutbox({ limit: 2 }).catch((error) =>
          console.error("[pm] finalization retry outbox drain deferred:", task.id, error),
        );
      } else {
        const currentRepository = await db.taskRepositoryRun.findUnique({
          where: { taskId: task.id },
          select: { phase: true, reviewedSha: true },
        });
        if (
          !currentRepository ||
          currentRepository.reviewedSha !== acceptedCandidate ||
          (currentRepository.phase !== "finalizing" && currentRepository.phase !== "completed")
        ) {
          return { completed: false as const, reason: "finalization_retry_conflict" as const };
        }
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
    if (task.repositoryRun.phase !== "review_ready" && task.repositoryRun.phase !== "finalizing") {
      return { completed: false as const, reason: "repository_not_ready" as const };
    }
    if (task.repositoryRun.phase !== "finalizing") {
      const candidateSha = task.repositoryRun.repoTouched
        ? task.repositoryRun.candidateSha
        : task.repositoryRun.baseSha;
      if (!candidateSha) {
        return { completed: false as const, reason: "repository_candidate_missing" as const };
      }
      const reviewRun = await db.reviewRun.findFirst({
        where: task.activeWorkflowCycleId
          ? { workflowCycleId: task.activeWorkflowCycleId, candidateSha }
          : { taskId: task.id, workflowCycleId: null, candidateSha },
        orderBy: { createdAt: "desc" },
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
                workflowCycleId: task.activeWorkflowCycleId,
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
      actorUserId: completionActor.id,
      intent: "accept_review",
      from: "Review",
      to: "Done",
      source: args.via,
      idempotencyKey: `review-done:${args.workflowAction?.messageId ?? args.commentId ?? `${args.via}:v${task.workflowVersion + 1}`}`,
      evidence: {
        commentId: args.commentId ?? null,
        repositoryFinalized: args.repositoryFinalized ?? false,
        reviewedSha: task.repositoryRun?.reviewedSha ?? null,
        finalizedByUserId: args.repositoryFinalized ? args.actor.id : null,
        finalizedByUsername: args.repositoryFinalized ? args.actor.username : null,
      },
      taskData: { alertReporter: false },
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
        actorUserId: completionActor.id,
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
          userId: completionActor.id,
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
              userId: completionActor.id,
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
          actor: completionActor,
          reason: "todo_start_required",
          body: [
            `Previous epic task "${task.title}" was accepted by @${completionActor.username}.`,
            `Next task "${assigned.task.title}" is now assigned to you in To Do.`,
            assigned.approvedPlan
              ? "Its Action Plan is already approved: move the task to In Progress through the workflow endpoint and start immediately."
              : "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. A plain chat reply is discussion only.",
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
          actor: completionActor,
          reason: "review_done",
          body: [
            `Task "${task.title}" was reviewed and moved to Done by @${completionActor.username}.`,
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
  await recordWorkflowActionExecutionState({
    taskId: task.id,
    projectId: task.projectId,
    action: "review_done",
    status: "Done",
  });

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
  await recordLegacyWorkflowBoundaryInvocation({
    legacyBoundary: "review-decision-and-finalization",
    entryPoint: "tryCompleteTaskFromReviewerComment",
  });
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
