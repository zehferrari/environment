import type { Prisma } from "@prisma/client";
import type { TaskAggregate } from "@/lib/tasks/orchestrator/state";
import type {
  OrchestrationDecision,
  OrchestratorResult,
  TaskWorkflowCommand,
  TaskWorkflowIntent,
} from "@/lib/tasks/orchestrator/types";

export type CommandForIntent<I extends TaskWorkflowIntent> = Extract<
  TaskWorkflowCommand,
  { intent: I }
>;

export type TransactionIntentHelpers = {
  executeDecisionWrites(): Promise<OrchestratorResult>;
};

export type IntentExecutorContext<I extends TaskWorkflowIntent> = {
  tx: Prisma.TransactionClient;
  state: TaskAggregate;
  command: CommandForIntent<I>;
  decision: OrchestrationDecision;
  helpers: TransactionIntentHelpers;
};

export type IntentExecutor<I extends TaskWorkflowIntent> = (
  context: IntentExecutorContext<I>,
) => Promise<OrchestratorResult>;

export type IntentExecutorRegistry = {
  [I in TaskWorkflowIntent]: IntentExecutor<I>;
};
