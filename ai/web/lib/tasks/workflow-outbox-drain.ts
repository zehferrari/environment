import { db } from "@/lib/db";
import { writeDeduplicatedActivity, computeActivityDedupeKey } from "@/lib/tasks/orchestrator/activity-dedup";
import { enqueueBranchVerifyJob, type BranchVerifyJob } from "@/lib/deploy/branch-verify";
import {
  enqueueEpicCompletionReview,
  enqueueEpicCompletionReviewApproval,
  enqueueEpicDoneCleanup,
  enqueueTaskCheckpoint,
  enqueueTaskReviewFinalization,
} from "@/lib/deploy/epic-merge";
import type { TaskWorkflowNotificationReason } from "@/lib/agents/workflow/notifications/task";
import { deliverTaskWorkflowNotification } from "@/lib/tasks/workflow-notification-delivery";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { refillDependentEpicQueuesForDoneTask } from "@/lib/epics/queue";

const MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60_000;
const DEFAULT_BATCH = 20;

class TerminalWorkflowEffectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalWorkflowEffectError";
  }
}

type OutboxRow = {
  id: string;
  taskId: string;
  projectId: string;
  transitionId: string | null;
  workflowCycleId: string | null;
  effectType: string;
  payload: string;
  dedupeKey: string;
  attempts: number;
};

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 2_000);
}

function objectPayload(row: OutboxRow) {
  const parsed: unknown = JSON.parse(row.payload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Workflow outbox ${row.id} payload is not an object.`);
  }
  return parsed as Record<string, unknown>;
}

async function dispatch(row: OutboxRow) {
  const payload = objectPayload(row);
  if (row.effectType === "branch_verify") {
    await enqueueBranchVerifyJob(payload.job as unknown as BranchVerifyJob);
    return;
  }
  if (row.effectType === "review_finalize") {
    // ORCH-07/P0-4: preserve procedure context so the finalization callback
    // can route back to the procedure engine.
    const result = await enqueueTaskReviewFinalization({
      taskId: String(payload.taskId),
      projectId: String(payload.projectId),
      requestedByUserId: String(payload.requestedByUserId),
      requestedByUsername: String(payload.requestedByUsername),
      candidateSha: String(payload.candidateSha),
      procedureRunId: typeof payload.procedureRunId === "string" ? payload.procedureRunId : undefined,
      procedureStepId: typeof payload.procedureStepId === "string"
        ? payload.procedureStepId
        : typeof payload.stepId === "string" ? payload.stepId : undefined,
      workflowCycleId: typeof payload.workflowCycleId === "string" || payload.workflowCycleId === null
        ? payload.workflowCycleId
        : undefined,
      schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : undefined,
      commandReceiptId: typeof payload.commandReceiptId === "string" || payload.commandReceiptId === null
        ? payload.commandReceiptId
        : undefined,
      repositoryRunId: typeof payload.repositoryRunId === "string" || payload.repositoryRunId === null
        ? payload.repositoryRunId
        : undefined,
      repositoryRunVersion: typeof payload.repositoryRunVersion === "number" || payload.repositoryRunVersion === null
        ? payload.repositoryRunVersion
        : undefined,
      baseSha: typeof payload.baseSha === "string" || payload.baseSha === null
        ? payload.baseSha
        : undefined,
    });
    if (result.blockedByFailedJob) {
      throw new Error("A failed repository finalization spool job requires operator recovery.");
    }
    return;
  }
  if (row.effectType === "epic_cleanup") {
    const result = await enqueueEpicDoneCleanup(String(payload.epicId));
    if (result.blockedByFailedJob) {
      throw new TerminalWorkflowEffectError(
        "A failed Epic cleanup job requires operator recovery.",
      );
    }
    return;
  }
  if (row.effectType === "epic_completion_review") {
    const result = await enqueueEpicCompletionReview(String(payload.epicId));
    if (result.blockedByFailedJob) {
      throw new TerminalWorkflowEffectError(
        "A failed whole-Epic acceptance preparation job requires operator recovery.",
      );
    }
    return;
  }
  if (row.effectType === "epic_completion_review_approval") {
    const result = await enqueueEpicCompletionReviewApproval({
      epicId: String(payload.epicId),
      projectId: row.projectId,
      requestedByUserId: String(payload.requestedByUserId),
      requestedByUsername: String(payload.requestedByUsername),
      expectedCandidateSha: typeof payload.expectedCandidateSha === "string"
        ? payload.expectedCandidateSha
        : null,
    });
    if (result.blockedByFailedJob) {
      throw new TerminalWorkflowEffectError(
        "A failed whole-Epic acceptance approval job requires operator recovery.",
      );
    }
    return;
  }
  if (row.effectType === "task_notification") {
    const actorRaw = payload.actor;
    if (!actorRaw || typeof actorRaw !== "object" || Array.isArray(actorRaw)) {
      throw new Error("Task notification outbox payload has no actor.");
    }
    const actor = actorRaw as Record<string, unknown>;
    const delivered = await deliverTaskWorkflowNotification({
      taskId: String(payload.taskId),
      targetUserId: String(payload.targetUserId),
      actor: {
        id: String(actor.id),
        kind: actor.kind === "agent" ? "agent" : "human",
        username: typeof actor.username === "string" ? actor.username : null,
      },
      reason: String(payload.reason) as TaskWorkflowNotificationReason,
      body: String(payload.body),
      dedupeKey: row.dedupeKey,
      workflowCycleId: row.workflowCycleId,
    });
    if (delivered.status === "permanent_failure") throw new TerminalWorkflowEffectError(delivered.error);
    if (delivered.status === "retryable_failure") throw new Error(delivered.error);
    if (delivered.status === "skipped") {
      await writeDeduplicatedActivity({
        taskId: row.taskId, projectId: row.projectId,
        kind: "task.workflow.notification_skipped",
        dedupeKey: `notification-skipped:${row.id}`,
        payload: { outboxId: row.id, reason: delivered.reason },
      });
    }
    return;
  }
  if (row.effectType === "repository_checkpoint") {
    const result = await enqueueTaskCheckpoint({
      taskId: String(payload.taskId),
      projectId: String(payload.projectId),
      requestedByUserId: String(payload.requestedByUserId),
      requestedByUsername: String(payload.requestedByUsername),
      authorizationCommentId: typeof payload.authorizationCommentId === "string" ? payload.authorizationCommentId : undefined,
      standingAuthorizationId: typeof payload.standingAuthorizationId === "string" ? payload.standingAuthorizationId : undefined,
      publicationAttemptId: typeof payload.publicationAttemptId === "string" ? payload.publicationAttemptId : undefined,
      note: String(payload.note),
    });
    if (result.blockedByFailedJob) {
      throw new TerminalWorkflowEffectError(
        "A failed checkpoint runner job requires operator recovery.",
      );
    }
    return;
  }
  if (row.effectType === "board_touch") {
    publishBoardTouch(row.projectId);
    return;
  }
  if (row.effectType === "dependency_refill") {
    await refillDependentEpicQueuesForDoneTask({
      prerequisiteTaskId: String(payload.prerequisiteTaskId),
      actorUserId: typeof payload.actorUserId === "string" ? payload.actorUserId : null,
      trigger: {
        kind: row.transitionId ? "workflow_transition" : "command_receipt",
        id: row.transitionId ?? row.id,
      },
    });
    return;
  }
  throw new Error(`Unsupported workflow outbox effect type: ${row.effectType}`);
}

async function escalate(row: OutboxRow, message: string) {
  const payload = objectPayload(row);
  if (
    row.effectType === "epic_completion_review" ||
    row.effectType === "epic_completion_review_approval"
  ) {
    const epicId = String(payload.epicId);
    await db.$transaction([
      db.epic.updateMany({
        where: { id: epicId, status: "Review" },
        data: {
          completionReviewStatus: "Operational Error",
          completionReviewLastError: message,
        },
      }),
    ]);
    await writeDeduplicatedActivity({
      projectId: row.projectId,
      taskId: row.taskId,
      kind: "epic.completion_review.operational_error",
      payload: {
        epicId,
        outboxId: row.id,
        dedupeKey: row.dedupeKey,
        effectType: row.effectType,
        attempts: row.attempts,
        error: message,
        via: "workflow_outbox",
      },
      dedupeKey: computeActivityDedupeKey("epic.completion_review.operational_error", row.taskId, {
        outboxId: row.id,
        effectType: row.effectType,
        error: message,
      }),
    });
    return;
  }
  await writeDeduplicatedActivity({
    projectId: row.projectId,
    taskId: row.taskId,
    kind: "task.workflow.effect_failed",
    payload: {
      outboxId: row.id,
      dedupeKey: row.dedupeKey,
      effectType: row.effectType,
      attempts: row.attempts,
      error: message,
    },
    dedupeKey: computeActivityDedupeKey("task.workflow.effect_failed", row.taskId, {
      outboxId: row.id,
      effectType: row.effectType,
      error: message,
    }),
  });
}

export async function drainWorkflowOutbox(args: {
  limit?: number;
  now?: Date;
  workerId?: string;
} = {}) {
  const now = args.now ?? new Date();
  const limit = Math.max(1, Math.min(100, args.limit ?? DEFAULT_BATCH));
  const workerId = args.workerId ?? `workflow-outbox:${process.pid}`;
  let completed = 0;
  let retried = 0;
  let failed = 0;

  for (let index = 0; index < limit; index += 1) {
    const candidate = await db.workflowOutbox.findFirst({
      where: {
        OR: [
          { status: "queued", availableAt: { lte: now } },
          { status: "dispatching", leaseExpiresAt: { lte: now } },
        ],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
      select: { id: true, status: true, leaseExpiresAt: true },
    });
    if (!candidate) break;

    const claimed = await db.workflowOutbox.updateMany({
      where: {
        id: candidate.id,
        OR: [
          { status: "queued", availableAt: { lte: now } },
          { status: "dispatching", leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: "dispatching",
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) continue;
    const row = await db.workflowOutbox.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        taskId: true,
        projectId: true,
        transitionId: true,
        workflowCycleId: true,
        effectType: true,
        payload: true,
        dedupeKey: true,
        attempts: true,
      },
    });
    if (!row) continue;

    try {
      await dispatch(row);
      const settled = await db.workflowOutbox.updateMany({
        where: { id: row.id, status: "dispatching", leaseOwner: workerId },
        data: {
          status: "completed",
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (settled.count === 1) completed += 1;
    } catch (error) {
      const message = errorText(error);
      const terminal = error instanceof TerminalWorkflowEffectError || row.attempts >= MAX_ATTEMPTS;
      await db.workflowOutbox.updateMany({
        where: { id: row.id, status: "dispatching", leaseOwner: workerId },
        data: {
          status: terminal ? "failed" : "queued",
          availableAt: new Date(now.getTime() + Math.min(15 * 60_000, 15_000 * 2 ** Math.min(row.attempts, 6))),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: message,
        },
      });
      if (terminal) {
        failed += 1;
        await escalate(row, message).catch(() => {});
      } else {
        retried += 1;
      }
    }
  }
  return { completed, retried, failed };
}
