// ENV-123 — the watchdog pass.
//
// Loads a live snapshot, runs the pure detectors over it, executes at most one
// repair per (task, repair kind), and writes the operator-visible execution
// state for every task it looked at — including the healthy ones, because
// "running" and "never evaluated" must not look the same on the board.
//
// Bounded and fail-soft: a fixed row cap per pass, a bounded repair count, and
// every fault swallowed into the returned counters. It runs inside the PM
// worker drain, and a watchdog that can break the drain is worse than no
// watchdog at all.

import { db } from "@/lib/db";
import { canApproveActionPlanForActor } from "@/lib/tasks/workflow-actors";
import { recoverGitIdentityBlockers } from "@/lib/tasks/git-identity-recovery";
import {
  activeFormalBlockerStatesByTask,
  formalBlockerNeedsExternalInput,
} from "@/lib/tasks/formal-blocker";
import {
  detectWatchdogFindings,
  hasDurableRecoveryProgress,
  healthyExecutionState,
  WATCHDOG_BLOCKER_LOOP_WINDOW_MS,
  type WatchdogFinding,
  type WatchdogSnapshot,
  type WatchdogTaskRecord,
} from "@/lib/agents/watchdog/detectors";
import {
  clearWatchdogEscalation,
  consumeRecoveryBudget,
  escalateToReporter,
  queueRecoveryContinuation,
  settleExpiredRun,
  wakeAssigneeAfterGrant,
  requestMissingActionPlan,
  type RepairResult,
} from "@/lib/agents/watchdog/repairs";
import { writeTaskExecutionState } from "@/lib/agents/watchdog/state";

/** Rows pulled per table per pass. */
const WATCHDOG_TAKE = 500;
/** Repairs executed per pass, across all tasks. */
const WATCHDOG_MAX_REPAIRS = 20;
/** How far back runs and activity are considered. */
const WATCHDOG_WINDOW_MS = 3 * 24 * 60 * 60_000;

const BLOCKER_ACTIVITY_KINDS = [
  "task.blocker",
  "task.extra_work.blocker",
  "task.blocker.cleared",
  "task.blocker.permission.granted",
] as const;

export interface WatchdogPassOptions {
  projectId?: string;
  now?: Date;
  /** Detect and report, change nothing. */
  dryRun?: boolean;
  take?: number;
  maxRepairs?: number;
}

export interface WatchdogTaskOutcome {
  taskId: string;
  state: string;
  reasonCode: string;
  reasonDetail: string;
  detectorId: string | null;
  recoveryAction: string | null;
  repairOutcome: string | null;
}

export interface WatchdogPassReport {
  now: number;
  counts: { tasks: number; runs: number; continuations: number; findings: number };
  repaired: number;
  escalated: number;
  breakerOpen: number;
  stateWrites: number;
  errors: string[];
  outcomes: WatchdogTaskOutcome[];
}

function ms(value: Date | null | undefined): number | null {
  return value ? value.getTime() : null;
}

/**
 * Load everything the detectors need. Read-only: this function never writes.
 */
export async function loadWatchdogSnapshot(
  options: WatchdogPassOptions = {},
): Promise<WatchdogSnapshot & { taskProjectId: Map<string, string | null> }> {
  const now = options.now ?? new Date();
  const take = options.take ?? WATCHDOG_TAKE;
  const since = new Date(now.getTime() - WATCHDOG_WINDOW_MS);

  const taskRows = await db.task.findMany({
    where: {
      deletedAt: null,
      status: { in: ["Backlog", "To Do", "In Progress", "Review"] },
      ...(options.projectId ? { projectId: options.projectId } : {}),
    },
    take,
    select: {
      id: true,
      projectId: true,
      status: true,
      statusChangedAt: true,
      approvedOn: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      project: { select: { onlyReportersCanApproveActionPlans: true } },
      epic: { select: { status: true, actingManagerId: true, approvedOn: true } },
      assignee: { select: { agent: { select: { slug: true } } } },
      actionPlan: { select: { id: true, version: true, status: true, reviewedAt: true, reviewedById: true, delegatedApproverId: true, delegatedById: true } },
      checklist: {
        where: { kind: "implementation", completedAt: null },
        select: { id: true },
      },
      executionState: { select: { breakerOpenUntil: true } },
    },
  });

  const taskIds = taskRows.map((task) => task.id);
  if (taskIds.length === 0) {
    return {
      now: now.getTime(),
      tasks: [],
      runs: [],
      continuations: [],
      taskProjectId: new Map(),
    };
  }

  const [runRows, continuationRows, activityRows] = await Promise.all([
    db.pmChannelRun.findMany({
      where: { taskId: { in: taskIds }, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      take,
      select: {
        id: true,
        taskId: true,
        agentSlug: true,
        status: true,
        sessionKey: true,
        createdAt: true,
        admittedAt: true,
        acceptedAt: true, // ENV-159: legacy compatibility read
        streamingAt: true,
        lastEventAt: true,
        lastAction: true,
        lastActionAt: true,
        settledByAction: true,
        disposition: true,
        provider: true,
        model: true,
      },
    }),
    db.pmChannelContinuation.findMany({
      where: { taskId: { in: taskIds } },
      take,
      select: {
        id: true,
        taskId: true,
        runId: true,
        agentSlug: true,
        status: true,
        availableAt: true,
      },
    }),
    db.activityLog.findMany({
      where: { taskId: { in: taskIds }, kind: { in: [...BLOCKER_ACTIVITY_KINDS] } },
      orderBy: { createdAt: "desc" },
      take,
      select: { taskId: true, kind: true, payload: true, createdAt: true },
    }),
  ]);

  const blockerStates = activeFormalBlockerStatesByTask(activityRows);

  // A completed flag→clear cycle is one `task.blocker.cleared` row. Counting
  // clears rather than raises is what makes this a LOOP detector: a blocker
  // raised once and still open is not a loop, it is a blocker.
  const loopSince = now.getTime() - WATCHDOG_BLOCKER_LOOP_WINDOW_MS;
  const blockerCycles = new Map<string, number>();
  for (const row of activityRows) {
    if (row.kind !== "task.blocker.cleared" || !row.taskId) continue;
    if (row.createdAt.getTime() < loopSince) continue;
    blockerCycles.set(row.taskId, (blockerCycles.get(row.taskId) ?? 0) + 1);
  }

  // The last durable action for a task is the newest one recorded against any
  // of its runs. ENV-118 made `lastAction`/`lastActionAt` real columns, so this
  // is read rather than scraped out of ActivityLog prose.
  const lastAction = new Map<string, { action: string; at: number }>();
  for (const run of runRows) {
    if (!run.taskId || !run.lastAction || !run.lastActionAt) continue;
    const at = run.lastActionAt.getTime();
    const current = lastAction.get(run.taskId);
    if (!current || at > current.at) lastAction.set(run.taskId, { action: run.lastAction, at });
  }

  const taskProjectId = new Map<string, string | null>();
  const tasks: WatchdogTaskRecord[] = taskRows.map((task) => {
    taskProjectId.set(task.id, task.projectId);
    const blocker = blockerStates.get(task.id) ?? null;
    const durable = lastAction.get(task.id) ?? null;
    return {
      id: task.id,
      projectId: task.projectId,
      status: task.status,
      assigneeSlug: task.assignee?.agent?.slug ?? null,
      statusChangedAt: ms(task.statusChangedAt),
      approvedOn: ms(task.approvedOn),
      hasActionPlan: Boolean(task.actionPlan),
      planVersion: task.actionPlan?.version ?? 0,
      planReviewAccepted: Boolean(task.actionPlan?.reviewedAt),
      acceptedReviewerCanApprove: Boolean(task.actionPlan?.reviewedById && canApproveActionPlanForActor(task, task.actionPlan.reviewedById)),
      planStatus: task.actionPlan?.status ?? null,
      openChecklistCount: task.checklist.length,
      activeBlocker: blocker
        ? {
            needsExternalInput: formalBlockerNeedsExternalInput(blocker),
            permissionGranted: Boolean(blocker.permissionGrant),
            raisedAt: blocker.raisedAt ? new Date(blocker.raisedAt).getTime() : null,
          }
        : null,
      blockerCycles: blockerCycles.get(task.id) ?? 0,
      lastDurableAction: durable?.action ?? null,
      lastDurableActionAt: durable?.at ?? null,
      breakerOpenUntil: ms(task.executionState?.breakerOpenUntil ?? null),
    };
  });

  return {
    now: now.getTime(),
    tasks,
    runs: runRows.map((run) => ({
      id: run.id,
      taskId: run.taskId,
      agentSlug: run.agentSlug,
      status: run.status,
      sessionKey: run.sessionKey,
      createdAt: run.createdAt.getTime(),
      admittedAt: ms(run.admittedAt ?? run.acceptedAt),
    acceptedAt: ms(run.acceptedAt),
      streamingAt: ms(run.streamingAt),
      lastEventAt: ms(run.lastEventAt),
      lastAction: run.lastAction,
      lastActionAt: ms(run.lastActionAt),
      settledByAction: run.settledByAction,
      disposition: run.disposition,
      provider: run.provider,
      model: run.model,
    })),
    continuations: continuationRows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      runId: row.runId,
      agentSlug: row.agentSlug,
      status: row.status,
      availableAt: row.availableAt.getTime(),
    })),
    taskProjectId,
  };
}

async function applyRepair(args: {
  finding: WatchdogFinding;
  projectId: string | null;
  now: Date;
}): Promise<RepairResult> {
  switch (args.finding.repair) {
    case "settle_run":
      return args.finding.runId
        ? settleExpiredRun({ runId: args.finding.runId, now: args.now })
        : { outcome: "noop", recoveryAction: null };
    case "queue_continuation":
      return args.finding.agentSlug
        ? queueRecoveryContinuation({
            taskId: args.finding.taskId,
            agentSlug: args.finding.agentSlug,
            now: args.now,
          })
        : { outcome: "noop", recoveryAction: null };
    case "wake_assignee":
      return wakeAssigneeAfterGrant({ taskId: args.finding.taskId, now: args.now });
    case "request_plan":
      return requestMissingActionPlan({ taskId: args.finding.taskId, now: args.now });
    case "escalate":
      return escalateToReporter({
        finding: args.finding,
        projectId: args.projectId,
        now: args.now,
      });
    default:
      return { outcome: "noop", recoveryAction: null };
  }
}

/**
 * One bounded watchdog pass. Safe to call on every worker drain.
 */
export async function runWorkflowWatchdog(
  options: WatchdogPassOptions = {},
): Promise<WatchdogPassReport> {
  const now = options.now ?? new Date();
  const maxRepairs = options.maxRepairs ?? WATCHDOG_MAX_REPAIRS;
  const snapshot = await loadWatchdogSnapshot({ ...options, now });
  const findings = detectWatchdogFindings(snapshot);

  const report: WatchdogPassReport = {
    now: now.getTime(),
    counts: {
      tasks: snapshot.tasks.length,
      runs: snapshot.runs.length,
      continuations: snapshot.continuations.length,
      findings: findings.length,
    },
    repaired: 0,
    escalated: 0,
    breakerOpen: 0,
    stateWrites: 0,
    errors: [],
    outcomes: [],
  };

  if (!options.dryRun && maxRepairs > 0) {
    try {
      report.repaired += await recoverGitIdentityBlockers({ projectId: options.projectId, take: options.take, maxRepairs });
    } catch (error) {
      report.errors.push(`git_identity_recovery: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Highest-priority finding per task decides the visible state; every
  // finding's repair still runs, deduped so one pass can never queue two
  // continuations for one task.
  const leadFinding = new Map<string, WatchdogFinding>();
  for (const finding of findings) {
    if (!leadFinding.has(finding.taskId)) leadFinding.set(finding.taskId, finding);
  }

  const performed = new Map<string, RepairResult>();
  const repairKeys = new Set<string>();
  let repairs = report.repaired;

  for (const finding of findings) {
    if (repairs >= maxRepairs) break;
    const key = `${finding.taskId}|${finding.repair}|${finding.runId ?? ""}`;
    if (repairKeys.has(key)) continue;
    repairKeys.add(key);
    if (options.dryRun) continue;

    const projectId = snapshot.taskProjectId.get(finding.taskId) ?? null;
    try {
      // Only the repairs that can LOOP consume the budget. Escalation is what
      // happens instead of a recovery, and settling an expired lease is a
      // strictly terminal, once-per-run write that can never repeat — charging
      // either of them would let noise trip the breaker that protects the
      // recoveries which actually matter.
      if (
        finding.repair === "queue_continuation" ||
        finding.repair === "wake_assignee" ||
        finding.repair === "request_plan"
      ) {
        const decision = await consumeRecoveryBudget({ taskId: finding.taskId, now });
        if (!decision.allowed) {
          report.breakerOpen += 1;
          const escalation = await escalateToReporter({ finding, projectId, now });
          if (escalation.outcome === "escalated") report.escalated += 1;
          if (!performed.has(finding.taskId)) {
            performed.set(finding.taskId, {
              outcome: "breaker_open",
              recoveryAction: "escalated to reporter",
              detail: `recovery budget exhausted (${decision.count} in the window)`,
            });
          }
          continue;
        }
      }

      const result = await applyRepair({ finding, projectId, now });
      repairs += 1;
      if (result.outcome === "repaired") report.repaired += 1;
      if (result.outcome === "escalated") report.escalated += 1;
      if (result.detail && result.outcome === "failed") report.errors.push(result.detail);
      if (!performed.has(finding.taskId)) performed.set(finding.taskId, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`${finding.detectorId}/${finding.taskId}: ${message}`);
    }
  }

  // Write the state row for EVERY task in the snapshot, healthy or not.
  for (const task of snapshot.tasks) {
    const finding = leadFinding.get(task.id) ?? null;
    const repair = performed.get(task.id) ?? null;
    const resolved = finding
      ? {
          state: finding.state,
          reasonCode: finding.reasonCode,
          reasonDetail: finding.reasonDetail,
        }
      : healthyExecutionState(task, snapshot);

    const outcome: WatchdogTaskOutcome = {
      taskId: task.id,
      state: resolved.state,
      reasonCode: resolved.reasonCode,
      reasonDetail: resolved.reasonDetail,
      detectorId: finding?.detectorId ?? null,
      recoveryAction: repair?.recoveryAction ?? null,
      repairOutcome: repair?.outcome ?? null,
    };
    report.outcomes.push(outcome);
    if (options.dryRun) continue;

    try {
      const written = await writeTaskExecutionState({
        taskId: task.id,
        projectId: task.projectId,
        state: resolved.state,
        reasonCode: resolved.reasonCode,
        reasonDetail: resolved.reasonDetail,
        lastDurableAction: task.lastDurableAction,
        lastDurableActionAt: task.lastDurableActionAt
          ? new Date(task.lastDurableActionAt)
          : null,
        recoveryAction: repair?.recoveryAction ?? null,
        // Only a repair that actually DID something restamps the clock. A
        // re-observed no-op keeps the original instant (undefined = preserve),
        // and a task with no recovery at all clears it.
        recoveryAt: repair?.recoveryAction
          ? repair.outcome === "repaired" || repair.outcome === "escalated"
            ? now
            : undefined
          : null,
        detectorId: finding?.detectorId ?? null,
      });
      if (written) report.stateWrites += 1;
      if (!finding && hasDurableRecoveryProgress(task)) {
        await clearWatchdogEscalation(task.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push(`state/${task.id}: ${message}`);
    }
  }

  return report;
}
