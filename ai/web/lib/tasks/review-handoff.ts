// PM-owned Review handoff.
//
// Code tasks stay In Progress while the repository runner commits and
// validates the candidate. Only a valid (or valid-with-warning) result moves
// the task to Review and wakes its related reviewer. Concrete validation
// failures return the task to the front of To Do without a reviewer wake.

import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { enqueueBranchVerifyJob, type BranchVerifyJob } from "@/lib/deploy/branch-verify";
import { refillEpicQueue } from "@/lib/epics/queue";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { resolveEffectiveProjectSettings } from "@/lib/settings/effective";
import { effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { revalidateTaskShell } from "@/lib/tasks/cache";
import { publishBoardTouch } from "@/lib/pm/board-events";
import {
  resolveActiveMonitorAgent,
  updateTaskRepositoryState,
  type RepositoryValidationOutcome,
} from "@/lib/tasks/repository-state";

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
      projectId: true,
      epicId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      branchName: true,
      commitPrefix: true,
      workItemKey: true,
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
}) {
  const task = await loadHandoffTask(args.taskId);
  if (!task) return { status: "In Progress" as const, refillAssignments: [] };

  if (task.status !== "Review") {
    if (task.status !== "In Progress") {
      return { status: task.status as "In Progress", refillAssignments: [] };
    }
    const maxRank = await db.task.aggregate({
      where: {
        projectId: task.projectId,
        status: "Review",
        archivedAt: null,
        deletedAt: null,
      },
      _max: { rank: true },
    });
    const now = new Date();
    await db.$transaction([
      db.task.update({
        where: { id: task.id },
        data: {
          status: "Review",
          rank: (maxRank._max.rank ?? 0) + 1,
          statusChangedAt: now,
          alertReporter: false,
        },
      }),
      db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "task.move",
          payload: JSON.stringify({
            from: "In Progress",
            to: "Review",
            via: args.via,
            validationOutcome: args.validationOutcome,
          }),
        },
      }),
    ]);
    await syncEpicOnHumanTaskStatus(db, {
      epicId: task.epicId,
      projectId: task.projectId,
      taskId: task.id,
      actorId: args.actor.id,
      actorKind: args.actor.kind,
      targetStatus: "Review",
      via: args.via,
    });
  }

  await updateTaskRepositoryState(task.id, {
    phase: "review_ready",
    candidateSha: args.candidateSha ?? task.repositoryRun?.candidateSha ?? null,
    validationOutcome: args.validationOutcome,
    repoTouched: args.repoTouched,
    lastError: null,
  });

  const reviewerId = resolveReviewOwnerId(task);
  if (reviewerId) {
    await sendTaskWorkflowNotification({
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
    });
  }

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
      revalidateTaskShell(assigned.task.id);
      refillAssignments.push({ taskId: assigned.task.id });
    }
  }
  revalidateTaskShell(task.id);
  publishBoardTouch(task.projectId);
  return { status: "Review" as const, refillAssignments };
}

export async function completeTaskReviewHandoffAfterValidation(args: {
  taskId: string;
  actor: Actor;
  candidateSha: string | null;
  validationOutcome: Extract<RepositoryValidationOutcome, "valid" | "valid_with_warning">;
  validationSummary?: string | null;
}) {
  return moveToReviewAndDispatch({
    ...args,
    via: "monitor-repository-validation",
    repoTouched: true,
  });
}

export async function failTaskReviewValidation(args: {
  taskId: string;
  actor: Actor;
  error: string;
  candidateSha?: string | null;
}) {
  const task = await loadHandoffTask(args.taskId);
  if (!task) return { status: "To Do" as const };

  if (task.status === "In Progress" || task.status === "Review") {
    const minRank = await db.task.aggregate({
      where: {
        projectId: task.projectId,
        status: "To Do",
        archivedAt: null,
        deletedAt: null,
      },
      _min: { rank: true },
    });
    await db.$transaction([
      db.task.update({
        where: { id: task.id },
        data: {
          status: "To Do",
          rank: (minRank._min.rank ?? 0) - 1,
          statusChangedAt: new Date(),
        },
      }),
      db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: args.actor.id,
          kind: "task.move",
          payload: JSON.stringify({
            from: task.status,
            to: "To Do",
            via: "monitor-repository-validation",
            validationOutcome: "invalid",
          }),
        },
      }),
    ]);
  }
  await updateTaskRepositoryState(task.id, {
    phase: "action_required",
    candidateSha: args.candidateSha ?? null,
    validationOutcome: "invalid",
    lastError: args.error,
  });
  if (task.assigneeId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor: args.actor,
      reason: "review_feedback",
      body: [
        `Repository validation failed for "${task.title}", so PM returned it to the front of To Do.`,
        args.error,
        "Correct the reported problem, start the task again, and resubmit it. The reviewer was not notified.",
      ].join("\n"),
    });
  }
  revalidateTaskShell(task.id);
  publishBoardTouch(task.projectId);
  return { status: "To Do" as const };
}

export async function recordTaskReviewOperationalError(args: {
  taskId: string;
  actor?: Actor | null;
  error: string;
}) {
  const task = await loadHandoffTask(args.taskId);
  if (!task) return;
  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: { alertReporter: true },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actor?.id ?? null,
        kind: "pm.repo.verify.operational_error",
        payload: JSON.stringify({ error: args.error }),
      },
    }),
  ]);
  await updateTaskRepositoryState(task.id, {
    phase: "operational_error",
    validationOutcome: "operational_error",
    lastError: args.error,
  });
  publishBoardTouch(task.projectId);
}

export async function runTaskReviewHandoff(args: {
  taskId: string;
  actor: Actor;
  via: string;
  movedFromStatus: string;
  repoTouched?: boolean;
  assigneeNote?: string | null;
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

  const branchName = effectiveTaskBranchName(task);
  const codeTouching = Boolean(branchName && task.project.repositoryPath);
  const repoTouched = typeof args.repoTouched === "boolean" ? args.repoTouched : codeTouching;

  if (!repoTouched) {
    const completed = await moveToReviewAndDispatch({
      taskId: task.id,
      actor: args.actor,
      via: args.via,
      validationOutcome: "valid",
      repoTouched: false,
      assigneeNote: args.assigneeNote,
      validationSummary: "This submission declared no repository changes.",
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
  };
  try {
    await enqueueBranchVerifyJob(job);
    await updateTaskRepositoryState(task.id, {
      phase: "validating",
      repositoryPath: task.project.repositoryPath,
      branchName,
      epicBranch: job.epicBranch,
      repoTouched: true,
      validationOutcome: null,
      lastError: null,
      incrementAttempt: true,
    });
    await db.activityLog.create({
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
