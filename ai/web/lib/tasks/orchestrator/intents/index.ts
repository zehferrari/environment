import {
  createChecklistAndDelegatableTasksFromPlan,
  markActionPlanRevisionRequired,
  persistActionPlan,
} from "@/lib/tasks/action-plan-store";
import {
  createSubTaskItem,
  deleteSubTaskItem,
  setSubTaskCompletion,
} from "@/lib/tasks/subtasks";
import type { TaskWorkflowIntent } from "@/lib/tasks/orchestrator/types";
import type {
  IntentExecutor,
  IntentExecutorRegistry,
  IntentExecutorContext,
} from "@/lib/tasks/orchestrator/intents/types";
import {
  activityPayloadUsesCheckpointAuthorization,
  validateCheckpointAuthorizationText,
} from "@/lib/deploy/checkpoint-authorization";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";
import { assignOpenEpicTasks } from "@/lib/epics/assignment";
import { isActiveOwnerPrincipal } from "@/lib/auth/roles";
import type { Prisma } from "@prisma/client";

async function executeRegisteredIntent<I extends TaskWorkflowIntent>(
  context: IntentExecutorContext<I>,
) {
  return context.helpers.executeDecisionWrites();
}

async function createWorkflowComment<I extends TaskWorkflowIntent>(
  context: IntentExecutorContext<I>,
  body: string,
  commentKind = "workflow_action",
  isGenerated = false,
) {
  return context.tx.comment.create({
    data: {
      taskId: context.command.taskId,
      userId: context.decision.decisionActorId,
      body,
      authorAgentSlug: context.command.actor.kind === "agent"
        ? context.command.actor.username ?? null
        : null,
      commentKind,
      isGenerated,
      runId: context.command.executionContext?.pmChannelRunId ?? null,
    },
    select: { id: true },
  });
}

async function createDomainActivity<I extends TaskWorkflowIntent>(
  context: IntentExecutorContext<I>,
  kind: string,
  payload: Record<string, unknown>,
) {
  await context.tx.activityLog.create({
    data: {
      projectId: context.state.projectId,
      taskId: context.command.taskId,
      userId: context.decision.decisionActorId,
      kind,
      targetAgent: context.command.actor.kind === "agent"
        ? context.command.actor.username ?? null
        : null,
      payload: JSON.stringify({ action: context.command.intent, ...payload }),
    },
  });
}

const submitPlanExecutor: IntentExecutor<"submit_plan"> = async (context) => {
  const plan = await persistActionPlan({
    taskId: context.command.taskId,
    input: context.command.payload.actionPlan,
    authorId: context.decision.decisionActorId,
    sourceRunId: context.command.executionContext?.pmChannelRunId ?? null,
    sourceMessageId: context.command.messageId ?? context.command.payload.inReplyToMessageId ?? null,
    client: context.tx,
  });
  // Plan revisions do not advance workflowVersion. Scope the reviewer wake
  // to the revision persisted in this transaction, or a delivered first-plan
  // effect suppresses every subsequent revision while the task is in Backlog.
  context.decision.effects = context.decision.effects.map((effect) =>
    effect.type === "task_notification" && effect.payload.reason === "action_plan_review_requested"
      ? { ...effect, key: `${effect.key}:plan:${plan.id}:revision:${plan.version}` }
      : effect,
  );
  return context.helpers.executeDecisionWrites();
};

const approvePlanExecutor: IntentExecutor<"approve_plan"> = async (context) => {
  const approvedAt = context.decision.taskData?.approvedOn instanceof Date
    ? context.decision.taskData.approvedOn
    : new Date();
  const changed = await context.tx.actionPlan.updateMany({
    where: {
      id: context.command.payload.actionPlanId,
      taskId: context.command.taskId,
      version: context.command.payload.actionPlanVersion,
      status: { in: ["draft", "revision_required"] },
    },
    data: {
      status: "approved",
      approvedOn: approvedAt,
      approvedById: context.decision.decisionActorId,
    },
  });
  if (changed.count !== 1) throw new Error("action_plan_version_conflict");
  await context.tx.actionPlanRevision.updateMany({
    where: {
      actionPlanId: context.command.payload.actionPlanId,
      version: context.command.payload.actionPlanVersion,
      status: "draft",
    },
    data: {
      status: "approved",
      approvedOn: approvedAt,
      approvedById: context.decision.decisionActorId,
    },
  });
  await createChecklistAndDelegatableTasksFromPlan({
    taskId: context.command.taskId,
    approvedAt,
    approvedById: context.decision.decisionActorId,
    client: context.tx,
  });
  await createDomainActivity(context, "task.action_plan.approve", {
    actionPlanId: context.command.payload.actionPlanId,
    actionPlanVersion: context.command.payload.actionPlanVersion,
  });
  return context.helpers.executeDecisionWrites();
};

const requestPlanChangesExecutor: IntentExecutor<"request_plan_changes"> = async (context) => {
  const changed = await context.tx.actionPlan.updateMany({
    where: {
      id: context.command.payload.actionPlanId,
      taskId: context.command.taskId,
      version: context.command.payload.actionPlanVersion,
    },
    data: { status: "revision_required", approvedOn: null, approvedById: null },
  });
  if (changed.count !== 1) throw new Error("action_plan_version_conflict");
  await context.tx.actionPlanRevision.updateMany({
    where: {
      actionPlanId: context.command.payload.actionPlanId,
      version: context.command.payload.actionPlanVersion,
      status: "draft",
    },
    data: { status: "revision_required" },
  });
  await createWorkflowComment(context, context.command.payload.reviewerComment);
  context.decision.effects = context.decision.effects.map((effect) => effect.type === "task_notification"
    ? { ...effect, key: `${effect.key}:plan:${context.command.payload.actionPlanId}:revision:${context.command.payload.actionPlanVersion}`,
        payload: { ...effect.payload, reason: "action_plan_feedback_received", body: `Revise the current Action Plan to address this consolidated feedback, then submit the new revision.\n\n${context.command.payload.reviewerComment}` } }
    : effect);
  return context.helpers.executeDecisionWrites();
};

const submitForReviewExecutor: IntentExecutor<"submit_for_review"> = async (context) => {
  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      workflowCycleId: context.state.activeWorkflowCycleId,
      ...(context.command.payload.candidateSha
        ? { candidateSha: context.command.payload.candidateSha }
        : {}),
      ...(context.command.payload.baseSha
        ? { baseSha: context.command.payload.baseSha }
        : {}),
      repoTouched: context.command.payload.repoTouched,
      validationOutcome: null,
      phase: "validating",
      lastError: null,
      version: { increment: 1 },
    },
  });
  if (context.command.payload.comment) {
    await createWorkflowComment(context, context.command.payload.comment);
  }
  return context.helpers.executeDecisionWrites();
};

async function supersedeCycleMechanicalWork(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    workflowCycleId: string;
    reason: string;
    procedureTypes?: string[];
    effectTypes?: string[];
    invalidateReview?: boolean;
    markRepositoryActionRequired?: boolean;
  },
) {
  const now = new Date();
  const runs = await tx.taskProcedureRun.findMany({
    where: {
      taskId: args.taskId,
      workflowCycleId: args.workflowCycleId,
      status: { in: ["queued", "running", "operational_error"] },
      ...(args.procedureTypes ? { type: { in: args.procedureTypes } } : {}),
    },
    select: { id: true },
  });
  const runIds = runs.map((run) => run.id);
  const output = JSON.stringify({ superseded: true, reason: args.reason });
  if (runIds.length > 0) {
    await tx.taskProcedureStep.updateMany({
      where: {
        procedureRunId: { in: runIds },
        status: { in: ["pending", "running", "failed", "waiting_callback"] },
      },
      data: {
        status: "superseded",
        leaseOwner: null,
        leaseExpiresAt: null,
        output,
        lastError: args.reason,
        completedAt: now,
      },
    });
    await tx.taskProcedureRun.updateMany({
      where: { id: { in: runIds } },
      data: {
        status: "superseded",
        currentStep: null,
        output,
        lastError: args.reason,
        completedAt: now,
      },
    });
  }
  await tx.workflowOutbox.updateMany({
    where: {
      taskId: args.taskId,
      workflowCycleId: args.workflowCycleId,
      status: { in: ["queued", "dispatching"] },
      ...(args.effectTypes ? { effectType: { in: args.effectTypes } } : {}),
    },
    data: {
      status: "completed",
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      lastError: args.reason,
    },
  });
  if (args.invalidateReview) {
    await tx.reviewRun.updateMany({
      where: {
        taskId: args.taskId,
        workflowCycleId: args.workflowCycleId,
        status: { in: ["awaiting_review", "accepted"] },
      },
      data: {
        status: "invalidated",
        invalidatedAt: now,
        invalidatedReason: args.reason,
      },
    });
  }
  if (args.markRepositoryActionRequired) {
    await tx.taskRepositoryRun.updateMany({
      where: { taskId: args.taskId, workflowCycleId: args.workflowCycleId },
      data: {
        phase: "action_required",
        lastError: args.reason,
        version: { increment: 1 },
      },
    });
  }
}

const requestReviewChangesExecutor: IntentExecutor<"request_review_changes"> = async (context) => {
  if (
    context.state.activeReviewRun?.status === "accepted" &&
    context.state.activeWorkflowCycleId
  ) {
    const reason = "Superseded by a later human reviewer request for changes.";
    await supersedeCycleMechanicalWork(context.tx, {
      taskId: context.command.taskId,
      workflowCycleId: context.state.activeWorkflowCycleId,
      reason,
      procedureTypes: ["finalize_accepted_review"],
      effectTypes: ["review_finalize"],
    });
  }
  await createWorkflowComment(context, context.command.payload.reviewerComment);
  return context.helpers.executeDecisionWrites();
};

const startImplementationExecutor: IntentExecutor<"start_implementation"> = async (context) => {
  // TaskRepositoryRun is the mutable projection for the active cycle. The
  // immutable candidate/review evidence remains on the closed workflow cycle
  // and ReviewRun, so never carry those pointers into a new implementation
  // pass. Otherwise a resubmission with no client-provided SHA can validate
  // the previous cycle's candidate while the verifier creates a newer commit.
  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      candidateSha: null,
      reviewedSha: null,
      validationOutcome: null,
      phase: "active",
      lastError: null,
      version: { increment: 1 },
    },
  });
  if (context.state.epicId && context.state.epic?.status === "To Do") {
    const promoted = await context.tx.epic.updateMany({
      where: { id: context.state.epicId, status: "To Do" },
      data: { status: "In Progress", statusChangedAt: new Date() },
    });
    if (promoted.count === 1) {
      await context.tx.activityLog.create({
        data: {
          projectId: context.state.projectId,
          userId: context.decision.decisionActorId,
          kind: "epic.status",
          payload: JSON.stringify({
            epicId: context.state.epicId,
            from: "To Do",
            to: "In Progress",
            via: context.command.source === "pm-service" ? "pm-policy-start" : "task-start",
            taskId: context.command.taskId,
          }),
        },
      });
    }
  }
  return context.helpers.executeDecisionWrites();
};

const checkpointExecutor: IntentExecutor<"checkpoint"> = (context) =>
  context.helpers.executeDecisionWrites();

const acceptReviewExecutor: IntentExecutor<"accept_review"> = async (context) => {
  const reviewerComment = typeof context.command.evidence?.reviewerComment === "string"
    ? context.command.evidence.reviewerComment.trim()
    : "";
  if (reviewerComment) await createWorkflowComment(context, reviewerComment);
  return context.helpers.executeDecisionWrites();
};

const worktreeRevalidationFailedExecutor: IntentExecutor<"worktree_revalidation_failed"> = (context) =>
  context.helpers.executeDecisionWrites();

const repositoryValidationSucceededExecutor: IntentExecutor<"repository_validation_succeeded"> = async (context) => {
  const cycleId = context.state.activeWorkflowCycleId;
  const candidateSha = context.command.payload.candidateSha
    ?? context.state.repositoryRun?.candidateSha
    ?? null;
  if (!cycleId || !candidateSha) throw new Error("repository_validation_missing_candidate");

  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      workflowCycleId: cycleId,
      candidateSha,
      baseSha: context.command.payload.baseSha ?? context.state.repositoryRun?.baseSha ?? null,
      validationOutcome: "succeeded",
      phase: "review",
      lastError: null,
      version: { increment: 1 },
    },
  });
  await context.tx.reviewRun.updateMany({
    where: {
      taskId: context.command.taskId,
      status: "awaiting_review",
      NOT: { workflowCycleId: cycleId },
    },
    data: {
      status: "invalidated",
      invalidatedAt: new Date(),
      invalidatedReason: "A newer workflow cycle produced a validated candidate.",
    },
  });
  const existing = await context.tx.reviewRun.findUnique({
    where: { workflowCycleId: cycleId },
    select: { candidateSha: true },
  });
  if (existing && existing.candidateSha !== candidateSha) {
    throw new Error("review_lease_candidate_conflict");
  }
  if (!existing) {
    await context.tx.reviewRun.create({
      data: {
        taskId: context.command.taskId,
        workflowCycleId: cycleId,
        candidateSha,
        baseSha: context.command.payload.baseSha ?? context.state.repositoryRun?.baseSha ?? null,
        repoTouched: context.state.repositoryRun?.repoTouched ?? true,
        validationOutcome: "succeeded",
        status: "awaiting_review",
      },
    });
  }
  return context.helpers.executeDecisionWrites();
};

const repositoryValidationFailedExecutor: IntentExecutor<"repository_validation_failed"> = async (context) => {
  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      validationOutcome: "failed",
      phase: "active",
      lastError: context.command.payload.failureReason ?? "Repository validation failed.",
      version: { increment: 1 },
    },
  });
  return context.helpers.executeDecisionWrites();
};

const repositoryFinalizationSucceededExecutor: IntentExecutor<"repository_finalization_succeeded"> = async (context) => {
  const candidateSha = context.command.payload.candidateSha
    ?? context.state.activeReviewRun?.candidateSha
    ?? context.state.repositoryRun?.candidateSha
    ?? null;
  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      candidateSha,
      reviewedSha: candidateSha,
      phase: "completed",
      lastError: null,
      version: { increment: 1 },
    },
  });

  // Keep Epic queue refill and the whole-Epic acceptance handoff inside the
  // authoritative completion command. The current task is still Review at
  // this point, so the last-child query explicitly excludes it.
  const task = await context.tx.task.findUniqueOrThrow({
    where: { id: context.command.taskId },
    select: {
      title: true,
      epicId: true,
      assigneeId: true,
      reporterId: true,
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  const assignment = task.epicId
    ? await assignOpenEpicTasks(context.tx, {
        epicId: task.epicId,
        projectId: context.state.projectId,
        actorUserId: context.decision.decisionActorId,
        excludeUserIds: [
          context.state.resolvedReviewOwnerId,
          task.reporterId,
          task.epic?.actingManagerId,
        ],
        via: "orchestrator_v2:repository_finalization_succeeded",
        notificationContextLine: `Previous Epic task "${task.title}" was accepted.`,
        trigger: { kind: "policy_event", id: context.command.idempotencyKey },
      })
    : { assignments: [], skipped: "no_epic" as const };

  let epicRolledToReview = false;
  if (assignment.assignments.length === 0) {
    await createDomainActivity(context, "task.workflow.next_assignment_skipped", {
      reason: assignment.skipped,
      epicId: task.epicId,
    });
    if (task.epicId && (task.epic?.status === "In Progress" || task.epic?.status === "To Do")) {
      const remainingOpenTasks = await context.tx.task.count({
        where: {
          epicId: task.epicId,
          id: { not: context.command.taskId },
          parentTaskId: null,
          archivedAt: null,
          deletedAt: null,
          status: { not: "Done" },
        },
      });
      if (remainingOpenTasks === 0) {
        const promoted = await context.tx.epic.updateMany({
          where: { id: task.epicId, status: task.epic.status },
          data: {
            status: "Review",
            statusChangedAt: new Date(),
            completionReviewStatus: "Preparing",
            completionReviewCandidateSha: null,
            completionReviewRequestedAt: null,
            completionReviewCompletedAt: null,
            completionReviewLastError: null,
          },
        });
        if (promoted.count !== 1) throw new Error("epic_completion_review_conflict");
        await context.tx.activityLog.create({
          data: {
            projectId: context.state.projectId,
            userId: context.decision.decisionActorId,
            kind: "epic.status",
            payload: JSON.stringify({
              epicId: task.epicId,
              from: task.epic.status,
              to: "Review",
              via: "orchestrator_v2:repository_finalization_succeeded",
              action: "completion_review_required",
            }),
          },
        });
        epicRolledToReview = true;
      }
    }
  }

  const completionEffects = [];
  if (epicRolledToReview && task.epicId) {
    completionEffects.push({
      type: "epic_completion_review" as const,
      key: `epic-completion-review:${task.epicId}`,
      payload: { epicId: task.epicId },
    });
  }
  const previousAssigneeGotNext = assignment.assignments.some(
    (assigned) => assigned.worker.id === task.assigneeId,
  );
  if (!previousAssigneeGotNext && task.assigneeId) {
    completionEffects.push({
      type: "task_notification" as const,
      key: `review-done:${task.assigneeId}`,
      payload: {
        taskId: context.command.taskId,
        targetUserId: task.assigneeId,
        actor: context.command.actor,
        reason: "review_done",
        body: `Task "${task.title}" was reviewed and moved to Done. No further action is required unless it is reopened.`,
      },
    });
  }
  if (completionEffects.length > 0) {
    await enqueueWorkflowEffects(context.tx, {
      taskId: context.command.taskId,
      projectId: context.state.projectId,
      aggregateVersion: context.state.workflowVersion + 1,
      workflowCycleId: context.state.activeWorkflowCycleId,
      effects: completionEffects,
    });
  }
  return context.helpers.executeDecisionWrites();
};

const repositoryFinalizationFailedExecutor: IntentExecutor<"repository_finalization_failed"> = async (context) => {
  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      phase: "operational_error",
      lastError: context.command.payload.failureReason ?? "Repository finalization failed.",
      version: { increment: 1 },
    },
  });
  return context.helpers.executeDecisionWrites();
};

const raiseBlockerExecutor: IntentExecutor<"raise_blocker"> = async (context) => {
  const report = context.command.payload.blockerReport;
  const activeBlocker = context.state.activeBlocker;
  if (activeBlocker) {
    const samePermissionRound = Boolean(
      context.command.payload.permissionKind &&
      activeBlocker.permissionRequest?.kind === context.command.payload.permissionKind &&
      activeBlocker.permissionRequest.scope === (context.command.payload.permissionScope ?? report.requestedAction) &&
      !activeBlocker.permissionGrant?.authorizationCommentId,
    );
    if (samePermissionRound) {
      // Record the exact command receipt/episode disposition without creating
      // a second blocker comment or replacing the active permission round.
      return context.helpers.executeDecisionWrites();
    }
    return {
      status: "stale",
      reason: "An active blocker round must be cleared before another blocker can be raised.",
      domainCode: "cycle_mismatch",
    };
  }
  const comment = await createWorkflowComment(
    context,
    context.command.payload.comment ?? [
      `Blocked on ${report.blockedOn}: ${report.requestedActor ?? "external decision owner"}`,
      report.requestedAction,
      `Resume when: ${report.resumeCondition}`,
    ].join("\n\n"),
    "blocker_notice",
  );
  const permissionRequest = context.command.payload.permissionKind
    ? {
        kind: context.command.payload.permissionKind,
        scope: context.command.payload.permissionScope ?? report.requestedAction,
      }
    : null;
  await createDomainActivity(context, "task.blocker", {
    commentId: comment.id,
    permissionRequest,
    blockerReport: report,
  });
  await context.tx.task.update({
    where: { id: context.command.taskId },
    data: { alertReporter: true },
  });
  return context.helpers.executeDecisionWrites();
};

const clearBlockerExecutor: IntentExecutor<"clear_blocker"> = async (context) => {
  const comment = await createWorkflowComment(context, context.command.payload.resolution);
  const newerIndependentAlert = context.state.activeBlocker?.raisedAt
    ? await context.tx.activityLog.findFirst({
        where: {
          taskId: context.command.taskId,
          kind: "task.alert_reporter",
          createdAt: { gt: context.state.activeBlocker.raisedAt },
          payload: { contains: '"to":true' },
        },
        select: { id: true },
      })
    : null;
  const preserveIndependentAlert = context.state.repositoryRun?.phase === "operational_error" || Boolean(newerIndependentAlert);
  await createDomainActivity(context, "task.blocker.cleared", {
    commentId: comment.id,
    blockerId: context.command.payload.blockerId,
    resolution: context.command.payload.resolution,
    preserveIndependentAlert,
  });
  await context.tx.task.update({
    where: { id: context.command.taskId },
    data: { alertReporter: preserveIndependentAlert },
  });
  return context.helpers.executeDecisionWrites();
};

const overrideStatusExecutor: IntentExecutor<"override_status"> = (context) => {
  // A successful human status decision is audited by the transition kernel,
  // but it is not itself a blocker. Unsafe exits are rejected before this
  // executor by the canonical lifecycle guards.
  return context.helpers.executeDecisionWrites();
};

const epicChildUpdateExecutor: IntentExecutor<"epic_child_update"> = async (context) => {
  const payload = context.command.payload;
  let commentId: string | null = null;
  if (payload.comment) {
    const comment = await createWorkflowComment(context, payload.comment, "workflow_action", true);
    commentId = comment.id;
    context.decision.evidence.commentId = comment.id;
  }

  if (payload.resetPlanApproval) {
    const reset = await markActionPlanRevisionRequired({
      taskId: context.command.taskId,
      client: context.tx,
    });
    if (reset.changed) {
      await createDomainActivity(context, "task.action_plan.reset", {
        reason: payload.reason,
        actionPlanId: reset.actionPlanId,
        previousVersion: reset.version,
        commentId,
      });
    }
  }

  if (payload.archive) {
    context.decision.taskData = {
      ...context.decision.taskData,
      archivedAt: new Date(),
      archivedById: context.decision.decisionActorId,
    };
  }
  if (payload.targetStatus === "To Do") {
    await createDomainActivity(context, "task.workflow.requeued", {
      status: "To Do",
      via: payload.reason,
      commentId,
    });
  }
  if (payload.archive) {
    await createDomainActivity(context, "task.archive", {
      epicId: payload.epicId,
      via: payload.reason,
    });
  }
  return context.helpers.executeDecisionWrites();
};

const cancelTaskExecutor: IntentExecutor<"cancel_task"> = async (context) => {
  const reason = context.command.payload.reason?.trim() || "Work suspended by an authorized human.";
  if (context.state.activeWorkflowCycleId) {
    await supersedeCycleMechanicalWork(context.tx, {
      taskId: context.command.taskId,
      workflowCycleId: context.state.activeWorkflowCycleId,
      reason,
      invalidateReview: true,
      markRepositoryActionRequired: true,
    });
  }
  await createWorkflowComment(context, reason);
  return context.helpers.executeDecisionWrites();
};

const archiveTaskExecutor: IntentExecutor<"archive_task"> = async (context) => {
  await context.tx.task.update({
    where: { id: context.command.taskId },
    data: { archivedAt: new Date(), archivedById: context.decision.decisionActorId },
  });
  return context.helpers.executeDecisionWrites();
};

const assignTaskExecutor: IntentExecutor<"assign_task"> = async (context) => {
  const requestedUsername = context.command.payload.assigneeUsername?.replace(/^@/, "") ?? null;
  const assignee = await context.tx.user.findFirst({
    where: {
      ...(requestedUsername ? { username: requestedUsername } : {}),
      status: "active",
      kind: "agent",
      agent: { is: { role: "coding", deactivatedAt: null } },
      assignedTasks: {
        none: {
          projectId: context.state.projectId,
          status: { in: ["To Do", "In Progress"] },
          deletedAt: null,
        },
      },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, username: true },
  });
  if (!assignee) throw new Error("assignee_not_found");
  const assigned = await context.tx.task.updateMany({
    where: { id: context.command.taskId, assigneeId: null },
    data: { assigneeId: assignee.id },
  });
  if (assigned.count !== 1) throw new Error("task_already_assigned");
  const resetUnapprovedPlan = context.command.source === "pm-service"
    && context.command.evidence?.resetUnapprovedPlan === true
    && !context.state.approvedOn;
  if (resetUnapprovedPlan) {
    const reset = await markActionPlanRevisionRequired({
      taskId: context.command.taskId,
      client: context.tx,
    });
    if (reset.changed) {
      await createDomainActivity(context, "task.action_plan.reset", {
        reason: "assignee_changed",
        actionPlanId: reset.actionPlanId,
        previousVersion: reset.version,
        via: context.command.evidence?.policy ?? "pm-service",
      });
    }
  }
  await createDomainActivity(context, "task.assign", {
    from: null,
    to: assignee.username,
    assigneeId: assignee.id,
    assignedBy: context.command.source === "pm-service"
      ? context.command.evidence?.policy ?? "pm-service"
      : "reviewer",
    afterPlanApproval: context.command.payload.afterPlanApproval,
  });
  const notification = context.command.evidence?.notification;
  const policyNotification = notification && typeof notification === "object" && !Array.isArray(notification)
    ? notification as Record<string, unknown>
    : null;
  await enqueueWorkflowEffects(context.tx, {
    taskId: context.command.taskId,
    projectId: context.state.projectId,
    aggregateVersion: context.state.workflowVersion,
    workflowCycleId: context.state.activeWorkflowCycleId,
    effects: [{
      type: "task_notification",
      key: `assignment:${assignee.id}`,
      payload: {
        taskId: context.command.taskId,
        targetUserId: assignee.id,
        actor: context.command.actor,
        reason: typeof policyNotification?.reason === "string"
          ? policyNotification.reason
          : context.state.approvedOn ? "todo_start_required" : "backlog_plan_requested",
        body: typeof policyNotification?.body === "string"
          ? policyNotification.body
          : context.state.approvedOn
            ? "You were assigned an approved task. Start it when the lane is available."
            : "You were assigned this task. Submit its structured Action Plan before implementation.",
      },
    }],
  });
  return context.helpers.executeDecisionWrites();
};

const raiseScopeBlockerExecutor: IntentExecutor<"raise_scope_blocker"> = async (context) => {
  const comment = await createWorkflowComment(
    context,
    [
      context.command.payload.scopeDescription,
      ...(context.command.payload.evidence ?? []).map((entry) => `- ${entry}`),
    ].join("\n"),
    "blocker_notice",
  );
  await createDomainActivity(context, "task.extra_work.blocker", {
    commentId: comment.id,
    blockerReport: {
      blockedOn: "decision",
      requestedActor: context.command.payload.requestedActor ?? "the task reviewer or reporter",
      requestedAction: context.command.payload.scopeDescription,
      evidence: (context.command.payload.evidence ?? []).join("\n") || context.command.payload.scopeDescription,
      diagnosticsAttempted: ["Scope ownership was checked against the approved Action Plan."],
      resumeCondition: "The reviewer or reporter decides whether to absorb or schedule the extra scope.",
      reporterCanResolve: true,
    },
  });
  await context.tx.task.update({
    where: { id: context.command.taskId },
    data: { alertReporter: true },
  });
  return context.helpers.executeDecisionWrites();
};

const publishCheckpointExecutor: IntentExecutor<"publish_checkpoint"> = async (context) => {
  const task = await context.tx.task.findUnique({
    where: { id: context.command.taskId },
    select: {
      approvedOn: true,
      workItemKey: true,
      branchName: true,
      epic: { select: { workItemKey: true, branchName: true, status: true } },
      project: { select: { repositoryPath: true, agentChangeBlockedBranches: true } },
      repositoryRun: { select: { phase: true, worktreePath: true } },
    },
  });
  const authorization = await context.tx.comment.findUnique({
    where: { id: context.command.payload.authorizationCommentId },
    select: {
      taskId: true,
      body: true,
      createdAt: true,
      deletedAt: true,
      user: { select: { kind: true, status: true, isOwner: true } },
    },
  });
  if (
    !task?.approvedOn ||
    !authorization ||
    authorization.taskId !== context.command.taskId ||
    authorization.deletedAt ||
    authorization.createdAt < task.approvedOn ||
    !isActiveOwnerPrincipal(authorization.user)
  ) {
    return {
      status: "forbidden",
      reason: "Checkpoint authorization is not a live owner grant for this approved task.",
      domainCode: "not_authorized",
    };
  }
  const taskBranch = effectiveTaskBranchName(task);
  const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
  if (
    !task.project.repositoryPath ||
    !task.repositoryRun?.worktreePath ||
    task.repositoryRun.phase !== "active" ||
    !task.epic ||
    task.epic.status !== "In Progress" ||
    !taskBranch ||
    !epicBranch ||
    taskBranch === epicBranch ||
    isProtectedBranch(task.project.agentChangeBlockedBranches, epicBranch)
  ) {
    return {
      status: "stale",
      reason: "Checkpoint repository contract is not active or publishable.",
      domainCode: "cycle_mismatch",
    };
  }
  const explicitAuthorization = validateCheckpointAuthorizationText({
    body: authorization.body,
    taskKey: task.workItemKey,
    taskBranch,
    epicBranch,
  });
  if (!explicitAuthorization.ok) {
    return {
      status: "forbidden",
      reason: `Checkpoint authorization is invalid: ${explicitAuthorization.reason}`,
      domainCode: "not_authorized",
    };
  }
  const priorUses = await context.tx.activityLog.findMany({
    where: {
      taskId: context.command.taskId,
      kind: { in: ["pm.repo.checkpoint.enqueue", "pm.repo.checkpoint.ok", "task.repository.checkpoint.requested"] },
    },
    select: { payload: true },
  });
  if (priorUses.some((row) => activityPayloadUsesCheckpointAuthorization(
    row.payload,
    context.command.payload.authorizationCommentId,
  ))) {
    return {
      status: "invalid",
      reason: "That checkpoint authorization was already consumed.",
      domainCode: "idempotency_conflict",
    };
  }
  await createDomainActivity(context, "task.repository.checkpoint.requested", {
    authorizationCommentId: context.command.payload.authorizationCommentId,
    candidateSha: context.command.payload.candidateSha,
    baseSha: context.command.payload.baseSha,
  });
  return context.helpers.executeDecisionWrites();
};

const addSubtaskExecutor: IntentExecutor<"add_subtask"> = async (context) => {
  const existing = await context.tx.subTask.findFirst({
    where: {
      taskId: context.command.taskId,
      kind: context.command.payload.subtaskKind,
      text: context.command.payload.subtaskText,
    },
    select: { id: true },
  });
  if (!existing) {
    await createSubTaskItem({
      taskId: context.command.taskId,
      text: context.command.payload.subtaskText,
      actorUserId: context.decision.decisionActorId,
      kind: context.command.payload.subtaskKind,
      client: context.tx,
    });
  }
  return context.helpers.executeDecisionWrites();
};

const completeSubtaskExecutor: IntentExecutor<"complete_subtask"> = async (context) => {
  const updated = await setSubTaskCompletion({
    subTaskId: context.command.payload.subtaskId,
    completed: context.command.payload.completed,
    minutesSpent: context.command.payload.minutesSpent ?? undefined,
    actorUserId: context.decision.decisionActorId,
    expectTaskId: context.command.taskId,
    client: context.tx,
  });
  if (!updated) throw new Error("subtask_not_found");
  return context.helpers.executeDecisionWrites();
};

const removeSubtaskExecutor: IntentExecutor<"remove_subtask"> = async (context) => {
  const removed = await deleteSubTaskItem({
    subTaskId: context.command.payload.subtaskId,
    actorUserId: context.decision.decisionActorId,
    expectTaskId: context.command.taskId,
    client: context.tx,
  });
  if (!removed) throw new Error("subtask_not_found");
  return context.helpers.executeDecisionWrites();
};

const requestSubtaskExecutor: IntentExecutor<"request_subtask"> = async (context) => {
  const comment = await createWorkflowComment(
    context,
    `Requested implementation sub-task: ${context.command.payload.subtaskText}\n\nReason: ${context.command.payload.reason}`,
  );
  await createDomainActivity(context, "task.subtask.requested", {
    commentId: comment.id,
    subtaskText: context.command.payload.subtaskText,
    reason: context.command.payload.reason,
  });
  return context.helpers.executeDecisionWrites();
};

const requestTaskExecutor: IntentExecutor<"request_task"> = async (context) => {
  const comment = await createWorkflowComment(
    context,
    [
      `Requested Epic task: ${context.command.payload.taskTitle}`,
      context.command.payload.taskDescription ?? "",
      `Reason: ${context.command.payload.reason}`,
    ].filter(Boolean).join("\n\n"),
  );
  await createDomainActivity(context, "task.task.requested", {
    commentId: comment.id,
    taskTitle: context.command.payload.taskTitle,
    taskDescription: context.command.payload.taskDescription ?? null,
    epicId: context.command.payload.epicId ?? context.state.epicId,
    reason: context.command.payload.reason,
  });
  return context.helpers.executeDecisionWrites();
};

// Deliberately explicit and checked against the full intent union. Adding an
// intent to TASK_WORKFLOW_INTENTS without registering it is a compile error.
export const INTENT_EXECUTORS = {
  submit_plan: submitPlanExecutor,
  approve_plan: approvePlanExecutor,
  request_plan_changes: requestPlanChangesExecutor,
  start_implementation: startImplementationExecutor,
  checkpoint: checkpointExecutor,
  submit_for_review: submitForReviewExecutor,
  request_review_changes: requestReviewChangesExecutor,
  accept_review: acceptReviewExecutor,
  raise_blocker: raiseBlockerExecutor,
  clear_blocker: clearBlockerExecutor,
  cancel_task: cancelTaskExecutor,
  archive_task: archiveTaskExecutor,
  triage_task: executeRegisteredIntent,
  assign_task: assignTaskExecutor,
  raise_scope_blocker: raiseScopeBlockerExecutor,
  override_status: overrideStatusExecutor,
  epic_child_update: epicChildUpdateExecutor,
  worktree_revalidation_failed: worktreeRevalidationFailedExecutor,
  repository_validation_succeeded: repositoryValidationSucceededExecutor,
  repository_validation_failed: repositoryValidationFailedExecutor,
  repository_finalization_succeeded: repositoryFinalizationSucceededExecutor,
  repository_finalization_failed: repositoryFinalizationFailedExecutor,
  publish_checkpoint: publishCheckpointExecutor,
  add_subtask: addSubtaskExecutor,
  complete_subtask: completeSubtaskExecutor,
  remove_subtask: removeSubtaskExecutor,
  request_subtask: requestSubtaskExecutor,
  request_task: requestTaskExecutor,
} satisfies IntentExecutorRegistry;

export function getIntentExecutor<I extends TaskWorkflowIntent>(
  intent: I,
): IntentExecutor<I> {
  return INTENT_EXECUTORS[intent] as IntentExecutor<I>;
}

export type {
  CommandForIntent,
  IntentExecutor,
  IntentExecutorContext,
  IntentExecutorRegistry,
  TransactionIntentHelpers,
} from "@/lib/tasks/orchestrator/intents/types";
