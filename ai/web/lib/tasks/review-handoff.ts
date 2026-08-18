// PM-owned Review handoff.
//
// Code tasks stay In Progress while the repository runner commits and
// validates the candidate. Only a valid (or valid-with-warning) result moves
// the task to Review and wakes its related reviewer. Concrete validation
// failures return the task to the front of To Do without a reviewer wake.

import { createHash, randomUUID } from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { BranchVerifyJob } from "@/lib/deploy/branch-verify";
import { refillEpicQueue } from "@/lib/epics/queue";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { resolveEffectiveProjectSettings } from "@/lib/settings/effective";
import { effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { revalidateTaskShellIfAvailable } from "@/lib/tasks/cache";
import { resolveValidationProfileSnapshot } from "@/lib/tasks/validation-profile";
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
import {
  resolveActiveMonitorAgent,
  updateTaskRepositoryState,
  type RepositoryValidationOutcome,
} from "@/lib/tasks/repository-state";

// ORCH-06/P0-4: apply a validation callback to a waiting procedure step.
// Called after the legacy validation handoff completes/fails. If a procedure
// step is in waiting_callback for this task, applies the callback so the
// procedure engine can continue (create review lease → enter Review → wake
// reviewer, or close cycle → return to To Do → feedback).
async function applyValidationCallbackToProcedure(
  taskId: string,
  candidateSha: string | null,
  outcome: "valid" | "invalid",
  validationOutcome: string,
  error?: string,
): Promise<void> {
  const step = await db.taskProcedureStep.findFirst({
    where: {
      status: "waiting_callback",
      procedureRun: { taskId },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, procedureRunId: true, output: true },
  });
  if (!step) return; // no procedure waiting — legacy path only
  let jobId = "unknown";
  let expectedCandidateSha: string | null = null;
  if (step.output) {
    try {
      const parsed = JSON.parse(step.output) as Record<string, unknown>;
      if (typeof parsed.jobId === "string") jobId = parsed.jobId;
      if (typeof parsed.candidateSha === "string") expectedCandidateSha = parsed.candidateSha;
    } catch { /* ignore */ }
  }
  const procRun = await db.taskProcedureRun.findUnique({
    where: { id: step.procedureRunId },
    select: { taskId: true, workflowCycleId: true },
  });
  if (!procRun) return;
  const { applyProcedureCallback } = await import("@/lib/tasks/orchestrator/procedure-runner");
  await applyProcedureCallback({
    procedureRunId: step.procedureRunId,
    stepId: step.id,
    taskId: procRun.taskId,
    workflowCycleId: procRun.workflowCycleId,
    jobId,
    candidateSha: candidateSha ?? expectedCandidateSha,
    data: { validationOutcome, error: error ?? undefined },
  });
}

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

export type ReviewHandoffResult = {
  verifyJobId: string | null;
  repoTouched: boolean;
  branchName: string | null;
  status: "In Progress" | "Review" | "To Do";
  repositoryPhase:
    | "validating"
    | "review_ready"
    | "action_required"
    | "operational_error";
  refillAssignments: Array<{ taskId: string }>;
  error?: string;
};

async function loadHandoffTask(taskId: string) {
  return db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      description: true,
      status: true,
      workflowVersion: true,
      projectId: true,
      epicId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      branchName: true,
      commitPrefix: true,
      workItemKey: true,
      activeWorkflowCycleId: true,
      assignee: {
        select: { agent: { select: { slug: true } } },
      },
      repositoryRun: {
        select: {
          baseSha: true,
          candidateSha: true,
          phase: true,
          validationOutcome: true,
        },
      },
      checklist: {
        where: { kind: { not: "review" } },
        select: { id: true, text: true, completedAt: true },
        orderBy: { rank: "asc" },
      },
      actionPlan: {
        select: { id: true, status: true, steps: { select: { id: true } } },
      },
      project: {
        select: {
          slug: true,
          repositoryPath: true,
          defaultGitUserName: true,
          defaultGitUserEmail: true,
          deploymentProductionBranch: true,
          deploymentPrTargetBranch: true,
          agentChangeBlockedBranches: true,
          onlyReportersCanApproveActionPlans: true,
          onlyReportersCanSetTasksDone: true,
        },
      },
      epic: {
        select: {
          status: true,
          actingManagerId: true,
          branchName: true,
          workItemKey: true,
          commitPrefix: true,
        },
      },
    },
  });
}

async function moveToReviewAndDispatch(args: {
  taskId: string;
  actor: Actor;
  via: string;
  validationOutcome: Extract<RepositoryValidationOutcome, "valid" | "valid_with_warning">;
  candidateSha?: string | null;
  repoTouched: boolean;
  assigneeNote?: string | null;
  validationSummary?: string | null;
  workflowAction?: PmChannelWorkflowActionArgs;
}) {
  const task = await loadHandoffTask(args.taskId);
  if (!task) return { status: "In Progress" as const, refillAssignments: [] };

  const reviewCandidateSha = args.candidateSha ?? task.repositoryRun?.candidateSha ?? null;
  const reviewerId = resolveReviewOwnerId(task);
  const effects: WorkflowEffect[] = [
    { type: "board_touch", key: "board-review-ready", payload: {} },
  ];
  if (reviewerId) {
    effects.push({
      type: "task_notification",
      key: `review-requested:${reviewerId}`,
      payload: {
        taskId: task.id,
        targetUserId: reviewerId,
        actor: args.actor,
        reason: "review_requested",
        body: [
          `Repository validation ${args.validationOutcome === "valid_with_warning" ? "passed with an advisory warning" : "passed"} for "${task.title}".`,
          args.validationSummary || null,
          args.assigneeNote ? `Assignee note:\n${args.assigneeNote}` : null,
          "Review the exact validated candidate. If satisfied, use action=review_done. If changes remain, use action=review_feedback with one consolidated comment.",
        ].filter(Boolean).join("\n"),
      },
    });
  }
  const persistReviewState = async (tx: Prisma.TransactionClient) => {
    await updateTaskRepositoryState(task.id, {
      phase: "review_ready",
      candidateSha: reviewCandidateSha,
      validationOutcome: args.validationOutcome,
      repoTouched: args.repoTouched,
      lastError: null,
    }, tx);
    if (reviewCandidateSha) {
      const now = new Date();
      await tx.reviewRun.updateMany({
        where: {
          taskId: task.id,
          candidateSha: { not: reviewCandidateSha },
          status: { in: ["validating", "awaiting_review"] },
        },
        data: {
          status: "invalidated",
          invalidatedAt: now,
          invalidatedReason: `superseded by validated candidate ${reviewCandidateSha}`,
        },
      });
      await tx.reviewRun.upsert({
        where: { workflowCycleId: task.activeWorkflowCycleId ?? "_never_" },
        create: {
          taskId: task.id,
          workflowCycleId: task.activeWorkflowCycleId,
          candidateSha: reviewCandidateSha,
          baseSha: task.repositoryRun?.baseSha ?? null,
          repoTouched: args.repoTouched,
          validationOutcome: args.validationOutcome,
          status: "awaiting_review",
        },
        update: {
          baseSha: task.repositoryRun?.baseSha ?? null,
          repoTouched: args.repoTouched,
          validationOutcome: args.validationOutcome,
          status: "awaiting_review",
          reviewerId: null,
          reviewedAt: null,
          invalidatedAt: null,
          invalidatedReason: null,
        },
      });
    }
  };
  if (task.status === "In Progress") {
    await db.$transaction(async (tx) => {
      await applyTaskTransition(tx, {
        taskId: task.id,
        projectId: task.projectId,
        actorUserId: args.actor.id,
        intent: args.via === "monitor-repository-validation" ? "repository_validated" : "submit_review",
        from: "In Progress",
        to: "Review",
        source: args.via,
        // Candidate identity is immutable, but a candidate may legitimately
        // enter a NEW review cycle after finalization failed and the task was
        // returned through To Do/In Progress. Scope idempotency to this
        // workflow edge, not forever to the SHA, while concurrent callbacks
        // for the same edge still collapse onto one transition.
        idempotencyKey: `review-ready:${reviewCandidateSha ?? "nonrepo"}:v${task.workflowVersion + 1}`,
        evidence: { validationOutcome: args.validationOutcome, candidateSha: reviewCandidateSha },
        taskData: { alertReporter: false },
        effects,
        mutate: async ({ tx: inner }) => {
          await persistReviewState(inner);
          await syncEpicOnHumanTaskStatus(inner, {
            epicId: task.epicId,
            projectId: task.projectId,
            taskId: task.id,
            actorId: args.actor.id,
            actorKind: args.actor.kind,
            targetStatus: "Review",
            via: args.via,
          });
        },
      });
      if (args.workflowAction) {
        await applyPmChannelRunWorkflowAction(tx, {
          ...args.workflowAction,
          taskState: "Review",
        });
      }
    });
  } else if (task.status === "Review") {
    await db.$transaction(async (tx) => {
      await persistReviewState(tx);
      await enqueueWorkflowEffects(tx, {
        taskId: task.id,
        projectId: task.projectId,
        aggregateVersion: task.workflowVersion,
        effects,
      });
      if (args.workflowAction) {
        await applyPmChannelRunWorkflowAction(tx, {
          ...args.workflowAction,
          taskState: "Review",
        });
      }
    });
  } else {
    return { status: task.status as "In Progress", refillAssignments: [] };
  }
  await drainWorkflowOutbox({ limit: effects.length }).catch((error) =>
    console.error("[pm] review-ready workflow outbox drain deferred:", task.id, error),
  );

  const refillAssignments: Array<{ taskId: string }> = [];
  if (task.epicId) {
    const refill = await refillEpicQueue({
      epicId: task.epicId,
      actor: args.actor,
      via: args.via,
      preferUserId: task.assigneeId ?? undefined,
      contextLine: `"${task.title}" passed repository validation and moved to Review.`,
    });
    for (const assigned of refill.assignments) {
      revalidateTaskShellIfAvailable(assigned.task.id);
      refillAssignments.push({ taskId: assigned.task.id });
    }
  }
  revalidateTaskShellIfAvailable(task.id);
  return { status: "Review" as const, refillAssignments };
}

export async function completeTaskReviewHandoffAfterValidation(args: {
  taskId: string;
  actor: Actor;
  candidateSha: string | null;
  validationOutcome: Extract<RepositoryValidationOutcome, "valid" | "valid_with_warning">;
  validationSummary?: string | null;
  repoTouched?: boolean;
}) {
  const result = await moveToReviewAndDispatch({
    ...args,
    via: "monitor-repository-validation",
    repoTouched: args.repoTouched ?? true,
  });
  // ORCH-06/P0-4: if a procedure step is waiting for a validation callback,
  // apply it so the procedure engine can continue.
  await applyValidationCallbackToProcedure(args.taskId, args.candidateSha, "valid", args.validationOutcome).catch((error) =>
    console.error("[pm] procedure validation callback (success) failed:", args.taskId, error),
  );
  return result;
}

export async function failTaskReviewValidation(args: {
  taskId: string;
  actor: Actor;
  error: string;
  candidateSha?: string | null;
}) {
  // ORCH-06/P0-4: if a procedure step is waiting for a validation callback,
  // apply it with the failure outcome so the procedure engine can handle
  // the validation failure path.
  await applyValidationCallbackToProcedure(args.taskId, args.candidateSha ?? null, "invalid", "invalid", args.error).catch((error) =>
    console.error("[pm] procedure validation callback (failure) failed:", args.taskId, error),
  );
  const task = await loadHandoffTask(args.taskId);
  if (!task) return { status: "To Do" as const };

  const effects: WorkflowEffect[] = [{ type: "board_touch", key: "board-validation-failed", payload: {} }];
  if (task.assigneeId) {
    effects.push({
      type: "task_notification",
      key: `validation-feedback:${task.assigneeId}`,
      payload: {
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor: args.actor,
        reason: "review_feedback",
        body: [
        `Repository validation failed for "${task.title}", so PM returned it to the front of To Do.`,
        args.error,
        "Correct the reported problem, start the task again, and resubmit it. The reviewer was not notified.",
      ].join("\n"),
      },
    });
  }
  const persistFailure = async (tx: Prisma.TransactionClient) => {
    await updateTaskRepositoryState(task.id, {
      phase: "action_required",
      candidateSha: args.candidateSha ?? null,
      validationOutcome: "invalid",
      lastError: args.error,
    }, tx);
    await tx.reviewRun.updateMany({
      where: { taskId: task.id, status: { in: ["validating", "awaiting_review", "accepted"] } },
      data: {
        status: "invalidated",
        validationOutcome: "invalid",
        invalidatedAt: new Date(),
        invalidatedReason: args.error.slice(0, 1000),
      },
    });
  };
  const failureKey = createHash("sha256")
    .update(`${args.candidateSha ?? "none"}\0${args.error}`)
    .digest("hex")
    .slice(0, 24);
  await db.$transaction(async (tx) => {
    if (task.status === "In Progress" || task.status === "Review") {
      await applyTaskTransition(tx, {
        taskId: task.id,
        projectId: task.projectId,
        actorUserId: args.actor.id,
        intent: "repository_validation_failed",
        from: task.status,
        to: "To Do",
        source: "monitor-repository-validation",
        idempotencyKey: `repository-validation-failed:${failureKey}`,
        rank: "front",
        evidence: { validationOutcome: "invalid", candidateSha: args.candidateSha ?? null },
        effects,
        mutate: async ({ tx: inner }) => persistFailure(inner),
      });
    } else {
      await persistFailure(tx);
      await enqueueWorkflowEffects(tx, {
        taskId: task.id,
        projectId: task.projectId,
        aggregateVersion: task.workflowVersion,
        effects,
      });
    }
  });
  await drainWorkflowOutbox({ limit: effects.length }).catch((error) =>
    console.error("[pm] validation-failure workflow outbox drain deferred:", task.id, error),
  );
  revalidateTaskShellIfAvailable(task.id);
  return { status: "To Do" as const };
}

export async function recordTaskReviewOperationalError(args: {
  taskId: string;
  actor?: Actor | null;
  error: string;
  preserveValidationOutcome?: boolean;
}) {
  const task = await loadHandoffTask(args.taskId);
  if (!task) return;
  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: { alertReporter: true },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actor?.id ?? null,
        kind: "pm.repo.verify.operational_error",
        payload: JSON.stringify({ error: args.error }),
      },
    });
    await updateTaskRepositoryState(task.id, {
      phase: "operational_error",
      ...(args.preserveValidationOutcome ? {} : { validationOutcome: "operational_error" as const }),
      lastError: args.error,
    }, tx);
    await enqueueWorkflowEffects(tx, {
      taskId: task.id,
      projectId: task.projectId,
      aggregateVersion: task.workflowVersion,
      effects: [{ type: "board_touch", key: `board-operational-error:${task.repositoryRun?.phase ?? "unknown"}`, payload: {} }],
    });
  });
  await drainWorkflowOutbox({ limit: 1 }).catch(() => {});
}

export async function runTaskReviewHandoff(args: {
  taskId: string;
  actor: Actor;
  via: string;
  movedFromStatus: string;
  repoTouched?: boolean;
  assigneeNote?: string | null;
  workflowAction?: PmChannelWorkflowActionArgs;
}): Promise<ReviewHandoffResult> {
  const task = await loadHandoffTask(args.taskId);
  if (!task) {
    return {
      verifyJobId: null,
      repoTouched: false,
      branchName: null,
      status: "In Progress",
      repositoryPhase: "operational_error",
      refillAssignments: [],
      error: "Task not found.",
    };
  }

  if (!task.actionPlan || task.actionPlan.status !== "approved" || task.actionPlan.steps.length === 0) {
    return {
      verifyJobId: null,
      repoTouched: Boolean(task.project.repositoryPath),
      branchName: effectiveTaskBranchName(task),
      status: "In Progress",
      repositoryPhase: "action_required",
      refillAssignments: [],
      error: "Review handoff requires an approved structured Action Plan with at least one step.",
    };
  }
  const openImplementation = task.checklist.filter((item) => !item.completedAt);
  if (task.checklist.length === 0 || openImplementation.length > 0) {
    return {
      verifyJobId: null,
      repoTouched: Boolean(task.project.repositoryPath),
      branchName: effectiveTaskBranchName(task),
      status: "In Progress",
      repositoryPhase: "action_required",
      refillAssignments: [],
      error: task.checklist.length === 0
        ? "Review handoff requires a materialized implementation checklist."
        : `Review handoff rejected: ${openImplementation.length} implementation checklist item(s) remain open.`,
    };
  }

  const branchName = effectiveTaskBranchName(task);
  const codeTouching = Boolean(branchName && task.project.repositoryPath);

  // Repository classification is mechanical. An assignee cannot bypass Git
  // inspection by declaring repoTouched=false; the repository runner decides
  // whether the clean candidate differs from its recorded base SHA.
  if (!codeTouching) {
    const completed = await moveToReviewAndDispatch({
      taskId: task.id,
      actor: args.actor,
      via: args.via,
      validationOutcome: "valid",
      repoTouched: false,
      assigneeNote: args.assigneeNote,
      validationSummary: "This submission declared no repository changes.",
      workflowAction: args.workflowAction,
    });
    return {
      verifyJobId: null,
      repoTouched: false,
      branchName,
      status: completed.status,
      repositoryPhase: "review_ready",
      refillAssignments: completed.refillAssignments,
    };
  }

  if (task.repositoryRun?.phase === "validating") {
    const workflowAction = args.workflowAction;
    if (workflowAction) {
      await db.$transaction((tx) => applyPmChannelRunWorkflowAction(tx, {
        ...workflowAction,
        taskState: "In Progress",
      }));
    }
    return {
      verifyJobId: null,
      repoTouched: true,
      branchName,
      status: "In Progress",
      repositoryPhase: "validating",
      refillAssignments: [],
    };
  }

  if (!branchName || !task.project.repositoryPath) {
    const error = "Repository validation cannot start because the task has no effective repository branch.";
    await recordTaskReviewOperationalError({ taskId: task.id, actor: args.actor, error });
    return {
      verifyJobId: null,
      repoTouched: true,
      branchName,
      status: "In Progress",
      repositoryPhase: "operational_error",
      refillAssignments: [],
      error,
    };
  }

  if (isProtectedBranch(task.project.agentChangeBlockedBranches, branchName)) {
    const error = `Branch ${branchName} is protected from agent code changes.`;
    await failTaskReviewValidation({ taskId: task.id, actor: args.actor, error });
    return {
      verifyJobId: null,
      repoTouched: true,
      branchName,
      status: "To Do",
      repositoryPhase: "action_required",
      refillAssignments: [],
      error,
    };
  }

  const monitor = await resolveActiveMonitorAgent();
  if (!monitor.ok) {
    await recordTaskReviewOperationalError({
      taskId: task.id,
      actor: args.actor,
      error: monitor.error,
    });
    return {
      verifyJobId: null,
      repoTouched: true,
      branchName,
      status: "In Progress",
      repositoryPhase: "operational_error",
      refillAssignments: [],
      error: monitor.error,
    };
  }

  const effectiveSettings = await resolveEffectiveProjectSettings({
    id: task.projectId,
    defaultGitUserName: task.project.defaultGitUserName,
    defaultGitUserEmail: task.project.defaultGitUserEmail,
    deploymentProductionBranch: task.project.deploymentProductionBranch,
    deploymentPrTargetBranch: task.project.deploymentPrTargetBranch,
  });
  const jobId = randomUUID();
  const validationProfile = await resolveValidationProfileSnapshot(task.projectId);
  const job: BranchVerifyJob = {
    jobId,
    taskId: task.id,
    projectId: task.projectId,
    projectSlug: task.project.slug,
    repositoryPath: task.project.repositoryPath,
    branchName,
    baseBranch: effectiveSettings.deployment.prTargetBranch.value,
    epicChild: Boolean(task.epicId),
    epicBranch: task.epic ? effectiveEpicBranchName(task.epic) : null,
    commitPrefix: effectiveTaskCommitPrefix(task),
    expectedGitUserName: effectiveSettings.gitIdentity.name.value,
    expectedGitUserEmail: effectiveSettings.gitIdentity.email.value,
    taskTitle: task.title,
    taskDescription: task.description,
    assigneeNote: args.assigneeNote ?? null,
    baseSha: task.repositoryRun?.baseSha ?? null,
    previousCandidateSha: task.repositoryRun?.candidateSha ?? null,
    monitorUserId: monitor.user.id,
    monitorAgentSlug: monitor.agentSlug,
    requestedByAgentSlug: task.assignee?.agent?.slug ?? args.actor.username ?? "human",
    requestedByUserId: args.actor.id,
    requestedAt: new Date().toISOString(),
    validationProfile,
  };
  try {
    await db.$transaction(async (tx) => {
      await updateTaskRepositoryState(task.id, {
        phase: "validating",
        repositoryPath: task.project.repositoryPath,
        branchName,
        epicBranch: job.epicBranch,
        repoTouched: true,
        validationOutcome: null,
        lastError: null,
        incrementAttempt: true,
      }, tx);
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "pm.repo.verify.enqueue",
          targetAgent: monitor.agentSlug,
          payload: JSON.stringify({
            jobId,
            branchName,
            baseBranch: job.baseBranch,
            epicChild: job.epicChild,
            epicBranch: job.epicBranch,
            commitPrefix: job.commitPrefix,
            via: args.via,
          }),
        },
      });
      await enqueueWorkflowEffects(tx, {
        taskId: task.id,
        projectId: task.projectId,
        aggregateVersion: task.workflowVersion,
        effects: [
          {
            type: "branch_verify",
            key: `branch-verify:${jobId}`,
            payload: { job: job as unknown as Record<string, unknown> },
          },
          { type: "board_touch", key: `board-validating:${jobId}`, payload: {} },
        ],
      });
      if (args.workflowAction) {
        await applyPmChannelRunWorkflowAction(tx, {
          ...args.workflowAction,
          taskState: "In Progress",
        });
      }
    });
    await drainWorkflowOutbox({ limit: 2 }).catch((error) =>
      console.error("[pm] branch-verification workflow outbox drain deferred:", task.id, error),
    );
    return {
      verifyJobId: jobId,
      repoTouched: true,
      branchName,
      status: "In Progress",
      repositoryPhase: "validating",
      refillAssignments: [],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await recordTaskReviewOperationalError({ taskId: task.id, actor: args.actor, error });
    return {
      verifyJobId: null,
      repoTouched: true,
      branchName,
      status: "In Progress",
      repositoryPhase: "operational_error",
      refillAssignments: [],
      error,
    };
  }
}
