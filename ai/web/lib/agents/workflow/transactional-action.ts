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
  type PmChannelWorkflowActionArgs,
} from "@/lib/agents/pm-channel/runs";
import type { WorkflowActionResult } from "@/lib/agents/workflow/action-effect";

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
