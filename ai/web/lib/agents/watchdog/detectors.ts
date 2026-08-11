// ENV-123 — the watchdog detectors.
//
// Pure predicates over plain record shapes, exactly the discipline
// lib/workflow-invariants.ts uses: no Prisma import, no clock of their own, no
// writes. That is what makes the seven failure modes in the task description
// testable from a fixture with no database at all, and it keeps the
// "what is broken" decision separable from the "what do we do about it" one in
// lib/agents/watchdog/repairs.ts.
//
// The seven modes, in the description's order:
//
//   expired_lease                       — expired run leases
//   in_progress_no_active_run           — In Progress tasks with no active run
//   started_no_work                     — start happened, nothing followed
//   open_checklist_no_continuation      — open checklist, no scheduled turn
//   blocker_permission_already_granted  — blocker whose permission was granted
//   blocker_clear_loop                  — repeated blocker/clear loops
//   session_churn                       — excessive rotation / context failures
//
// The first five have a bounded, idempotent repair. The last two deliberately
// do NOT: a task that keeps re-raising a blocker, or that keeps burning
// sessions, is a task where more automated recovery is the problem rather than
// the fix. Those escalate to the reporter and stop.

import {
  isActiveRunStatus,
  isContinuationRequiredAction,
  runLeaseExpired,
  WORKFLOW_RUN_LEASE_TTL_MS,
} from "@/lib/workflow-invariants";
import type { ExecutionState } from "@/lib/agents/watchdog/state";

// ------------------------------------------------------------------
// Thresholds
// ------------------------------------------------------------------

/**
 * How long a task may sit with no active run and no scheduled continuation
 * before the watchdog calls it stalled. Generous on purpose: the continuation
 * outbox and the episode sweeper both get their chance first, and a watchdog
 * that fires inside their normal latency would repair healthy tasks.
 */
export const WATCHDOG_STALL_GRACE_MS = 10 * 60_000;

/** Completed flag→clear cycles within the window that count as a loop. */
export const WATCHDOG_BLOCKER_LOOP_THRESHOLD = 3;
export const WATCHDOG_BLOCKER_LOOP_WINDOW_MS = 6 * 60 * 60_000;

/** Distinct sessions, or hard run failures, per lane per window. */
export const WATCHDOG_SESSION_CHURN_THRESHOLD = 4;
export const WATCHDOG_RUN_FAILURE_THRESHOLD = 3;
export const WATCHDOG_CHURN_WINDOW_MS = 60 * 60_000;

// ------------------------------------------------------------------
// Snapshot shapes
// ------------------------------------------------------------------
//
// Timestamps are epoch milliseconds or null, so fixtures never juggle Dates.

export interface WatchdogRunRecord {
  id: string;
  taskId: string | null;
  agentSlug: string;
  status: string;
  sessionKey: string | null;
  createdAt: number;
  acceptedAt: number | null;
  streamingAt: number | null;
  lastEventAt: number | null;
  /** Most recent workflow action recorded against this run, settling or not. */
  lastAction: string | null;
  lastActionAt: number | null;
  settledByAction: string | null;
  disposition: string | null;
}

/** Statuses in which a continuation still owes the task a turn. */
export const OPEN_CONTINUATION_STATUSES = ["armed", "queued", "dispatching"] as const;

export interface WatchdogContinuationRecord {
  id: string;
  taskId: string | null;
  runId: string;
  agentSlug: string;
  status: string;
  availableAt: number;
}

export interface WatchdogBlockerState {
  /** The blocker is genuinely waiting on somebody outside the agent. */
  needsExternalInput: boolean;
  /** A scoped permission grant has already landed against it. */
  permissionGranted: boolean;
  raisedAt: number | null;
}

export interface WatchdogTaskRecord {
  id: string;
  projectId: string | null;
  status: string;
  assigneeSlug: string | null;
  /** Implementation checklist rows still open. */
  openChecklistCount: number;
  activeBlocker: WatchdogBlockerState | null;
  /** Completed flag→clear cycles inside WATCHDOG_BLOCKER_LOOP_WINDOW_MS. */
  blockerCycles: number;
  /** The last workflow action PM durably recorded for this task, and when. */
  lastDurableAction: string | null;
  lastDurableActionAt: number | null;
  /** Set when the breaker has already tripped; detectors still report, repairs stop. */
  breakerOpenUntil: number | null;
}

export interface WatchdogSnapshot {
  now: number;
  tasks: WatchdogTaskRecord[];
  runs: WatchdogRunRecord[];
  continuations: WatchdogContinuationRecord[];
  /** Lease TTL override, for tests. */
  leaseTtlMs?: number;
  /** Stall grace override, for tests. */
  stallGraceMs?: number;
}

// ------------------------------------------------------------------
// Findings
// ------------------------------------------------------------------

/** Exactly one repair per detector. `escalate` performs no automated repair. */
export type WatchdogRepairKind =
  | "settle_run"
  | "queue_continuation"
  | "wake_assignee"
  | "escalate";

export interface WatchdogFinding {
  detectorId: string;
  taskId: string;
  /** Set when the finding is about one specific run. */
  runId: string | null;
  agentSlug: string | null;
  state: ExecutionState;
  reasonCode: string;
  reasonDetail: string;
  repair: WatchdogRepairKind;
  /**
   * Higher wins when one task produces several findings. The state row shows
   * the highest-priority one; every finding's repair still runs.
   */
  priority: number;
}

export interface WatchdogDetector {
  id: string;
  /** One line, for the CLI and the docs. */
  statement: string;
  detect: (snapshot: WatchdogSnapshot) => WatchdogFinding[];
}

// ------------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------------

function leaseTtl(snapshot: WatchdogSnapshot): number {
  return snapshot.leaseTtlMs ?? WORKFLOW_RUN_LEASE_TTL_MS;
}

function stallGrace(snapshot: WatchdogSnapshot): number {
  return snapshot.stallGraceMs ?? WATCHDOG_STALL_GRACE_MS;
}

function leaseAnchor(run: WatchdogRunRecord): number {
  return run.lastEventAt ?? run.streamingAt ?? run.acceptedAt ?? run.createdAt;
}

/** Reuses the invariant module's lease derivation so the two cannot drift. */
function leaseIsExpired(run: WatchdogRunRecord, snapshot: WatchdogSnapshot): boolean {
  return runLeaseExpired(
    {
      id: run.id,
      agentSlug: run.agentSlug,
      taskId: run.taskId,
      epicId: null,
      messageId: "",
      status: run.status,
      createdAt: run.createdAt,
      acceptedAt: run.acceptedAt,
      streamingAt: run.streamingAt,
      completedAt: null,
      failedAt: null,
      lastEventAt: run.lastEventAt,
      settledByAction: run.settledByAction,
      finalResponseText: null,
      disposition: run.disposition,
    },
    snapshot.now,
    leaseTtl(snapshot),
  );
}

function runIsLive(run: WatchdogRunRecord, snapshot: WatchdogSnapshot): boolean {
  return isActiveRunStatus(run.status) && !leaseIsExpired(run, snapshot);
}

function openContinuationTaskIds(snapshot: WatchdogSnapshot): Set<string> {
  const open = new Set<string>(OPEN_CONTINUATION_STATUSES);
  const ids = new Set<string>();
  for (const row of snapshot.continuations) {
    if (!row.taskId) continue;
    if (!open.has(row.status)) continue;
    ids.add(row.taskId);
  }
  return ids;
}

function liveRunTaskIds(snapshot: WatchdogSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const run of snapshot.runs) {
    if (!run.taskId) continue;
    if (runIsLive(run, snapshot)) ids.add(run.taskId);
  }
  return ids;
}

/**
 * Is this task an execution episode the watchdog is allowed to repair?
 *
 * Only an In Progress, agent-assigned task is. Review is the reviewer's, and a
 * task waiting on a genuine external dependency is waiting on purpose — pushing
 * a turn at either of those manufactures the noise the Epic is removing.
 */
function isRepairableEpisode(task: WatchdogTaskRecord): boolean {
  if (task.status !== "In Progress") return false;
  if (!task.assigneeSlug) return false;
  if (task.activeBlocker?.needsExternalInput && !task.activeBlocker.permissionGranted) {
    return false;
  }
  return true;
}

function idleSince(task: WatchdogTaskRecord, snapshot: WatchdogSnapshot): number {
  const anchor = task.lastDurableActionAt ?? 0;
  return snapshot.now - anchor;
}

// ------------------------------------------------------------------
// The detectors
// ------------------------------------------------------------------

// 1 — expired run leases.
const EXPIRED_LEASE: WatchdogDetector = {
  id: "expired_lease",
  statement:
    "A run in an active status whose lease has expired is settled timed_out rather than left claiming to be running.",
  detect: (snapshot) => {
    const findings: WatchdogFinding[] = [];
    for (const run of snapshot.runs) {
      if (!run.taskId) continue;
      if (!isActiveRunStatus(run.status)) continue;
      if (!leaseIsExpired(run, snapshot)) continue;
      const ageSec = Math.round((snapshot.now - leaseAnchor(run)) / 1000);
      findings.push({
        detectorId: "expired_lease",
        taskId: run.taskId,
        runId: run.id,
        agentSlug: run.agentSlug,
        state: "stalled",
        reasonCode: "expired_run_lease",
        reasonDetail: `run is ${run.status} but has not renewed its lease for ${ageSec}s`,
        repair: "settle_run",
        priority: 80,
      });
    }
    return findings;
  },
};

// 2 — In Progress tasks with no active run.
const IN_PROGRESS_NO_ACTIVE_RUN: WatchdogDetector = {
  id: "in_progress_no_active_run",
  statement:
    "An In Progress, agent-assigned task with no live run and no scheduled continuation gets one execution turn queued.",
  detect: (snapshot) => {
    const live = liveRunTaskIds(snapshot);
    const scheduled = openContinuationTaskIds(snapshot);
    const findings: WatchdogFinding[] = [];
    for (const task of snapshot.tasks) {
      if (!isRepairableEpisode(task)) continue;
      if (live.has(task.id) || scheduled.has(task.id)) continue;
      if (idleSince(task, snapshot) < stallGrace(snapshot)) continue;
      findings.push({
        detectorId: "in_progress_no_active_run",
        taskId: task.id,
        runId: null,
        agentSlug: task.assigneeSlug,
        state: "stalled",
        reasonCode: "no_active_run",
        reasonDetail: "no active run",
        repair: "queue_continuation",
        priority: 60,
      });
    }
    return findings;
  },
};

// 3 — a run performed start (or any continuation-required action) and then
// produced no subsequent work.
const STARTED_NO_WORK: WatchdogDetector = {
  id: "started_no_work",
  statement:
    "A task whose last durable action is continuation-required, with nothing after it, is resumed instead of being left parked as a successful workflow.",
  detect: (snapshot) => {
    const live = liveRunTaskIds(snapshot);
    const scheduled = openContinuationTaskIds(snapshot);
    const findings: WatchdogFinding[] = [];
    for (const task of snapshot.tasks) {
      if (!isRepairableEpisode(task)) continue;
      if (live.has(task.id) || scheduled.has(task.id)) continue;
      if (!isContinuationRequiredAction(task.lastDurableAction)) continue;
      if (idleSince(task, snapshot) < stallGrace(snapshot)) continue;
      findings.push({
        detectorId: "started_no_work",
        taskId: task.id,
        runId: null,
        agentSlug: task.assigneeSlug,
        state: "stalled",
        reasonCode: "no_work_after_continuation_action",
        reasonDetail: `\`${task.lastDurableAction}\` continued the episode but nothing followed it`,
        repair: "queue_continuation",
        priority: 55,
      });
    }
    return findings;
  },
};

// 4 — open checklist items with no scheduled continuation.
const OPEN_CHECKLIST_NO_CONTINUATION: WatchdogDetector = {
  id: "open_checklist_no_continuation",
  statement:
    "An In Progress task with open implementation checklist items and nothing scheduled to work them gets one execution turn queued.",
  detect: (snapshot) => {
    const live = liveRunTaskIds(snapshot);
    const scheduled = openContinuationTaskIds(snapshot);
    const findings: WatchdogFinding[] = [];
    for (const task of snapshot.tasks) {
      if (!isRepairableEpisode(task)) continue;
      if (task.openChecklistCount <= 0) continue;
      if (live.has(task.id) || scheduled.has(task.id)) continue;
      if (idleSince(task, snapshot) < stallGrace(snapshot)) continue;
      findings.push({
        detectorId: "open_checklist_no_continuation",
        taskId: task.id,
        runId: null,
        agentSlug: task.assigneeSlug,
        state: "stalled",
        reasonCode: "open_checklist_without_continuation",
        reasonDetail: `${task.openChecklistCount} open checklist item(s) with no scheduled continuation`,
        repair: "queue_continuation",
        priority: 50,
      });
    }
    return findings;
  },
};

// 5 — blockers whose permission was already granted.
const BLOCKER_PERMISSION_ALREADY_GRANTED: WatchdogDetector = {
  id: "blocker_permission_already_granted",
  statement:
    "A task still parked on a permission blocker whose grant has already landed is woken, because the dependency it is waiting for no longer exists.",
  detect: (snapshot) => {
    const live = liveRunTaskIds(snapshot);
    const scheduled = openContinuationTaskIds(snapshot);
    const findings: WatchdogFinding[] = [];
    for (const task of snapshot.tasks) {
      if (task.status !== "In Progress" || !task.assigneeSlug) continue;
      const blocker = task.activeBlocker;
      if (!blocker || !blocker.permissionGranted) continue;
      if (live.has(task.id) || scheduled.has(task.id)) continue;
      if (idleSince(task, snapshot) < stallGrace(snapshot)) continue;
      findings.push({
        detectorId: "blocker_permission_already_granted",
        taskId: task.id,
        runId: null,
        agentSlug: task.assigneeSlug,
        state: "stalled",
        reasonCode: "blocker_permission_granted",
        reasonDetail:
          "the blocker's permission has already been granted, so nothing external is outstanding",
        repair: "wake_assignee",
        priority: 70,
      });
    }
    return findings;
  },
};

// 6 — repeated blocker/clear loops. ESCALATE ONLY.
const BLOCKER_CLEAR_LOOP: WatchdogDetector = {
  id: "blocker_clear_loop",
  statement:
    "A task that has flagged and cleared a blocker repeatedly inside the window is escalated, never auto-repaired.",
  detect: (snapshot) => {
    const findings: WatchdogFinding[] = [];
    for (const task of snapshot.tasks) {
      if (!isRepairableEpisode(task)) continue;
      if (task.blockerCycles < WATCHDOG_BLOCKER_LOOP_THRESHOLD) continue;
      findings.push({
        detectorId: "blocker_clear_loop",
        taskId: task.id,
        runId: null,
        agentSlug: task.assigneeSlug,
        state: "stalled",
        reasonCode: "blocker_clear_loop",
        reasonDetail: `${task.blockerCycles} blocker flag/clear cycles in the last ${Math.round(
          WATCHDOG_BLOCKER_LOOP_WINDOW_MS / 60_000,
        )} minutes`,
        repair: "escalate",
        priority: 100,
      });
    }
    return findings;
  },
};

// 7 — excessive session rotation or context failures. ESCALATE ONLY.
const SESSION_CHURN: WatchdogDetector = {
  id: "session_churn",
  statement:
    "A (task, agent) lane burning sessions or failing runs faster than the window allows is escalated, never auto-repaired.",
  detect: (snapshot) => {
    const since = snapshot.now - WATCHDOG_CHURN_WINDOW_MS;
    const repairableTaskIds = new Set(
      snapshot.tasks.filter(isRepairableEpisode).map((task) => task.id),
    );
    const sessions = new Map<string, Set<string>>();
    const failures = new Map<string, number>();
    const laneTask = new Map<string, { taskId: string; agentSlug: string }>();

    for (const run of snapshot.runs) {
      if (!run.taskId) continue;
      // Churn is actionable only while the assignee owns an active execution
      // episode. Historical runs on Review/Done/Backlog tasks are evidence,
      // not a reason to page the reporter or pull the implementer back in.
      if (!repairableTaskIds.has(run.taskId)) continue;
      if (run.createdAt < since) continue;
      const lane = `${run.taskId}|${run.agentSlug}`;
      laneTask.set(lane, { taskId: run.taskId, agentSlug: run.agentSlug });
      if (run.sessionKey) {
        const bucket = sessions.get(lane) ?? new Set<string>();
        bucket.add(run.sessionKey);
        sessions.set(lane, bucket);
      }
      if (run.status === "failed" || run.status === "timed_out") {
        failures.set(lane, (failures.get(lane) ?? 0) + 1);
      }
    }

    const findings: WatchdogFinding[] = [];
    for (const [lane, subject] of laneTask) {
      const distinctSessions = sessions.get(lane)?.size ?? 0;
      const failed = failures.get(lane) ?? 0;
      const churning = distinctSessions >= WATCHDOG_SESSION_CHURN_THRESHOLD;
      const failing = failed >= WATCHDOG_RUN_FAILURE_THRESHOLD;
      if (!churning && !failing) continue;
      const reason = churning
        ? `${distinctSessions} distinct sessions`
        : `${failed} failed or timed-out runs`;
      findings.push({
        detectorId: "session_churn",
        taskId: subject.taskId,
        runId: null,
        agentSlug: subject.agentSlug,
        state: "stalled",
        reasonCode: churning ? "session_rotation" : "repeated_run_failure",
        reasonDetail: `${reason} in the last ${Math.round(
          WATCHDOG_CHURN_WINDOW_MS / 60_000,
        )} minutes`,
        repair: "escalate",
        priority: 95,
      });
    }
    return findings;
  },
};

export const WATCHDOG_DETECTORS: readonly WatchdogDetector[] = [
  BLOCKER_CLEAR_LOOP,
  SESSION_CHURN,
  EXPIRED_LEASE,
  BLOCKER_PERMISSION_ALREADY_GRANTED,
  IN_PROGRESS_NO_ACTIVE_RUN,
  STARTED_NO_WORK,
  OPEN_CHECKLIST_NO_CONTINUATION,
];

export function watchdogDetectorById(id: string): WatchdogDetector | null {
  return WATCHDOG_DETECTORS.find((detector) => detector.id === id) ?? null;
}

/** Every finding across every detector, highest priority first. */
export function detectWatchdogFindings(
  snapshot: WatchdogSnapshot,
): WatchdogFinding[] {
  const findings: WatchdogFinding[] = [];
  for (const detector of WATCHDOG_DETECTORS) {
    findings.push(...detector.detect(snapshot));
  }
  return findings.sort((a, b) => b.priority - a.priority);
}

/**
 * The state a task is in when NO detector fired. Without this the row would
 * only ever describe trouble, and an operator could not tell "healthy" from
 * "never evaluated".
 */
export function healthyExecutionState(
  task: WatchdogTaskRecord,
  snapshot: WatchdogSnapshot,
): { state: ExecutionState; reasonCode: string; reasonDetail: string } {
  if (task.status === "Review") {
    return {
      state: "waiting_review",
      reasonCode: "awaiting_review",
      reasonDetail: "implementation is complete and waiting on the reviewer",
    };
  }
  if (task.activeBlocker?.needsExternalInput && !task.activeBlocker.permissionGranted) {
    return {
      state: "blocked",
      reasonCode: "external_dependency",
      reasonDetail: "a formal blocker is waiting on external input",
    };
  }
  if (liveRunTaskIds(snapshot).has(task.id)) {
    return {
      state: "running",
      reasonCode: "active_run",
      reasonDetail: "an execution turn is running",
    };
  }
  if (openContinuationTaskIds(snapshot).has(task.id)) {
    return {
      state: "running",
      reasonCode: "continuation_scheduled",
      reasonDetail: "the next execution turn is scheduled",
    };
  }
  return {
    state: "idle",
    reasonCode: "no_work_scheduled",
    reasonDetail: "no execution turn is running or scheduled",
  };
}
