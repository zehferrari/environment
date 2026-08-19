import type { Prisma } from "@prisma/client";
import { submitWorkflowCommandInTransaction } from "@/lib/tasks/orchestrator";
import type {
  EpicChildUpdatePayload,
  OrchestratorResult,
  WorkflowActor,
} from "@/lib/tasks/orchestrator/types";

export class EpicChildWorkflowCommandError extends Error {
  readonly result: OrchestratorResult;

  constructor(result: OrchestratorResult) {
    super(`Epic child workflow command rejected: ${result.status} — ${"reason" in result ? result.reason : "unknown error"}`);
    this.name = "EpicChildWorkflowCommandError";
    this.result = result;
  }
}

/**
 * Transaction-only Epic adapter. Epic state and every child command share the
 * caller's transaction, so a stale/rejected child rolls the entire fan-out
 * back instead of leaving a partially updated Epic.
 */
export async function submitEpicChildUpdateInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    taskId: string;
    workflowVersion: number;
    workflowCycleId?: string | null;
    actor: WorkflowActor;
    source: "browser" | "agent" | "pm-service";
    idempotencyKey: string;
    payload: EpicChildUpdatePayload;
    evidence?: Record<string, unknown>;
  },
): Promise<Extract<OrchestratorResult, { status: "accepted" | "replayed" }>> {
  const result = await submitWorkflowCommandInTransaction(tx, {
    taskId: args.taskId,
    intent: "epic_child_update",
    actor: args.actor,
    expectedWorkflowVersion: args.workflowVersion,
    workflowCycleId: args.workflowCycleId ?? null,
    source: args.source,
    idempotencyKey: args.idempotencyKey,
    evidence: args.evidence,
    payload: args.payload,
  });
  if (result.status !== "accepted" && result.status !== "replayed") {
    throw new EpicChildWorkflowCommandError(result);
  }

  // Canonical operator-override decisions intentionally record a no-op when
  // the workflow status is unchanged. Epic callbacks still need their
  // status-adjacent metadata (front-of-queue, archive, assignment and plan
  // approval) applied atomically. Do that only for the first accepted command;
  // an exact receipt replay must never re-rank or re-time the task.
  if (result.status === "accepted" && result.workflowVersion === args.workflowVersion) {
    const task = await tx.task.findUnique({
      where: { id: args.taskId },
      select: { projectId: true, status: true },
    });
    if (!task || task.status !== args.payload.targetStatus) {
      throw new Error(`Epic child no-op metadata fence failed for task ${args.taskId}.`);
    }
    let rank: number | undefined;
    if (!args.payload.archive) {
      const where = {
        projectId: task.projectId,
        status: args.payload.targetStatus,
        archivedAt: null,
        deletedAt: null,
      } satisfies Prisma.TaskWhereInput;
      if (args.payload.rank === "front") {
        const edge = await tx.task.aggregate({ where, _min: { rank: true } });
        rank = (edge._min.rank ?? 0) - 1;
      } else {
        const edge = await tx.task.aggregate({ where, _max: { rank: true } });
        rank = (edge._max.rank ?? 0) + 1;
      }
    }
    const updated = await tx.task.updateMany({
      where: {
        id: args.taskId,
        status: args.payload.targetStatus,
        workflowVersion: args.workflowVersion,
        deletedAt: null,
      },
      data: {
        ...(rank !== undefined ? { rank } : {}),
        ...(args.payload.clearAssignee ? { assigneeId: null } : {}),
        ...(args.payload.clearArchive ? { archivedAt: null, archivedById: null } : {}),
        ...(args.payload.resetPlanApproval ? { approvedOn: null, approvedById: null } : {}),
        ...(args.payload.archive ? { archivedAt: new Date(), archivedById: args.actor.id } : {}),
      },
    });
    if (updated.count !== 1) {
      throw new Error(`Epic child no-op metadata changed concurrently for task ${args.taskId}.`);
    }
  }
  return result;
}
