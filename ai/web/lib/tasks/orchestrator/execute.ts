// ORCH-02 / PHASEE-04 — transaction boundary and intent dispatch.
//
// execute.ts owns only the outer transaction/fence. Every decision-owned
// mutation is reached through exactly one executor in the closed intents
// registry and receives only the transaction client plus refreshed state.

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import {
  applyAuthenticatedPmChannelWorkflowAction,
  PmChannelExecutionContextError,
} from "@/lib/agents/pm-channel/runs";
import {
  assertWorkflowCommandExecutionContext,
  invokeWorkflowCommandCrashHook,
} from "@/lib/agents/workflow/transactional-action";
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
    if (command.executionContext) {
      await invokeWorkflowCommandCrashHook(
        "before_command_transaction",
        command.executionContext.publicAction,
      );
    }
    const committed = await db.$transaction(
      (tx) => executeWorkflowCommandInTransaction(tx, command, decision, preTransactionState),
      { timeout: EXECUTE_TRANSACTION_TIMEOUT_MS },
    );
    if (command.executionContext) {
      await invokeWorkflowCommandCrashHook(
        "after_commit_before_response",
        command.executionContext.publicAction,
      );
    }
    return committed;
  } catch (error) {
    if (error instanceof IntentReceiptResolution) return error.result;
    if (error instanceof PmChannelExecutionContextError) {
      if (error.reason === "fenced" || error.reason === "already_consumed") {
        return { status: "stale", reason: error.message, domainCode: "cycle_mismatch" };
      }
      return {
        status: "invalid",
        reason: error.message,
        domainCode: "callback_correlation_mismatch",
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/version_conflict|status_conflict/i.test(message)) {
      return { status: "stale", reason: message, domainCode: "stale_version" };
    }
    return { status: "operational", reason: message, domainCode: "operational_error" };
  }
}

/**
 * Transaction-client form used by atomic batch transports such as approved
 * work-item proposals. The caller owns commit/rollback; every command still
 * performs the same transaction-time fence, intent executor, receipt, and
 * outbox writes as the ordinary public entry point.
 */
export async function executeWorkflowCommandInTransaction(
  tx: Prisma.TransactionClient,
  command: TaskWorkflowCommand,
  decision: OrchestrationDecision,
  preTransactionState: TaskStateSnapshot,
): Promise<OrchestratorResult> {
  assertWorkflowCommandExecutionContext(command);
  const fence = await fenceState(tx, command.taskId, command, preTransactionState);
  if (!fence.ok) return mapFenceResultToOrchestratorResult(fence);

  const state = await refreshTaskAggregateForTx(tx, command.taskId);
  if (!state) return { status: "invalid", reason: "Task not found inside transaction.", domainCode: "invalid_payload" };

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
      executeDecisionWrites: () => executeDecisionWrites({
        tx,
        state,
        command,
        decision,
        projectResult: command.executionContext
          ? async (result) => {
              await invokeWorkflowCommandCrashHook(
                "after_domain_writes_before_execution_bookkeeping",
                command.executionContext!.publicAction,
              );
              const workflowAction = await applyAuthenticatedPmChannelWorkflowAction(tx, {
                taskId: command.taskId,
                executionContext: command.executionContext!,
                taskState: decision.toStatus,
                checkpoint: command.intent === "checkpoint" ? command.payload : null,
                countsAgainstEpisodeBudget: command.intent !== "checkpoint",
              });
              await invokeWorkflowCommandCrashHook(
                "after_execution_bookkeeping_before_receipt_projection",
                command.executionContext!.publicAction,
              );
              return { ...result, ...workflowAction };
            }
          : undefined,
      }),
    },
  });
}
