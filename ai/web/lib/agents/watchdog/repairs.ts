// ENV-123 — the watchdog repairs, and the circuit breaker that bounds them.
//
// One detector, one repair. Each repair is idempotent: a second pass over an
// already-repaired task must be a no-op, because the watchdog runs on every
// worker drain and "repair" that fires repeatedly is just a slower version of
// the runaway loop this task exists to detect.
//
// Nothing here dispatches a turn directly. Recovery goes through the ENV-118
// continuation outbox, so the same preconditions that protect ordinary
// continuations — task still In Progress, agent still the assignee, no
// competing run, no external blocker — protect watchdog recoveries too, and a
// crash between "decide to recover" and "enqueue the turn" leaves a durable row
// rather than a lost intention.
//
// The breaker is the part that keeps the watchdog honest. A task may consume a
// bounded number of automated recoveries per window; past that the watchdog
// stops repairing it, marks it stalled, and escalates to the reporter. A repair
// that does not stick is a diagnosis, not something to retry forever.

import { db } from "@/lib/db";
import { intEnv } from "@/lib/agents/context/caps";
import { armPmChannelContinuations } from "@/lib/agents/pm-channel/continuations";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import type { WatchdogFinding } from "@/lib/agents/watchdog/detectors";

/** The continuation action name a watchdog recovery schedules its turn under. */
export const WATCHDOG_CONTINUATION_ACTION = "watchdog_recovery";

export const WATCHDOG_RECOVERY_BUDGET_DEFAULT = 3;
export const WATCHDOG_RECOVERY_WINDOW_MS = 60 * 60_000;

export function watchdogRecoveryBudget() {
  return intEnv("PM_WATCHDOG_MAX_RECOVERIES", WATCHDOG_RECOVERY_BUDGET_DEFAULT, 1, 100);
}

export type RepairOutcome =
  | "repaired"
  | "noop"
  | "breaker_open"
  | "escalated"
  | "failed";

export interface RepairResult {
  outcome: RepairOutcome;
  /** What to render under "Recovery:". Null when nothing was done. */
  recoveryAction: string | null;
  detail?: string;
}

// ------------------------------------------------------------------
// Circuit breaker
// ------------------------------------------------------------------

export interface BreakerDecision {
  allowed: boolean;
  count: number;
  windowAt: Date;
  breakerOpenUntil: Date | null;
}

/**
 * Claim one unit of this task's recovery budget.
 *
 * The window is a simple rolling reset rather than a sliding log: a task that
 * needed three recoveries an hour ago and none since is healthy, and should not
 * inherit an open breaker. Called only when a repair is actually about to
 * happen, so a task the watchdog merely observed never burns budget.
 *
 * The count increment is atomic: the conditional `updateMany` is guarded by
 * the expected prior `recoveryCount` (or by the window-reset boundary when the
 * window is stale), so two racing passes that read the same pre-value cannot
 * both claim the same unit. The loser's `updateMany` matches zero rows, so it
 * re-reads and retries against the winner's state. On a DB engine that does
 * not serialise writes (unlike SQLite), the count is exactly the number of
 * passes that actually claimed a unit.
 */
export async function consumeRecoveryBudget(args: {
  taskId: string;
  now: Date;
  budget?: number;
}): Promise<BreakerDecision> {
  const budget = args.budget ?? watchdogRecoveryBudget();
  const windowBoundary = new Date(args.now.getTime() - WATCHDOG_RECOVERY_WINDOW_MS);

  for (let attempt = 0; ; attempt++) {
    const existing = await db.taskExecutionState.findUnique({
      where: { taskId: args.taskId },
      select: { recoveryCount: true, recoveryWindowAt: true, breakerOpenUntil: true },
    });

    const windowStale =
      !existing?.recoveryWindowAt ||
      existing.recoveryWindowAt.getTime() <= windowBoundary.getTime();

    if (
      !windowStale &&
      existing?.breakerOpenUntil &&
      existing.breakerOpenUntil.getTime() > args.now.getTime()
    ) {
      return {
        allowed: false,
        count: existing.recoveryCount,
        windowAt: existing.recoveryWindowAt ?? args.now,
        breakerOpenUntil: existing.breakerOpenUntil,
      };
    }

    const windowAt = windowStale ? args.now : (existing?.recoveryWindowAt ?? args.now);
    const priorCount = windowStale ? 0 : (existing?.recoveryCount ?? 0);
    const nextCount = priorCount + 1;
    const tripped = nextCount > budget;
    const breakerOpenUntil = tripped
      ? new Date(windowAt.getTime() + WATCHDOG_RECOVERY_WINDOW_MS)
      : null;

    if (!existing) {
      // No row yet: the create path's uniqueness on taskId makes two racing
      // creates collide; the loser falls through to the update branch below.
      try {
        await db.taskExecutionState.create({
          data: {
            taskId: args.taskId,
            state: "stalled",
            recoveryCount: nextCount,
            recoveryWindowAt: windowAt,
            breakerOpenUntil,
          },
        });
        return { allowed: !tripped, count: nextCount, windowAt, breakerOpenUntil };
      } catch {
        // A racing pass created the row first; re-read and retry the update.
      }
      continue;
    }

    // Conditional update: the `where` guard on the prior count (or the stale
    // window) makes the increment atomic. A racing pass that already moved
    // the count leaves this update matching zero rows.
    const guard = windowStale
      ? {
          taskId: args.taskId,
          OR: [
            { recoveryWindowAt: null },
            { recoveryWindowAt: { lte: windowBoundary } },
          ],
        }
      : {
          taskId: args.taskId,
          recoveryCount: priorCount,
          recoveryWindowAt: { gt: windowBoundary },
        };

    const updated = await db.taskExecutionState.updateMany({
      where: guard,
      data: {
        recoveryCount: nextCount,
        recoveryWindowAt: windowAt,
        breakerOpenUntil,
      },
    });

    if (updated.count > 0) {
      return { allowed: !tripped, count: nextCount, windowAt, breakerOpenUntil };
    }
    // A racing pass moved the count under us; retry against the new state.
    // The loop is bounded by the number of concurrent passes, which is small
    // (the watchdog dedupes per task × repair × run), so this is not a busy
    // loop in practice.
  }
}

// ------------------------------------------------------------------
// Repair 1 — settle a run whose lease expired
// ------------------------------------------------------------------

/**
 * A run claiming to be active with a dead lease is settled `timed_out`. Any
 * continuation the turn had armed is promoted to `queued` in the same write, so
 * the work the agent had already committed to still gets its turn — a dead
 * lease should lose the run, not the episode.
 *
 * Idempotent by construction: the update is conditional on the run still being
 * in an active status, so a second pass matches zero rows.
 */
export async function settleExpiredRun(args: {
  runId: string;
  now: Date;
}): Promise<RepairResult> {
  const armed = await db.pmChannelContinuation.count({
    where: { runId: args.runId, status: { in: ["armed", "queued", "dispatching"] } },
  });
  const settled = await db.pmChannelRun.updateMany({
    where: { id: args.runId, status: { in: ["queued", "accepted", "streaming"] } },
    data: {
      status: "timed_out",
      failedAt: args.now,
      finishedAt: args.now,
      finishedReason: "watchdog_lease_expired",
      lastEventAt: args.now,
      // WFI-005: every terminal write records an explicit disposition. A turn
      // that died with work still owed ends as `continue`, not `failed` —
      // the episode is unfinished, not abandoned.
      disposition: armed > 0 ? "continue" : "failed",
      error: "run lease expired; settled by the workflow watchdog",
    },
  });
  if (settled.count === 0) return { outcome: "noop", recoveryAction: null };

  await db.pmChannelContinuation.updateMany({
    where: { runId: args.runId, status: "armed" },
    data: { status: "queued", availableAt: args.now },
  });
  await db.pmChannelJob.updateMany({
    where: { runId: args.runId, status: { in: ["queued", "claimed", "accepted", "retryable"] } },
    data: {
      status: "failed",
      claimedBy: null,
      claimedAt: null,
      lastError: "run lease expired; settled by the workflow watchdog",
    },
  });
  return { outcome: "repaired", recoveryAction: "stale run settled" };
}

// ------------------------------------------------------------------
// Repair 2 — queue one recovery continuation
// ------------------------------------------------------------------

/**
 * Arm a queued continuation against the lane's newest run, which is what makes
 * the drain schedule a fresh execution turn.
 *
 * Idempotency has two layers. The outbox row is unique on
 * (runId, messageId, action), so re-arming renews rather than duplicates; and
 * an already-`dispatched` row for the same key means a turn was enqueued
 * already, which is a no-op rather than a second turn.
 */
export async function queueRecoveryContinuation(args: {
  taskId: string;
  agentSlug: string;
  now: Date;
}): Promise<RepairResult> {
  const run = await db.pmChannelRun.findFirst({
    where: { taskId: args.taskId, agentSlug: args.agentSlug },
    orderBy: { createdAt: "desc" },
    select: { id: true, projectId: true, taskId: true, epicId: true, messageId: true },
  });
  if (!run?.taskId) {
    return {
      outcome: "failed",
      recoveryAction: null,
      detail: "no run exists to attach a recovery continuation to",
    };
  }

  const existing = await db.pmChannelContinuation.findUnique({
    where: {
      runId_messageId_action: {
        runId: run.id,
        messageId: run.messageId,
        action: WATCHDOG_CONTINUATION_ACTION,
      },
    },
    select: { status: true },
  });
  if (existing && existing.status !== "superseded" && existing.status !== "failed") {
    // armed / queued / dispatching / dispatched all mean this recovery already
    // owns the next turn for this run.
    return { outcome: "noop", recoveryAction: "new run queued" };
  }

  await armPmChannelContinuations(db, {
    runs: [run],
    agentSlug: args.agentSlug,
    messageId: run.messageId,
    action: WATCHDOG_CONTINUATION_ACTION,
    now: args.now,
    // The turn this run belonged to is over — there is no settle left to
    // promote an `armed` row, so it must be drainable immediately.
    status: "queued",
  });
  return { outcome: "repaired", recoveryAction: "new run queued" };
}

// ------------------------------------------------------------------
// Repair 3 — wake the assignee of a blocker whose permission already landed
// ------------------------------------------------------------------

export async function wakeAssigneeAfterGrant(args: {
  taskId: string;
  now: Date;
}): Promise<RepairResult> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      assigneeId: true,
      deletedAt: true,
      assignee: { select: { agent: { select: { slug: true } } } },
    },
  });
  if (!task || task.deletedAt || task.status !== "In Progress" || !task.assigneeId) {
    return { outcome: "noop", recoveryAction: null };
  }
  const slug = task.assignee?.agent?.slug;
  if (!slug) return { outcome: "noop", recoveryAction: null };

  const notification = await sendTaskWorkflowNotification({
    taskId: task.id,
    targetUserId: task.assigneeId,
    actor: { id: task.assigneeId, kind: "agent", username: slug },
    reason: "blocker_response",
    body: [
      `The permission your blocker on "${task.title}" was waiting for has already been granted, and no external dependency is outstanding.`,
      "Resume implementation from where the blocker interrupted it. Use the granted authorization if the round is agent-actionable, and do not re-raise the same blocker.",
    ].join("\n"),
  });
  if (!notification) {
    return {
      outcome: "failed",
      recoveryAction: null,
      detail: "could not enqueue a wake turn for the assignee",
    };
  }
  return { outcome: "repaired", recoveryAction: "assignee woken" };
}

// ------------------------------------------------------------------
// Repair 4 — request a missing structured pre-start Action Plan
// ------------------------------------------------------------------

export async function requestMissingActionPlan(args: {
  taskId: string;
  now: Date;
}): Promise<RepairResult> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      approvedOn: true,
      assigneeId: true,
      deletedAt: true,
      actionPlan: { select: { id: true } },
      assignee: { select: { agent: { select: { slug: true } } } },
    },
  });
  if (
    !task ||
    task.deletedAt ||
    task.status !== "To Do" ||
    task.approvedOn ||
    task.actionPlan ||
    !task.assigneeId
  ) {
    return { outcome: "noop", recoveryAction: null };
  }
  const slug = task.assignee?.agent?.slug;
  if (!slug) return { outcome: "noop", recoveryAction: null };

  const notification = await sendTaskWorkflowNotification({
    taskId: task.id,
    targetUserId: task.assigneeId,
    actor: { id: task.assigneeId, kind: "agent", username: slug },
    reason: "todo_start_required",
    body: [
      `PM's workflow watchdog found that "${task.title}" is assigned to you in To Do but still has no durable structured Action Plan.`,
      "Call the task workflow endpoint now with action=submit_plan and the required actionPlan object (summary plus validated steps). A normal Action Plan chat reply is discussion only and does not satisfy this gate.",
      "After submit_plan succeeds, stop and let the resolved reviewer approve it. Do not add implementation sub-tasks or start repository work before approval.",
    ].join("\n"),
  });
  if (!notification) {
    return {
      outcome: "failed",
      recoveryAction: null,
      detail: "could not enqueue a structured Action Plan request for the assignee",
    };
  }
  return { outcome: "repaired", recoveryAction: "Action Plan submission requested" };
}

// ------------------------------------------------------------------
// Repair 5 — escalation (the only "repair" for the escalate-only detectors)
// ------------------------------------------------------------------

/**
 * Raise the task's reporter flag and record why, exactly once per episode of
 * trouble. `escalatedAt` is the idempotency key: it is cleared again by
 * `clearWatchdogEscalation` when the task recovers, so a later loop escalates
 * afresh instead of staying silent.
 */
export async function escalateToReporter(args: {
  finding: WatchdogFinding;
  projectId: string | null;
  now: Date;
}): Promise<RepairResult> {
  const state = await db.taskExecutionState.findUnique({
    where: { taskId: args.finding.taskId },
    select: { escalatedAt: true },
  });
  if (state?.escalatedAt) {
    return { outcome: "noop", recoveryAction: "escalated to reporter" };
  }

  await db.task.update({
    where: { id: args.finding.taskId },
    data: { alertReporter: true },
  });
  await db.taskExecutionState.upsert({
    where: { taskId: args.finding.taskId },
    create: {
      taskId: args.finding.taskId,
      projectId: args.projectId,
      state: args.finding.state,
      escalatedAt: args.now,
    },
    update: { escalatedAt: args.now },
  });
  await db.activityLog
    .create({
      data: {
        projectId: args.projectId,
        taskId: args.finding.taskId,
        kind: "task.watchdog.escalated",
        targetAgent: args.finding.agentSlug,
        payload: JSON.stringify({
          detectorId: args.finding.detectorId,
          reasonCode: args.finding.reasonCode,
          reasonDetail: args.finding.reasonDetail,
        }),
      },
    })
    .catch(() => {});
  return { outcome: "escalated", recoveryAction: "escalated to reporter" };
}

/** A task that is healthy again drops its escalation flag so the next one fires. */
export async function clearWatchdogEscalation(taskId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const cleared = await tx.taskExecutionState.updateMany({
      where: { taskId, escalatedAt: { not: null } },
      data: { escalatedAt: null },
    });
    if (cleared.count === 0) return;

    // escalateToReporter raises both the execution-state stamp and the board
    // flag. Clear them symmetrically; clearing only escalatedAt left a healthy
    // Review task displaying a permanent blocker/report alert.
    await tx.task.updateMany({
      where: { id: taskId, alertReporter: true },
      data: { alertReporter: false },
    });
  });
}
