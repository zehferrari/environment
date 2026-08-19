// ORCH-02 / PHASEE-04 — transaction boundary and intent dispatch.
//
// execute.ts owns only the outer transaction/fence. Every decision-owned
// mutation is reached through exactly one executor in the closed intents
// registry and receives only the transaction client plus refreshed state.

import { db } from "@/lib/db";
import {
  getIntentExecutor,
} from "@/lib/tasks/orchestrator/intents";
import {
  executeDecisionWrites,
  IntentReceiptResolution,
} from "@/lib/tasks/orchestrator/intents/shared";
import {
  fenceState,
  mapFenceResultToOrchestratorResult,
  refreshTaskAggregateForTx,
} from "@/lib/tasks/orchestrator/state";
import type {
  OrchestrationDecision,
  OrchestratorResult,
  TaskWorkflowCommand,
  TaskWorkflowIntent,
} from "@/lib/tasks/orchestrator/types";
import type { TaskStateSnapshot } from "@/lib/tasks/orchestrator/types";

const EXECUTE_TRANSACTION_TIMEOUT_MS = 15_000;

export async function executeWorkflowCommand(
  command: TaskWorkflowCommand,
  decision: OrchestrationDecision,
  preTransactionState: TaskStateSnapshot,
): Promise<OrchestratorResult> {
  try {
    return await db.$transaction(async (tx) => {
      const fence = await fenceState(tx, command.taskId, command, preTransactionState);
      if (!fence.ok) return mapFenceResultToOrchestratorResult(fence);

      const state = await refreshTaskAggregateForTx(tx, command.taskId);
      if (!state) return { status: "invalid", reason: "Task not found inside transaction." };

      // TypeScript cannot preserve discriminated-union correlation through a
      // runtime map lookup, so capture the concrete key once and invoke its
      // correspondingly typed executor. The registry itself is exhaustive.
      const intent = command.intent as TaskWorkflowIntent;
      const executor = getIntentExecutor(intent);
      return executor({
        tx,
        state,
        command,
        decision,
        helpers: {
          executeDecisionWrites: () => executeDecisionWrites({ tx, state, command, decision }),
        },
      });
    }, { timeout: EXECUTE_TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof IntentReceiptResolution) return error.result;
    const message = error instanceof Error ? error.message : String(error);
    if (/version_conflict|status_conflict/i.test(message)) {
      return { status: "stale", reason: message };
    }
    return { status: "operational", reason: message };
  }
}
