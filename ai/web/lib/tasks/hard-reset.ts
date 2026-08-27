import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  abortGatewaySession,
  steerGatewaySession,
} from "@/lib/agents/pm-channel/supersession";
import { buildPmOpenClawSessionKey } from "@/lib/agents/auth/session-bindings";
import { branchNameFromWorkItemKey } from "@/lib/work-items/branches";

const ACTIVE_RUN_STATUSES = [
  "queued",
  "claimed",
  "delivered",
  "waiting_capacity",
  "accepted",
  "admitted",
  "streaming",
] as const;

const DELIVERED_RUN_STATUSES = new Set([
  "delivered",
  "accepted",
  "admitted",
  "streaming",
]);

export type TaskHardResetPreparation = {
  resetToken: string;
  taskId: string;
  projectId: string;
  projectSlug: string;
  workItemKey: string | null;
  repositoryPath: string | null;
  branchName: string | null;
  stoppedAgents: string[];
};

export type TaskHardResetPrepareResult =
  | { ok: true; preparation: TaskHardResetPreparation }
  | { ok: false; error: string };

type ResetRun = {
  id: string;
  agentSlug: string;
  status: string;
  gatewayPort: number | null;
  sessionKey: string | null;
  finishedReason: string | null;
  cancellationAcknowledgedAt: Date | null;
};

function resetSessionKey(taskId: string, agentSlug: string, resetToken: string) {
  return `${buildPmOpenClawSessionKey({ scopeType: "task", scopeId: taskId, agentSlug })}:recovery:reset-${resetToken}`;
}

function requiresGatewayAbort(run: ResetRun) {
  return ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])
    || (run.finishedReason === "hard_reset" && !run.cancellationAcknowledgedAt);
}

/**
 * First half of a hard reset. Fence every durable dispatch path before any
 * repository state is discarded, then require an acknowledgement from every
 * gateway process that may still be working on the task.
 */
export async function quiesceTaskForHardReset(args: {
  taskId: string;
  actorUserId: string;
  actorUsername: string;
  fetchImpl?: typeof fetch;
}): Promise<TaskHardResetPrepareResult> {
  const task = await db.task.findUnique({
    where: { id: args.taskId, deletedAt: null },
    select: {
      id: true,
      projectId: true,
      workItemKey: true,
      branchName: true,
      assigneeId: true,
      actingManagerId: true,
      project: { select: { slug: true, repositoryPath: true } },
      repositoryRun: {
        select: { repositoryPath: true, branchName: true },
      },
    },
  });
  if (!task) return { ok: false, error: "Task not found." };

  const [runs, bindings] = await Promise.all([
    db.pmChannelRun.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        agentSlug: true,
        status: true,
        gatewayPort: true,
        sessionKey: true,
        finishedReason: true,
        cancellationAcknowledgedAt: true,
      },
    }),
    db.agentSessionBinding.findMany({
      where: { scopeType: "task", scopeId: task.id },
      select: { id: true, agentSlug: true },
    }),
  ]);

  const resetToken = randomUUID();
  const now = new Date();
  const runIds = runs.map((run) => run.id);
  const agentSlugs = [...new Set([
    ...runs.map((run) => run.agentSlug),
    ...bindings.map((binding) => binding.agentSlug),
  ])];

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: task.id },
      data: {
        status: "Backlog",
        statusChangedAt: now,
        assigneeId: null,
        actingManagerId: null,
        approvedOn: null,
        approvedById: null,
        activeWorkflowCycleId: null,
        alertReporter: false,
      },
    });
    if (runIds.length > 0) {
      await tx.pmChannelRun.updateMany({
        where: { id: { in: runIds }, status: { in: [...ACTIVE_RUN_STATUSES] } },
        data: {
          status: "cancelled",
          error: null,
          completedAt: now,
          failedAt: null,
          finishedAt: now,
          finishedReason: "hard_reset",
          lastEventAt: now,
          cancellationRequestedAt: now,
          cancellationError: null,
        },
      });
      await tx.pmChannelJob.updateMany({
        where: {
          runId: { in: runIds },
          status: { in: ["queued", "claimed", "accepted", "retryable"] },
        },
        data: { status: "canceled", completedAt: now, lastError: "task hard reset" },
      });
      await tx.pmChannelContinuation.updateMany({
        where: {
          runId: { in: runIds },
          status: { in: ["armed", "queued", "dispatching"] },
        },
        data: { status: "superseded", lastError: "task hard reset" },
      });
      await tx.agentExecutionLease.updateMany({
        where: { runId: { in: runIds }, status: { in: ["reserved", "admitted", "running"] } },
        data: { status: "released", releasedAt: now },
      });
    }
    await tx.agentExecutionLease.updateMany({
      where: { taskId: task.id, status: { in: ["reserved", "admitted", "running"] } },
      data: { status: "released", releasedAt: now },
    });
    await tx.taskExecutionEpisode.updateMany({
      where: { taskId: task.id, status: "open" },
      data: { status: "closed", closedAt: now, closeReason: "hard_reset" },
    });
    await tx.workflowOutbox.updateMany({
      where: { taskId: task.id, status: { in: ["queued", "dispatching", "failed"] } },
      data: {
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        lastError: "task hard reset",
      },
    });
    await tx.taskProcedureStep.updateMany({
      where: {
        procedureRun: { taskId: task.id },
        status: { in: ["pending", "running", "failed", "waiting_callback"] },
      },
      data: {
        status: "superseded",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: now,
        lastError: "task hard reset",
      },
    });
    await tx.taskProcedureRun.updateMany({
      where: { taskId: task.id, status: { in: ["queued", "running", "operational_error"] } },
      data: {
        status: "superseded",
        currentStep: null,
        completedAt: now,
        lastError: "task hard reset",
      },
    });
    await tx.reviewRun.updateMany({
      where: { taskId: task.id, status: { in: ["validating", "awaiting_review", "accepted"] } },
      data: {
        status: "invalidated",
        invalidatedAt: now,
        invalidatedReason: "task hard reset",
      },
    });
    await tx.taskRepositoryRun.updateMany({
      where: { taskId: task.id },
      data: { phase: "action_required", lastError: "task hard reset", version: { increment: 1 } },
    });

    for (const agentSlug of agentSlugs) {
      const nextKey = resetSessionKey(task.id, agentSlug, resetToken);
      await tx.agentSessionBinding.upsert({
        where: {
          scopeType_scopeId_agentSlug: {
            scopeType: "task",
            scopeId: task.id,
            agentSlug,
          },
        },
        create: {
          scopeType: "task",
          scopeId: task.id,
          agentSlug,
          openclawSessionKey: nextKey,
          openclawSessionId: nextKey,
        },
        update: {
          openclawSessionKey: nextKey,
          openclawSessionId: nextKey,
          lastDispatchedMessageId: null,
          lastDispatchedAt: null,
        },
      });
    }

    await tx.activityLog.deleteMany({
      where: { taskId: task.id, kind: "task.reset.requested" },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actorUserId,
        kind: "task.reset.requested",
        payload: JSON.stringify({
          resetToken,
          requestedBy: args.actorUsername,
          agents: agentSlugs,
        }),
      },
    });
  });

  const abortErrors: string[] = [];
  const stoppedAgents = new Set<string>();
  for (const run of runs.filter(requiresGatewayAbort)) {
    if (!run.gatewayPort || !run.sessionKey) {
      if (DELIVERED_RUN_STATUSES.has(run.status) || run.finishedReason === "hard_reset") {
        abortErrors.push(`${run.agentSlug}: live run has no gateway session identity`);
      }
      continue;
    }
    await steerGatewaySession({
      agentSlug: run.agentSlug,
      gatewayPort: run.gatewayPort,
      sessionKey: run.sessionKey,
      text: "This task was hard reset by its human owner. Stop all work immediately and do not continue or reuse this task session.",
      fetchImpl: args.fetchImpl,
    }).catch(() => ({ ok: false as const }));
    const aborted = await abortGatewaySession({
      agentSlug: run.agentSlug,
      gatewayPort: run.gatewayPort,
      sessionKey: run.sessionKey,
      fetchImpl: args.fetchImpl,
    });
    if (!aborted.ok) {
      abortErrors.push(`${run.agentSlug}: ${aborted.error}`);
      await db.pmChannelRun.updateMany({
        where: { id: run.id },
        data: { cancellationError: aborted.error },
      });
      continue;
    }
    stoppedAgents.add(run.agentSlug);
    await db.pmChannelRun.updateMany({
      where: { id: run.id },
      data: {
        cancellationAcknowledgedAt: new Date(),
        cancellationError: null,
      },
    });
  }

  if (abortErrors.length > 0) {
    return {
      ok: false,
      error: `The task was fenced, but PM could not confirm every agent stopped: ${abortErrors.join("; ")}. Retry Reset Task.`,
    };
  }

  return {
    ok: true,
    preparation: {
      resetToken,
      taskId: task.id,
      projectId: task.projectId,
      projectSlug: task.project.slug,
      workItemKey: task.workItemKey,
      repositoryPath: task.repositoryRun?.repositoryPath ?? task.project.repositoryPath,
      branchName: task.repositoryRun?.branchName ?? task.branchName ?? branchNameFromWorkItemKey(task.workItemKey),
      stoppedAgents: [...stoppedAgents],
    },
  };
}

function count(result: { count: number }) {
  return result.count;
}

/** Runner-side second half: called only after local Git cleanup succeeded. */
export async function purgeTaskHardResetState(args: {
  taskId: string;
  resetToken: string;
  actorUserId: string;
  stoppedAgents: string[];
  repositoryPath: string | null;
  branchName: string | null;
}) {
  return db.$transaction(async (tx) => {
    const task = await tx.task.findUnique({
      where: { id: args.taskId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!task) throw new Error("Task disappeared before hard reset completed.");
    const request = await tx.activityLog.findFirst({
      where: { taskId: task.id, kind: "task.reset.requested" },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    let requestedToken: string | null = null;
    try {
      requestedToken = request?.payload
        ? String((JSON.parse(request.payload) as { resetToken?: unknown }).resetToken ?? "")
        : null;
    } catch {
      requestedToken = null;
    }
    if (requestedToken !== args.resetToken) {
      throw new Error("Hard reset request was superseded by a newer request.");
    }

    const chatMessageIds = (await tx.agentChatMessage.findMany({
      where: { taskId: task.id },
      select: { id: true },
    })).map((row) => row.id);

    const purged: Record<string, number> = {};
    if (chatMessageIds.length > 0) {
      purged.proposals = count(await tx.workItemProposal.deleteMany({
        where: { grantMessageId: { in: chatMessageIds } },
      }));
    } else {
      purged.proposals = 0;
    }
    purged.validationChecks = count(await tx.validationCheckRun.deleteMany({ where: { taskId: task.id } }));
    purged.outbox = count(await tx.workflowOutbox.deleteMany({ where: { taskId: task.id } }));
    purged.procedures = count(await tx.taskProcedureRun.deleteMany({ where: { taskId: task.id } }));
    purged.reviewRuns = count(await tx.reviewRun.deleteMany({ where: { taskId: task.id } }));
    purged.repositoryRuns = count(await tx.taskRepositoryRun.deleteMany({ where: { taskId: task.id } }));
    purged.commandReceipts = count(await tx.taskWorkflowCommandReceipt.deleteMany({ where: { taskId: task.id } }));
    purged.transitions = count(await tx.workflowTransition.deleteMany({ where: { taskId: task.id } }));
    purged.cycles = count(await tx.taskWorkflowCycle.deleteMany({ where: { taskId: task.id } }));
    purged.actionPlanRevisions = count(await tx.actionPlanRevision.deleteMany({ where: { taskId: task.id } }));
    purged.actionPlans = count(await tx.actionPlan.deleteMany({ where: { taskId: task.id } }));
    purged.checklist = count(await tx.subTask.deleteMany({ where: { taskId: task.id } }));
    purged.executionEpisodes = count(await tx.taskExecutionEpisode.deleteMany({ where: { taskId: task.id } }));
    purged.executionStates = count(await tx.taskExecutionState.deleteMany({ where: { taskId: task.id } }));
    purged.comments = count(await tx.comment.deleteMany({ where: { taskId: task.id } }));
    purged.chatMessages = count(await tx.agentChatMessage.deleteMany({ where: { taskId: task.id } }));
    purged.chatArchives = count(await tx.agentChatRoomArchive.deleteMany({ where: { taskId: task.id } }));
    purged.deploymentPullRequests = count(await tx.deploymentPullRequest.deleteMany({ where: { taskId: task.id } }));
    purged.contextGrants = count(await tx.contextGrant.deleteMany({ where: { scopeType: "task", scopeId: task.id } }));
    purged.executionLeases = count(await tx.agentExecutionLease.deleteMany({ where: { taskId: task.id } }));
    purged.pmRuns = count(await tx.pmChannelRun.deleteMany({ where: { taskId: task.id } }));
    purged.pmDeliveries = count(await tx.pmEventDelivery.deleteMany({ where: { taskId: task.id } }));
    purged.descriptionDrafts = count(await tx.descriptionDraft.deleteMany({ where: { scope: "task", targetId: task.id } }));
    purged.readCursors = count(await tx.chatReadCursor.deleteMany({ where: { agentSlug: `task:${task.id}` } }));
    purged.activities = count(await tx.activityLog.deleteMany({
      where: { taskId: task.id, kind: { not: "task.create" } },
    }));

    await tx.task.update({
      where: { id: task.id },
      data: {
        status: "Backlog",
        statusChangedAt: new Date(),
        assigneeId: null,
        actingManagerId: null,
        approvedOn: null,
        approvedById: null,
        archivedAt: null,
        archivedById: null,
        deploymentStatus: "Not Required",
        activeWorkflowCycleId: null,
        workflowVersion: 0,
        branchName: null,
        commitPrefix: null,
        alertReporter: false,
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actorUserId,
        kind: "task.reset",
        payload: JSON.stringify({
          hardReset: true,
          resetToken: args.resetToken,
          stoppedAgents: args.stoppedAgents,
          localRepository: args.repositoryPath,
          localBranch: args.branchName,
          purged,
        }),
      },
    });
    return { outcome: "reset" as const, taskId: task.id, purged };
  });
}
