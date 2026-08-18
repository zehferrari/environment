// ORCH-02 — Transaction boundary for workflow command execution.
//
// Executes an OrchestrationDecision in one database transaction:
//   1. Performs the cycle operation (open/update/close) via workflow-cycle.
//   2. Calls applyTaskTransition (the only Task.status writer) for status
//      changes. For no-op transitions (status unchanged), records an activity
//      row without a kernel call.
//   3. Enqueues the declared outbox effects.
//   4. Creates the procedure run record (ORCH-03 fills the step engine; for
//      now this is a stub that records the procedure type for the projection).
//
// Invariant 4: atomic decision and effects — the transition + cycle mutation
// + outbox + procedure records commit in one transaction.
// Invariant 1: single status writer — only applyTaskTransition writes
// Task.status.
//
// Idempotency (invariant 3): the command's idempotencyKey is scoped to the
// cycle and intent. A replay of the same command returns the original
// transition without side effects.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
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
import type {
  OrchestrationDecision,
  OrchestratorResult,
  TaskWorkflowCommand,
} from "@/lib/tasks/orchestrator/types";

const EXECUTE_TRANSACTION_TIMEOUT_MS = 15_000;

function toKernelEffect(effect: OrchestrationDecision["effects"][number]): KernelWorkflowEffect {
  return {
    type: effect.type,
    key: effect.key,
    payload: effect.payload,
    ...(effect.availableAt ? { availableAt: effect.availableAt } : {}),
  };
}

/**
 * Execute a workflow command's decision atomically. Returns:
 *   - "replayed" if the idempotencyKey was already committed.
 *   - "accepted" if the decision committed and its procedure is running.
 *   - "stale" if the workflow version changed (409).
 *   - "operational" if the transaction failed (503).
 *
// The procedure engine (ORCH-03) owns ordered step execution. This function
// records the procedure row; the runner picks it up asynchronously.
 */
export async function executeWorkflowCommand(
  command: TaskWorkflowCommand,
  decision: OrchestrationDecision,
): Promise<OrchestratorResult> {
  try {
    return await db.$transaction(
      async (tx) => {
        const isNoOp = decision.fromStatus === decision.toStatus && decision.kernelIntent === "operator_override";

        // --- Cycle operation (open/update BEFORE transition, close AFTER) --
        // P1-7 fix: closing the cycle clears Task.activeWorkflowCycleId,
        // which would make the subsequent kernel transition get
        // workflowCycleId = null. So we open/update before the transition,
        // but close AFTER the transition writes, then pass the transition
        // ID to closeTaskWorkflowCycle.
        let cycleId: string | null = null;
        if (decision.cycleOperation === "open") {
          const cycle = await openTaskWorkflowCycle(tx, {
            taskId: command.taskId,
            openedWorkflowVersion: command.expectedWorkflowVersion + 1,
            baseSha: (command.evidence?.baseSha as string | undefined) ?? null,
          });
          cycleId = cycle.id;
        } else if (decision.cycleOperation === "update") {
          const updated = await updateTaskWorkflowCycleCandidate(tx, {
            taskId: command.taskId,
            candidateSha: (command.evidence?.candidateSha as string | undefined) ?? null,
            baseSha: (command.evidence?.baseSha as string | undefined),
          });
          cycleId = updated?.id ?? null;
        } else if (decision.cycleOperation === "none") {
          const task = await tx.task.findUnique({
            where: { id: command.taskId },
            select: { activeWorkflowCycleId: true },
          });
          cycleId = task?.activeWorkflowCycleId ?? null;
        }
        // "close" is deferred until after the transition kernel writes.

        // --- Transition kernel (single status writer) --------------------
        let transitionId: string | null = null;
        let workflowVersion = command.expectedWorkflowVersion;
        if (!isNoOp && isTaskWorkflowStatus(decision.fromStatus) && isTaskWorkflowStatus(decision.toStatus)) {
          const task = await tx.task.findUniqueOrThrow({ where: { id: command.taskId }, select: { projectId: true } });
          const result = await applyTaskTransition(tx, {
            taskId: command.taskId,
            projectId: task.projectId,
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
          if (result.replayed) {
            return { status: "replayed", transitionId, workflowVersion, procedureId: null };
          }
        } else {
          // No-op decision: record an activity row for auditability.
          const task = await tx.task.findUniqueOrThrow({
            where: { id: command.taskId },
            select: { projectId: true },
          });
          await tx.activityLog.create({
            data: {
              projectId: task.projectId,
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
              projectId: task.projectId,
              aggregateVersion: command.expectedWorkflowVersion,
              workflowCycleId: cycleId,
              effects: decision.effects.map(toKernelEffect),
            });
          }
        }

        // --- Close cycle AFTER transition (P1-7 fix) ---------------------
        if (decision.cycleOperation === "close") {
          const closed = await closeTaskWorkflowCycle(tx, {
            taskId: command.taskId,
            outcome: decision.cycleOutcome ?? "abandoned",
            closedWorkflowVersion: workflowVersion,
            closedByTransitionId: transitionId,
            candidateSha: (command.evidence?.candidateSha as string | undefined) ?? null,
          });
          cycleId = closed?.id ?? cycleId;
        }

        // --- Review lease mutation (invariant 8: immutable decision) ------
        if (command.intent === "request_review_changes" || command.intent === "accept_review") {
          const lease = await tx.reviewRun.findFirst({
            where: { taskId: command.taskId, status: "awaiting_review" },
            orderBy: { createdAt: "desc" },
            take: 1,
          });
          if (lease) {
            const newStatus = command.intent === "request_review_changes" ? "changes_requested" : "accepted";
            await tx.reviewRun.updateMany({
              where: { id: lease.id, status: "awaiting_review" },
              data: {
                status: newStatus,
                reviewerId: decision.decisionActorId,
                reviewedAt: new Date(),
              },
            });
          }
        }

        // --- Procedure row (P1-5: upsert, one active per type/cycle) -----
        let procedureId: string | null = null;
        if (decision.procedureType) {
          const task = await tx.task.findUniqueOrThrow({
            where: { id: command.taskId },
            select: { projectId: true },
          });
          // P1-5: check for an existing non-terminal procedure of the same
          // type for this cycle. If one exists, reuse it instead of creating
          // a duplicate (invariant 6: one active procedure per type/cycle).
          const existing = await tx.taskProcedureRun.findFirst({
            where: {
              taskId: command.taskId,
              type: decision.procedureType,
              status: { in: ["queued", "running"] },
              ...(cycleId ? { workflowCycleId: cycleId } : {}),
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          if (existing) {
            procedureId = existing.id;
          } else {
            const created = await createProcedureRun(tx, {
              taskId: command.taskId,
              workflowCycleId: cycleId,
              triggerTransitionId: transitionId ?? command.idempotencyKey,
              type: decision.procedureType,
              input: command.payload ?? null,
            });
            procedureId = created.procedureRunId;
          }
          await tx.activityLog.create({
            data: {
              projectId: task.projectId,
              taskId: command.taskId,
              userId: decision.decisionActorId,
              kind: `task.workflow.procedure_scheduled`,
              payload: JSON.stringify({
                procedureType: decision.procedureType,
                procedureRunId: procedureId,
                cycleId,
                transitionId,
                workflowVersion,
                intent: command.intent,
                reused: existing !== null,
              }),
            },
          });
        }

        return { status: "accepted", transitionId: transitionId ?? command.idempotencyKey, workflowVersion, procedureId, cycleId };
      },
      { timeout: EXECUTE_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/version_conflict|status_conflict/i.test(message)) {
      return { status: "stale", reason: message };
    }
    return { status: "operational", reason: message };
  }
}