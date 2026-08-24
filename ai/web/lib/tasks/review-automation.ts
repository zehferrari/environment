// Exact repository-finalization callback boundary retained for the V2 worker.

import { applyProcedureCallback } from "@/lib/tasks/orchestrator/procedure-runner";

export type FinalizationProcedureCallback = {
  procedureRunId: string;
  procedureStepId: string;
  workflowCycleId: string | null;
  jobId: string;
  schemaVersion?: number;
  commandReceiptId?: string | null;
  repositoryRunId?: string | null;
  repositoryRunVersion?: number | null;
  candidateSha?: string | null;
  baseSha?: string | null;
};

export async function applyFinalizationCallbackToProcedure(
  taskId: string,
  candidateSha: string | null,
  ok: boolean,
  mergeSha?: string | null,
  error?: string,
  callback?: FinalizationProcedureCallback,
): Promise<void> {
  if (callback?.schemaVersion !== 2) {
    throw new Error("Exact schema-v2 finalization callback identity is required.");
  }
  const result = await applyProcedureCallback({
    procedureRunId: callback.procedureRunId,
    stepId: callback.procedureStepId,
    taskId,
    workflowCycleId: callback.workflowCycleId,
    jobId: callback.jobId,
    candidateSha: callback.candidateSha ?? candidateSha,
    baseSha: callback.baseSha,
    schemaVersion: callback.schemaVersion,
    commandReceiptId: callback.commandReceiptId,
    repositoryRunId: callback.repositoryRunId,
    repositoryRunVersion: callback.repositoryRunVersion,
    data: { finalizationOk: ok, mergeSha: mergeSha ?? undefined, error },
  });
  if (!result.applied) throw new Error(result.reason);
}
