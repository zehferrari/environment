import {
  createChecklistAndDelegatableTasksFromPlan,
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

async function executeRegisteredIntent<I extends TaskWorkflowIntent>(
  context: IntentExecutorContext<I>,
) {
  return context.helpers.executeDecisionWrites();
}

async function createWorkflowComment<I extends TaskWorkflowIntent>(
  context: IntentExecutorContext<I>,
  body: string,
  commentKind = "workflow_action",
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
      isGenerated: false,
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
  await persistActionPlan({
    taskId: context.command.taskId,
    input: context.command.payload.actionPlan,
    authorId: context.decision.decisionActorId,
    sourceRunId: context.command.executionContext?.pmChannelRunId ?? null,
    sourceMessageId: context.command.messageId ?? context.command.payload.inReplyToMessageId ?? null,
    client: context.tx,
  });
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
  return context.helpers.executeDecisionWrites();
};

const submitForReviewExecutor: IntentExecutor<"submit_for_review"> = async (context) => {
  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      workflowCycleId: context.state.activeWorkflowCycleId,
      candidateSha: context.command.payload.candidateSha,
      baseSha: context.command.payload.baseSha,
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

const requestReviewChangesExecutor: IntentExecutor<"request_review_changes"> = async (context) => {
  await createWorkflowComment(context, context.command.payload.reviewerComment);
  return context.helpers.executeDecisionWrites();
};

const startImplementationExecutor: IntentExecutor<"start_implementation"> = (context) =>
  context.helpers.executeDecisionWrites();

const checkpointExecutor: IntentExecutor<"checkpoint"> = (context) =>
  context.helpers.executeDecisionWrites();

const acceptReviewExecutor: IntentExecutor<"accept_review"> = (context) =>
  context.helpers.executeDecisionWrites();

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
  const preserveIndependentAlert = context.state.repositoryRun?.phase === "operational_error";
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

const cancelTaskExecutor: IntentExecutor<"cancel_task"> = (context) =>
  context.helpers.executeDecisionWrites();

const archiveTaskExecutor: IntentExecutor<"archive_task"> = async (context) => {
  await context.tx.task.update({
    where: { id: context.command.taskId },
    data: { archivedAt: new Date(), archivedById: context.decision.decisionActorId },
  });
  return context.helpers.executeDecisionWrites();
};

const assignTaskExecutor: IntentExecutor<"assign_task"> = async (context) => {
  const username = context.command.payload.assigneeUsername.replace(/^@/, "");
  const assignee = await context.tx.user.findFirst({
    where: {
      username,
      status: "active",
      kind: "agent",
      agent: { is: { role: "coding", deactivatedAt: null } },
    },
    select: { id: true },
  });
  if (!assignee) throw new Error("assignee_not_found");
  const assigned = await context.tx.task.updateMany({
    where: { id: context.command.taskId, assigneeId: null },
    data: { assigneeId: assignee.id },
  });
  if (assigned.count !== 1) throw new Error("task_already_assigned");
  await createDomainActivity(context, "task.assign", {
    from: null,
    to: username,
    assigneeId: assignee.id,
    assignedBy: "reviewer",
    afterPlanApproval: context.command.payload.afterPlanApproval,
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
  await context.tx.taskRepositoryRun.updateMany({
    where: { taskId: context.command.taskId },
    data: {
      candidateSha: context.command.payload.candidateSha,
      baseSha: context.command.payload.baseSha,
      version: { increment: 1 },
    },
  });
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
      kind: "implementation",
      text: context.command.payload.subtaskText,
    },
    select: { id: true },
  });
  if (!existing) {
    await createSubTaskItem({
      taskId: context.command.taskId,
      text: context.command.payload.subtaskText,
      actorUserId: context.decision.decisionActorId,
      kind: "implementation",
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
    `Requested implementation sub-task: ${context.command.payload.subtaskText}`,
  );
  await createDomainActivity(context, "task.subtask.requested", {
    commentId: comment.id,
    subtaskText: context.command.payload.subtaskText,
  });
  return context.helpers.executeDecisionWrites();
};

const requestTaskExecutor: IntentExecutor<"request_task"> = async (context) => {
  const comment = await createWorkflowComment(
    context,
    [
      `Requested Epic task: ${context.command.payload.taskTitle}`,
      context.command.payload.taskDescription ?? "",
    ].filter(Boolean).join("\n\n"),
  );
  await createDomainActivity(context, "task.task.requested", {
    commentId: comment.id,
    taskTitle: context.command.payload.taskTitle,
    taskDescription: context.command.payload.taskDescription ?? null,
    epicId: context.command.payload.epicId ?? context.state.epicId,
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
