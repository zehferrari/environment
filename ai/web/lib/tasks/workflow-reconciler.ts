import { db } from "@/lib/db";
import { fenceSupersededPmChannelRuns } from "@/lib/agents/pm-channel/supersession";
import { writeTaskExecutionState } from "@/lib/agents/watchdog/state";

const DEFAULT_STALE_MS = 10 * 60_000;
const DEFAULT_LIMIT = 100;

export type WorkflowReconciliationKind =
  | "outbox_delivery_stale"
  | "outbox_delivery_failed"
  | "repository_effect_missing"
  | "repository_projection_stale"
  | "review_lease_missing"
  | "done_repository_incomplete"
  | "cancellation_unacknowledged";

export type WorkflowReconciliationFinding = {
  kind: WorkflowReconciliationKind;
  taskId: string | null;
  rowId: string;
  detail: string;
  repair: "drain" | "requeue" | "retry_cancellation" | "escalate";
  repaired: boolean;
  error: string | null;
};

export type WorkflowReconciliationReport = {
  now: string;
  dryRun: boolean;
  inspectedTasks: number;
  findings: WorkflowReconciliationFinding[];
  repaired: number;
  escalated: number;
  errors: string[];
};

function staleMs() {
  const parsed = Number.parseInt(process.env.PM_WORKFLOW_RECONCILE_STALE_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_STALE_MS;
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).trim().slice(0, 2_000);
}

async function escalateTask(args: {
  taskId: string;
  projectId: string;
  kind: WorkflowReconciliationKind;
  detail: string;
  rowId: string;
  now: Date;
}) {
  const written = await writeTaskExecutionState({
    taskId: args.taskId,
    projectId: args.projectId,
    state: "stalled",
    reasonCode: args.kind,
    reasonDetail: args.detail,
    recoveryAction: "escalated to reporter",
    recoveryAt: args.now,
    detectorId: `workflow_reconciler:${args.kind}`,
  });
  await db.task.updateMany({
    where: { id: args.taskId, deletedAt: null },
    data: { alertReporter: true },
  });
  if (written) {
    await db.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: args.taskId,
        kind: "task.workflow.reconciliation_required",
        payload: JSON.stringify({ kind: args.kind, rowId: args.rowId, detail: args.detail }),
      },
    });
  }
}

/**
 * Reconcile durable workflow decisions with their asynchronous projections.
 * Safe repairs only: reclaim/requeue a recorded effect or retry a recorded
 * cancellation fence. Missing evidence is escalated, never guessed.
 */
export async function runWorkflowReconciliation(options: {
  projectId?: string;
  now?: Date;
  dryRun?: boolean;
  limit?: number;
} = {}): Promise<WorkflowReconciliationReport> {
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - staleMs());
  const limit = Math.max(1, Math.min(500, options.limit ?? DEFAULT_LIMIT));
  const dryRun = options.dryRun ?? false;
  const findings: WorkflowReconciliationFinding[] = [];
  const errors: string[] = [];
  let repaired = 0;
  let escalated = 0;

  const tasks = await db.task.findMany({
    where: {
      deletedAt: null,
      ...(options.projectId ? { projectId: options.projectId } : {}),
      OR: [
        { status: { in: ["Review", "Done"] } },
        { repositoryRun: { is: { phase: { in: ["validating", "finalizing"] } } } },
        { workflowOutbox: { some: { status: { in: ["queued", "dispatching", "failed"] } } } },
      ],
    },
    take: limit,
    select: {
      id: true,
      projectId: true,
      status: true,
      workflowVersion: true,
      repositoryRun: {
        select: { id: true, phase: true, updatedAt: true },
      },
      reviewRuns: {
        where: { status: { in: ["validating", "awaiting_review", "accepted"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, candidateSha: true, updatedAt: true },
      },
      workflowOutbox: {
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          effectType: true,
          status: true,
          availableAt: true,
          leaseExpiresAt: true,
          updatedAt: true,
          lastError: true,
        },
      },
    },
  });

  const findingKeys = new Set<string>();
  const add = (finding: WorkflowReconciliationFinding) => {
    const key = `${finding.kind}:${finding.rowId}`;
    if (findingKeys.has(key)) return;
    findingKeys.add(key);
    findings.push(finding);
  };

  for (const task of tasks) {
    for (const effect of task.workflowOutbox) {
      const queuedStale = effect.status === "queued"
        && effect.availableAt.getTime() <= now.getTime()
        && effect.updatedAt.getTime() <= staleBefore.getTime();
      const leaseExpired = effect.status === "dispatching"
        && Boolean(effect.leaseExpiresAt && effect.leaseExpiresAt.getTime() <= now.getTime());
      if (queuedStale || leaseExpired) {
        add({
          kind: "outbox_delivery_stale",
          taskId: task.id,
          rowId: effect.id,
          detail: leaseExpired
            ? `${effect.effectType} dispatcher lease expired before completion`
            : `${effect.effectType} remained queued beyond the reconciliation grace period`,
          repair: "drain",
          repaired: false,
          error: null,
        });
      } else if (effect.status === "failed") {
        add({
          kind: "outbox_delivery_failed",
          taskId: task.id,
          rowId: effect.id,
          detail: `${effect.effectType} exhausted its delivery attempts${effect.lastError ? `: ${effect.lastError}` : ""}`,
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }

    const repository = task.repositoryRun;
    if (repository && repository.updatedAt.getTime() <= staleBefore.getTime()
      && (repository.phase === "validating" || repository.phase === "finalizing")) {
      const effectType = repository.phase === "validating" ? "branch_verify" : "review_finalize";
      const effect = task.workflowOutbox.find((row) => row.effectType === effectType);
      if (!effect) {
        add({
          kind: "repository_effect_missing",
          taskId: task.id,
          rowId: repository.id,
          detail: `${repository.phase} repository state has no durable ${effectType} effect to execute`,
          repair: "escalate",
          repaired: false,
          error: null,
        });
      } else if (effect.status === "completed" && effect.updatedAt.getTime() <= staleBefore.getTime()) {
        add({
          kind: "repository_projection_stale",
          taskId: task.id,
          rowId: effect.id,
          detail: `${effectType} was projected, but repository state remained ${repository.phase}`,
          repair: "requeue",
          repaired: false,
          error: null,
        });
      }
    }

    if (task.status === "Review" && repository?.phase === "review_ready") {
      const awaiting = task.reviewRuns.some((run) => run.status === "awaiting_review");
      if (!awaiting) {
        add({
          kind: "review_lease_missing",
          taskId: task.id,
          rowId: repository.id,
          detail: "task is in Review with a review-ready repository candidate but no active ReviewRun lease",
          repair: "escalate",
          repaired: false,
          error: null,
        });
      }
    }
    if (task.status === "Done" && repository && repository.phase !== "completed") {
      add({
        kind: "done_repository_incomplete",
        taskId: task.id,
        rowId: repository.id,
        detail: `task is Done while its repository lifecycle is ${repository.phase}, not completed`,
        repair: "escalate",
        repaired: false,
        error: null,
      });
    }
  }

  const cancellationRows = await db.pmChannelRun.findMany({
    where: {
      cancellationRequestedAt: { lte: staleBefore },
      cancellationAcknowledgedAt: null,
      supersededByRunId: { not: null },
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
    take: Math.min(limit, 20),
    select: { id: true, taskId: true, projectId: true, supersededByRunId: true, cancellationError: true },
  });
  for (const row of cancellationRows) {
    add({
      kind: "cancellation_unacknowledged",
      taskId: row.taskId,
      rowId: row.id,
      detail: row.cancellationError
        ? `superseded process cancellation is not fenced: ${row.cancellationError}`
        : "superseded process cancellation was requested but never acknowledged",
      repair: "retry_cancellation",
      repaired: false,
      error: null,
    });
  }

  if (!dryRun) {
    for (const finding of findings) {
      try {
        if (finding.repair === "requeue") {
          const changed = await db.workflowOutbox.updateMany({
            where: { id: finding.rowId, status: "completed", updatedAt: { lte: staleBefore } },
            data: {
              status: "queued",
              attempts: 0,
              availableAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              completedAt: null,
              lastError: "Requeued by workflow reconciler after stale downstream state.",
            },
          });
          finding.repaired = changed.count === 1;
        } else if (finding.repair === "drain") {
          // The generic outbox drain immediately follows this pass in the PM
          // worker. Expired leases are claimable without rewriting them here.
          finding.repaired = true;
        } else if (finding.repair === "retry_cancellation") {
          const row = cancellationRows.find((candidate) => candidate.id === finding.rowId);
          if (!row?.supersededByRunId) continue;
          const result = await fenceSupersededPmChannelRuns({ replacementRunId: row.supersededByRunId });
          finding.repaired = result.ok;
          if (!result.ok) finding.error = result.error;
        } else if (finding.taskId) {
          const task = tasks.find((candidate) => candidate.id === finding.taskId);
          if (!task) continue;
          await escalateTask({
            taskId: task.id,
            projectId: task.projectId,
            kind: finding.kind,
            detail: finding.detail,
            rowId: finding.rowId,
            now,
          });
          finding.repaired = true;
          escalated += 1;
        }
        if (finding.repaired) repaired += 1;
      } catch (error) {
        finding.error = errorText(error);
        errors.push(`${finding.kind}/${finding.rowId}: ${finding.error}`);
      }
    }
  }

  return {
    now: now.toISOString(),
    dryRun,
    inspectedTasks: tasks.length,
    findings,
    repaired,
    escalated,
    errors,
  };
}
