// ENV-118 — the transactional workflow-action primitive.
//
// The crash-safety boundary this Epic asks for is not "the outbox row commits
// with the run row". It is "the DOMAIN MUTATION commits with the outbox row".
// Those are different windows, and only the second one matters:
//
//   start → moveTaskStatus() commits → *crash* → recorder never runs
//
// leaves an In Progress task with no armed continuation and no live run. The
// task looks started, nobody is working it, and nothing will ever schedule the
// next turn. Arming the outbox inside the recorder's own transaction does not
// help, because that transaction begins after the task row is already durable.
//
// So every continuation-required route runs its mutation THROUGH this helper.
// The mutation and `applyPmChannelRunWorkflowAction` share one interactive
// transaction: either the task moved and the continuation is armed, or neither
// happened.
//
// Non-transactional side effects (revalidatePath, publishBoardTouch, workflow
// notifications, filesystem job spools) deliberately stay OUTSIDE the callback.
// They are not rollback-able, and re-running them is harmless; committing a
// task mutation without its continuation is not.

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import {
  applyPmChannelRunWorkflowAction,
  PmChannelExecutionContextError,
  type PmChannelWorkflowActionArgs,
} from "@/lib/agents/pm-channel/runs";
import type { WorkflowActionResult } from "@/lib/agents/workflow/action-effect";
import type {
  TaskWorkflowCommand,
  TaskWorkflowIntent,
  WorkflowPublicAction,
} from "@/lib/tasks/orchestrator/types";

/**
 * SQLite interactive transactions default to a 5s window. A workflow action is
 * a handful of small writes, but the route's transaction now also carries the
 * domain mutation, so give it headroom rather than failing a legitimate action
 * under load.
 */
const WORKFLOW_ACTION_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * Test-only failure injection. Invoked INSIDE the transaction, after the domain
 * mutation and before the run/outbox bookkeeping — i.e. exactly the point the
 * review identified as the loss window. Throwing here must roll the mutation
 * back; if it does not, the two halves are still split.
 */
type CrashHook = (action: string) => void | Promise<void>;
let crashHook: CrashHook | null = null;

export function __setWorkflowActionCrashHook(hook: CrashHook | null) {
  crashHook = hook;
}

export type WorkflowCommandCrashBoundary =
  | "before_command_transaction"
  | "after_domain_writes_before_execution_bookkeeping"
  | "after_execution_bookkeeping_before_receipt_projection"
  | "after_commit_before_response";

type WorkflowCommandCrashHook = (
  boundary: WorkflowCommandCrashBoundary,
  action: string,
) => void | Promise<void>;
let workflowCommandCrashHook: WorkflowCommandCrashHook | null = null;

export function __setWorkflowCommandCrashHook(hook: WorkflowCommandCrashHook | null) {
  workflowCommandCrashHook = hook;
}

export async function invokeWorkflowCommandCrashHook(
  boundary: WorkflowCommandCrashBoundary,
  action: string,
) {
  if (workflowCommandCrashHook) await workflowCommandCrashHook(boundary, action);
}

const INTENT_PUBLIC_ACTIONS: Readonly<
  Partial<Record<TaskWorkflowIntent, readonly WorkflowPublicAction[]>>
> = {
  submit_plan: ["submit_plan"],
  approve_plan: ["approve_plan"],
  start_implementation: ["start"],
  checkpoint: ["checkpoint"],
  submit_for_review: ["ready_for_review", "submit_review"],
  request_review_changes: ["review_feedback"],
  accept_review: ["review_done"],
  raise_blocker: ["flag_blocker"],
  clear_blocker: ["clear_blocker"],
  triage_task: ["triage_to_todo"],
  assign_task: ["assign_task", "assign_after_plan_approval"],
  raise_scope_blocker: ["flag_extra_work_blocker"],
  override_status: ["override_status"],
  publish_checkpoint: ["publish_checkpoint"],
  add_subtask: ["add_subtask"],
  complete_subtask: ["complete_subtask"],
  remove_subtask: ["remove_subtask"],
  request_subtask: ["request_subtask"],
  request_task: ["request_task"],
};

/** Pure portion of the authenticated PM execution-context fence. */
export function assertWorkflowCommandExecutionContext(command: TaskWorkflowCommand) {
  const context = command.executionContext;
  if (!context) return;
  const allowedActions = INTENT_PUBLIC_ACTIONS[command.intent];
  if (
    command.source !== "agent" ||
    command.actor.kind !== "agent" ||
    command.actor.username !== context.agentSlug ||
    command.messageId !== context.sourceMessageId ||
    !allowedActions?.includes(context.publicAction)
  ) {
    throw new PmChannelExecutionContextError(
      "mismatch",
      "pm_execution_context_mismatch: command source, actor, message, or public action does not match",
    );
  }
}

export interface AtomicWorkflowActionOutcome<T> {
  value: T;
  result: WorkflowActionResult;
}

/**
 * Run a workflow action's domain mutation and its run/continuation bookkeeping
 * in ONE database transaction.
 *
 * `mutate` receives the transaction client and must perform every durable
 * write the action implies through it — a write that reaches `db` directly is
 * outside the transaction and reopens the loss window.
 *
 * Throws if either half fails. The caller gets no partial state: the task did
 * not move and no continuation was armed, so the agent can safely retry with
 * the same (reusable) workflow token.
 */
export async function runWorkflowActionAtomically<T>(
  args: PmChannelWorkflowActionArgs,
  mutate: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<AtomicWorkflowActionOutcome<T>> {
  return db.$transaction(
    async (tx) => {
      const value = await mutate(tx);
      if (crashHook) await crashHook(args.action);
      const result = await applyPmChannelRunWorkflowAction(tx, args);
      return { value, result };
    },
    { timeout: WORKFLOW_ACTION_TRANSACTION_TIMEOUT_MS },
  );
}
