// Exact repository-validation callback boundary retained for the V2 worker.

import { db } from "@/lib/db";
import { enqueueWorkflowEffects } from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import { applyProcedureCallback } from "@/lib/tasks/orchestrator/procedure-runner";
import { updateTaskRepositoryState, type RepositoryValidationOutcome } from "@/lib/tasks/repository-state";

export type RepositoryProcedureCallback = {
  procedureRunId: string;
  procedureStepId: string;
  workflowCycleId: string | null;
  jobId: string;
  baseSha: string | null;
  schemaVersion?: number;
  commandReceiptId?: string | null;
  repositoryRunId?: string | null;
  repositoryRunVersion?: number | null;
  candidateSha?: string | null;
};

type Actor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
};

async function applyExactValidationCallback(args: {
  taskId: string;
  candidateSha: string | null;
  validationOutcome: string;
  error?: string;
  callback?: RepositoryProcedureCallback;
}) {
  if (args.callback?.schemaVersion !== 2) {
    throw new Error("Exact schema-v2 validation callback identity is required.");
  }
  return applyProcedureCallback({
    procedureRunId: args.callback.procedureRunId,
    stepId: args.callback.procedureStepId,
    taskId: args.taskId,
    workflowCycleId: args.callback.workflowCycleId,
    jobId: args.callback.jobId,
    candidateSha: args.callback.candidateSha ?? args.candidateSha,
    baseSha: args.callback.baseSha,
    schemaVersion: args.callback.schemaVersion,
    commandReceiptId: args.callback.commandReceiptId,
    repositoryRunId: args.callback.repositoryRunId,
    repositoryRunVersion: args.callback.repositoryRunVersion,
    data: { validationOutcome: args.validationOutcome, error: args.error },
  });
}

export async function completeTaskReviewHandoffAfterValidation(args: {
  taskId: string;
  actor: Actor;
  candidateSha: string | null;
  validationOutcome: Extract<RepositoryValidationOutcome, "valid" | "valid_with_warning">;
  validationSummary?: string | null;
  repoTouched?: boolean;
  procedureCallback?: RepositoryProcedureCallback;
}) {
  const result = await applyExactValidationCallback({
    taskId: args.taskId,
    candidateSha: args.candidateSha,
    validationOutcome: args.validationOutcome,
    callback: args.procedureCallback,
  });
  if (!result.applied) throw new Error(result.reason);
  return { status: "In Progress" as const, refillAssignments: [] };
}

export async function failTaskReviewValidation(args: {
  taskId: string;
  actor: Actor;
  error: string;
  candidateSha?: string | null;
  procedureCallback?: RepositoryProcedureCallback;
  applyProcedureCallback?: boolean;
}) {
  if (args.applyProcedureCallback === false) {
    throw new Error("Legacy validation mutation fallback is retired.");
  }
  const result = await applyExactValidationCallback({
    ...args,
    candidateSha: args.candidateSha ?? null,
    validationOutcome: "invalid",
    callback: args.procedureCallback,
  });
  if (!result.applied) throw new Error(result.reason);
  return { status: "In Progress" as const };
}

export async function recordTaskReviewOperationalError(args: {
  taskId: string;
  actor?: Actor | null;
  error: string;
  preserveValidationOutcome?: boolean;
  // An in-flight finalization retry still owns the current repository version.
  // Report the error without invalidating its immutable job identity.
  retryPending?: boolean;
}) {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: { id: true, projectId: true, workflowVersion: true, repositoryRun: { select: { phase: true } } },
  });
  if (!task) return;
  await db.$transaction(async (tx) => {
    await tx.task.update({ where: { id: task.id }, data: { alertReporter: true } });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: args.actor?.id ?? null,
        kind: "pm.repo.verify.operational_error",
        payload: JSON.stringify({ error: args.error, ...(args.retryPending ? { retryPending: true } : {}) }),
      },
    });
    if (!args.retryPending) await updateTaskRepositoryState(task.id, {
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
