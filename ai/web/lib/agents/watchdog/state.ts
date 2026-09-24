// ENV-123 — the execution-state store.
//
// "Operators should no longer need to infer execution state from comments."
// That sentence is the whole contract: there is exactly one durable row per
// task saying what PM believes is happening, why, what the last durable action
// was, and what the watchdog did about it. Everything else in this directory
// exists to keep that row honest.
//
// The write is an IDEMPOTENT UPSERT with a no-op short circuit. That matters
// more than it looks: the watchdog runs on every worker drain, and a row whose
// `updatedAt` churns every few seconds is indistinguishable from a row that is
// genuinely changing. If nothing observable moved, we write nothing.

import type { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { revalidateTaskShellIfAvailable } from "@/lib/tasks/cache";

export const EXECUTION_STATES = [
  "running",
  "idle",
  "stalled",
  "blocked",
  "waiting_review",
  "waiting_capacity",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

export function isExecutionState(value: unknown): value is ExecutionState {
  return (
    typeof value === "string" &&
    (EXECUTION_STATES as readonly string[]).includes(value)
  );
}

/** What the watchdog did in response to a detection. */
export const RECOVERY_ACTIONS = {
  runSettled: "stale run settled",
  continuationQueued: "new run queued",
  assigneeWoken: "assignee woken",
  escalated: "escalated to reporter",
  none: null,
} as const;

type TxClient = Prisma.TransactionClient | typeof db;

export interface TaskExecutionStateWrite {
  taskId: string;
  projectId?: string | null;
  state: ExecutionState;
  reasonCode?: string | null;
  reasonDetail?: string | null;
  lastDurableAction?: string | null;
  lastDurableActionAt?: Date | null;
  recoveryAction?: string | null;
  /**
   * `undefined` means PRESERVE the stored timestamp. That distinction matters:
   * a pass that re-observes an unchanged recovery must not restamp it, or the
   * row churns on every worker drain and "Recovery: new run queued" looks like
   * it just happened when it happened an hour ago.
   */
  recoveryAt?: Date | null;
  detectorId?: string | null;
}

function sameInstant(a: Date | null | undefined, b: Date | null | undefined) {
  const left = a ? a.getTime() : null;
  const right = b ? b.getTime() : null;
  return left === right;
}

/**
 * Upsert the task's execution state. Returns true when a write actually
 * happened, so callers (and the tests) can assert the no-op property.
 *
 * Circuit-breaker columns are deliberately NOT writable here: they are owned by
 * `lib/agents/watchdog/repairs.ts`, which is the only module allowed to decide
 * that a task has consumed its recovery budget.
 */
export async function writeTaskExecutionState(
  write: TaskExecutionStateWrite,
  client: TxClient = db,
): Promise<boolean> {
  const existing = await client.taskExecutionState.findUnique({
    where: { taskId: write.taskId },
    select: {
      state: true,
      reasonCode: true,
      reasonDetail: true,
      lastDurableAction: true,
      lastDurableActionAt: true,
      recoveryAction: true,
      recoveryAt: true,
      detectorId: true,
      projectId: true,
    },
  });

  const next = {
    projectId: write.projectId ?? null,
    state: write.state,
    reasonCode: write.reasonCode ?? null,
    reasonDetail: write.reasonDetail ?? null,
    lastDurableAction: write.lastDurableAction ?? null,
    lastDurableActionAt: write.lastDurableActionAt ?? null,
    recoveryAction: write.recoveryAction ?? null,
    recoveryAt:
      write.recoveryAt === undefined ? (existing?.recoveryAt ?? null) : write.recoveryAt,
    detectorId: write.detectorId ?? null,
  };

  if (
    existing &&
    existing.state === next.state &&
    existing.reasonCode === next.reasonCode &&
    existing.reasonDetail === next.reasonDetail &&
    existing.lastDurableAction === next.lastDurableAction &&
    sameInstant(existing.lastDurableActionAt, next.lastDurableActionAt) &&
    existing.recoveryAction === next.recoveryAction &&
    sameInstant(existing.recoveryAt, next.recoveryAt) &&
    existing.detectorId === next.detectorId &&
    existing.projectId === next.projectId
  ) {
    return false;
  }

  await client.taskExecutionState.upsert({
    where: { taskId: write.taskId },
    create: { taskId: write.taskId, ...next },
    update: next,
  });
  // Notify only after an autocommit write is durable. Transactional callers
  // own publication after their commit. Identical observations returned above.
  if (client === db) {
    publishBoardTouch(next.projectId);
    revalidateTaskShellIfAvailable(write.taskId);
  }
  return true;
}

/**
 * The rendered form the task page, the board badge and the agent context block
 * all share, so the four lines in the task description have exactly one
 * definition.
 */
export interface RenderedExecutionState {
  state: ExecutionState | string;
  reason: string | null;
  lastDurableAction: string | null;
  recovery: string | null;
}

type DateLike = Date | string | number;

function clockLabel(value: DateLike): string | null {
  // Next's unstable_cache serializes Prisma Date values before returning the
  // cached task shell. Direct Prisma reads still supply Date objects, while a
  // cached page render supplies ISO strings. Accept both or the first task
  // with a durable-action timestamp crashes its detail page.
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  const hours = String(at.getHours()).padStart(2, "0");
  const minutes = String(at.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** "started at 09:24" — the exact shape the task description asks for. */
export function formatLastDurableAction(
  action: string | null | undefined,
  at: DateLike | null | undefined,
): string | null {
  if (!action) return null;
  const verb = action.replaceAll("_", " ");
  const clock = at == null ? null : clockLabel(at);
  return clock ? `${verb} at ${clock}` : verb;
}

export function renderExecutionState(row: {
  state: string;
  reasonDetail: string | null;
  lastDurableAction: string | null;
  lastDurableActionAt: DateLike | null;
  recoveryAction: string | null;
}): RenderedExecutionState {
  return {
    state: row.state,
    reason: row.reasonDetail,
    lastDurableAction: formatLastDurableAction(
      row.lastDurableAction,
      row.lastDurableActionAt,
    ),
    recovery: row.recoveryAction,
  };
}

/** The four-line operator block, used by the agent context packet. */
export function executionStateLines(rendered: RenderedExecutionState): string[] {
  const lines = [`Execution: ${rendered.state}`];
  if (rendered.reason) lines.push(`Reason: ${rendered.reason}`);
  if (rendered.lastDurableAction) {
    lines.push(`Last durable action: ${rendered.lastDurableAction}`);
  }
  if (rendered.recovery) lines.push(`Recovery: ${rendered.recovery}`);
  return lines;
}
