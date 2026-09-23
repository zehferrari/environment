import type { Prisma } from "@prisma/client";
import {
  applyTaskTransition,
  enqueueWorkflowEffects,
  isTaskWorkflowStatus,
  type WorkflowEffect as KernelWorkflowEffect,
} from "@/lib/tasks/transition-kernel";
import {
  closeTaskWorkflowCycle,
  openTaskWorkflowCycle,
  updateTaskWorkflowCycleCandidate,
} from "@/lib/tasks/workflow-cycle";
import { createProcedureRun } from "@/lib/tasks/orchestrator/procedure-runner";
import {
  ALLOWED_ENGINES,
  stampCycleEngine,
  type WorkflowEngine,
} from "@/lib/tasks/orchestrator/ownership";
import {
  computeRequestFingerprint,
  findOrCreateReceipt,
} from "@/lib/tasks/orchestrator/receipts";
import type { ReceiptOutcome } from "@/lib/tasks/orchestrator/receipts";
import type {
  OrchestrationDecision,
  OrchestratorResult,
  TaskWorkflowCommand,
} from "@/lib/tasks/orchestrator/types";
import type { TaskAggregate } from "@/lib/tasks/orchestrator/state";
import { acceptanceChecklistSnapshot } from "@/lib/tasks/acceptance";
import { releaseTaskDevLease } from "@/lib/deploy/dev-publication";

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "P2002";
}

function toKernelEffect(effect: OrchestrationDecision["effects"][number]): KernelWorkflowEffect {
  return {
    type: effect.type,
    key: effect.key,
    payload: effect.payload,
    ...(effect.availableAt ? { availableAt: effect.availableAt } : {}),
  };
}

/**
 * Internal control-flow signal: a receipt won concurrently after this
 * transaction began. Throwing rolls back every tentative intent write while
 * preserving the exact replay/conflict result for execute.ts.
 */
export type IntentReceiptResolutionKind = Extract<
  ReceiptOutcome["kind"],
  "replay" | "race_replay" | "conflict" | "race_conflict"
>;

export class IntentReceiptResolution extends Error {
  constructor(
    readonly kind: IntentReceiptResolutionKind,
    readonly result: OrchestratorResult,
  ) {
    super("intent_receipt_resolution");
  }
}

export function getIntentReceiptResolution(error: unknown): {
  kind: IntentReceiptResolutionKind;
  result: OrchestratorResult;
} | null {
  return error instanceof IntentReceiptResolution
    ? { kind: error.kind, result: error.result }
    : null;
}

export async function executeDecisionWrites(args: {
  tx: Prisma.TransactionClient;
  state: TaskAggregate;
  command: TaskWorkflowCommand;
  decision: OrchestrationDecision;
  transactionStartedAtMs?: number;
  /**
   * Optional command-boundary projection applied after every domain,
   * transition, procedure and outbox write, but before the durable receipt.
   * PHASEE-05 uses it for PM run/episode bookkeeping so the receipt stores the
   * exact committed disposition instead of a response-time reconstruction.
   */
  projectResult?: (result: OrchestratorResult) => Promise<OrchestratorResult>;
}): Promise<OrchestratorResult> {
  const { tx, command, decision } = args;
  const isNoOp = decision.fromStatus === decision.toStatus
    && decision.kernelIntent === "operator_override";

  // Cycle ordering is deliberate: open/update before the transition; close
  // after it with the transition id, because close clears the task pointer.
  let cycleId: string | null = null;
  if (decision.cycleOperation === "open") {
    const cycle = await openTaskWorkflowCycle(tx, {
      taskId: command.taskId,
      openedWorkflowVersion: command.expectedWorkflowVersion + 1,
      baseSha: (decision.evidence.baseSha as string | undefined) ?? null,
    });
    cycleId = cycle.id;
    if (!ALLOWED_ENGINES.has(args.state.workflowEngine)) {
      throw new Error(`invalid_workflow_engine:${args.state.workflowEngine}`);
    }
    await stampCycleEngine(tx, cycle.id, args.state.workflowEngine as WorkflowEngine);
  } else if (decision.cycleOperation === "update") {
    const updated = await updateTaskWorkflowCycleCandidate(tx, {
      taskId: command.taskId,
      candidateSha: (decision.evidence.candidateSha as string | undefined) ?? null,
      baseSha: decision.evidence.baseSha as string | undefined,
    });
    cycleId = updated?.id ?? null;
  } else if (decision.cycleOperation === "none") {
    cycleId = args.state.activeWorkflowCycleId;
  }

  let transitionId: string | null = null;
  let workflowVersion = command.expectedWorkflowVersion;
  let kernelReplayed = false;
  if (!isNoOp && isTaskWorkflowStatus(decision.fromStatus) && isTaskWorkflowStatus(decision.toStatus)) {
    const result = await applyTaskTransition(tx, {
      taskId: command.taskId,
      projectId: args.state.projectId,
      actorUserId: decision.decisionActorId,
      intent: decision.kernelIntent,
      from: decision.fromStatus,
      to: decision.toStatus,
      source: command.source,
      idempotencyKey: command.idempotencyKey,
      expectedVersion: command.expectedWorkflowVersion,
      evidence: decision.evidence,
      rank: decision.rank,
      taskData: decision.taskData as Prisma.TaskUncheckedUpdateManyInput | undefined,
      effects: decision.effects.map(toKernelEffect),
    });
    transitionId = result.transition.id;
    workflowVersion = result.transition.workflowVersion;
    kernelReplayed = result.replayed;
  } else {
    if (decision.taskData && Object.keys(decision.taskData).length > 0) {
      const updated = await tx.task.updateMany({
        where: {
          id: command.taskId,
          status: decision.fromStatus,
          workflowVersion: command.expectedWorkflowVersion,
          deletedAt: null,
        },
        data: decision.taskData as Prisma.TaskUncheckedUpdateManyInput,
      });
      if (updated.count !== 1) {
        throw new Error("version_conflict: task changed while committing workflow no-op data");
      }
    }
    await tx.activityLog.create({
      data: {
        projectId: args.state.projectId,
        taskId: command.taskId,
        userId: decision.decisionActorId,
        kind: `task.workflow.${command.intent}`,
        payload: JSON.stringify({
          intent: command.intent,
          from: decision.fromStatus,
          to: decision.toStatus,
          workflowVersion: command.expectedWorkflowVersion,
          decisionActorId: decision.decisionActorId,
          executorActorId: decision.executorActorId ?? null,
          cycleId,
          idempotencyKey: command.idempotencyKey,
          ...command.evidence ?? {},
        }),
      },
    });
    if (decision.effects.length > 0) {
      await enqueueWorkflowEffects(tx, {
        taskId: command.taskId,
        projectId: args.state.projectId,
        aggregateVersion: command.expectedWorkflowVersion,
        workflowCycleId: cycleId,
        effects: decision.effects.map(toKernelEffect),
      });
    }
  }

  if (decision.toStatus === "Done" || command.intent === "cancel_task") {
    await releaseTaskDevLease(tx, { taskId: command.taskId });
  }

  if (decision.cycleOperation === "open" && cycleId && transitionId) {
    await tx.taskWorkflowCycle.update({
      where: { id: cycleId },
      data: { openedByTransitionId: transitionId },
    });
  }

  if (decision.cycleOperation === "close") {
    const closed = await closeTaskWorkflowCycle(tx, {
      taskId: command.taskId,
      outcome: decision.cycleOutcome ?? "abandoned",
      closedWorkflowVersion: workflowVersion,
      closedByTransitionId: transitionId,
      candidateSha: (decision.evidence.candidateSha as string | undefined) ?? null,
    });
    cycleId = closed?.id ?? cycleId;
  }

  if (command.intent === "request_review_changes" || command.intent === "accept_review") {
    const lease = await tx.reviewRun.findFirst({
      where: {
        taskId: command.taskId,
        status: command.intent === "request_review_changes"
          ? { in: ["awaiting_review", "accepted", "accepted_pending_owner"] }
          : "awaiting_review",
      },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    if (lease) {
      const acceptance = command.intent === "accept_review" ? await acceptanceChecklistSnapshot(tx, command.taskId) : null;
      if (acceptance) {
        const pendingOwner = await tx.subTask.count({ where: { taskId: command.taskId,
          kind: { not: "superseded" }, responsibleActor: "owner", acceptanceGate: "task", completedAt: null } });
        decision.evidence.acceptancePendingOwner = pendingOwner > 0;
        decision.procedureType = pendingOwner ? undefined : "finalize_accepted_review";
      }
      await tx.reviewRun.updateMany({
        where: {
          id: lease.id,
          status: command.intent === "request_review_changes"
            ? { in: ["awaiting_review", "accepted", "accepted_pending_owner"] }
            : "awaiting_review",
        },
        data: {
          status: command.intent === "request_review_changes" ? "changes_requested" : decision.evidence.acceptancePendingOwner ? "accepted_pending_owner" : "accepted",
          reviewerId: decision.decisionActorId,
          reviewedAt: new Date(),
          ...(acceptance ? { acceptancePlanVersion: acceptance.planVersion, acceptanceChecklistHash: acceptance.checklistHash } : {}),
        },
      });
      if (command.intent === "accept_review" && decision.evidence.acceptancePendingOwner) {
        const owners = await tx.user.findMany({ where: { kind: "human", isOwner: true, status: "active" }, select: { id: true } });
        await enqueueWorkflowEffects(tx, {
          taskId: command.taskId, projectId: args.state.projectId,
          aggregateVersion: workflowVersion, workflowCycleId: cycleId,
          effects: owners.map(owner => ({ type: "task_notification" as const, key: `owner-acceptance:${lease.id}:${owner.id}`, payload: {
            taskId: command.taskId, targetUserId: owner.id, actor: command.actor, reason: "owner_acceptance_required",
            body: "The reviewer accepted the current candidate. Complete the remaining owner acceptance checks with observed evidence to let PM finalize this recorded verdict.",
          } })),
        });
      }
    }
  }

  let procedureId: string | null = null;
  if (decision.procedureType) {
    const activeProcedureWhere: Prisma.TaskProcedureRunWhereInput = {
      taskId: command.taskId,
      type: decision.procedureType,
      workflowCycleId: cycleId,
      status: { in: ["queued", "running"] },
    };
    const existing = await tx.taskProcedureRun.findFirst({
      where: activeProcedureWhere,
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    let procedureReused = existing !== null;
    if (existing) {
      procedureId = existing.id;
    } else {
      try {
        const created = await createProcedureRun(tx, {
          taskId: command.taskId,
          workflowCycleId: cycleId,
          triggerTransitionId: transitionId ?? command.idempotencyKey,
          type: decision.procedureType,
          input: command.payload,
        });
        procedureId = created.procedureRunId;
      } catch (error) {
        if (!isPrismaUniqueConstraintError(error)) throw error;
        const winner = await tx.taskProcedureRun.findFirst({
          where: activeProcedureWhere,
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (!winner) throw error;
        procedureId = winner.id;
        procedureReused = true;
      }
    }
    await tx.activityLog.create({
      data: {
        projectId: args.state.projectId,
        taskId: command.taskId,
        userId: decision.decisionActorId,
        kind: "task.workflow.procedure_scheduled",
        payload: JSON.stringify({
          procedureType: decision.procedureType,
          procedureRunId: procedureId,
          cycleId,
          transitionId,
          workflowVersion,
          intent: command.intent,
          reused: procedureReused,
        }),
      },
    });
  }

  const baseResult: OrchestratorResult = kernelReplayed
    ? { status: "replayed", transitionId: transitionId!, workflowVersion, procedureId }
    : {
        status: "accepted",
        transitionId: transitionId ?? command.idempotencyKey,
        workflowVersion,
        procedureId,
        cycleId,
      };
  const result = args.projectResult
    ? await args.projectResult(baseResult)
    : baseResult;
  const receipt = await findOrCreateReceipt(
    tx,
    command,
    computeRequestFingerprint(command),
    result,
    {
      workflowCycleId: cycleId,
      transitionId,
      procedureRunId: procedureId,
      decisionActorId: decision.decisionActorId,
      executorActorId: decision.executorActorId,
      executionDurationMs: args.transactionStartedAtMs === undefined
        ? null
        : Math.max(0, Date.now() - args.transactionStartedAtMs),
    },
  );
  if (receipt.kind === "replay" || receipt.kind === "race_replay") {
    throw new IntentReceiptResolution(receipt.kind, receipt.result);
  }
  if (receipt.kind === "conflict" || receipt.kind === "race_conflict") {
    throw new IntentReceiptResolution(receipt.kind, {
      status: "invalid",
      reason: "idempotency_conflict: idempotency key reused with different payload.",
      domainCode: "idempotency_conflict",
    });
  }
  return result;
}
