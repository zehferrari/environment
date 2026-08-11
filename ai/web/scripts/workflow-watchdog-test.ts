// ENV-123 — fixture tests for the watchdog detectors.
//
// No database: the detectors are pure predicates over plain record shapes, so
// every one of the seven failure modes is proved with a hand-built snapshot.
// The live-DB binding is proved separately in scripts/workflow-watchdog-db-test.ts.
//
// Exit 0 on success, non-zero on the first failed assertion.

import {
  detectWatchdogFindings,
  healthyExecutionState,
  WATCHDOG_BLOCKER_LOOP_THRESHOLD,
  WATCHDOG_DETECTORS,
  WATCHDOG_SESSION_CHURN_THRESHOLD,
  WATCHDOG_STALL_GRACE_MS,
  type WatchdogContinuationRecord,
  type WatchdogFinding,
  type WatchdogRunRecord,
  type WatchdogSnapshot,
  type WatchdogTaskRecord,
} from "@/lib/agents/watchdog/detectors";
import {
  executionStateLines,
  formatLastDurableAction,
  renderExecutionState,
  EXECUTION_STATES,
} from "@/lib/agents/watchdog/state";
import { executionStateForWorkflowAction } from "@/lib/agents/watchdog/transitions";
import { WORKFLOW_ACTION_CLASS } from "@/lib/workflow-invariants";

let checks = 0;

function fail(message: string): never {
  console.error(`[workflow-watchdog] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: unknown, label: string): asserts condition {
  checks += 1;
  if (!condition) fail(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  checks += 1;
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const NOW = 1_770_000_000_000;
const MINUTE = 60_000;
const STALE = NOW - (WATCHDOG_STALL_GRACE_MS + 5 * MINUTE);

function task(overrides: Partial<WatchdogTaskRecord> = {}): WatchdogTaskRecord {
  return {
    id: "task-1",
    projectId: "project-1",
    status: "In Progress",
    assigneeSlug: "barekbaal",
    openChecklistCount: 0,
    activeBlocker: null,
    blockerCycles: 0,
    lastDurableAction: "ready_for_review",
    lastDurableActionAt: STALE,
    breakerOpenUntil: null,
    ...overrides,
  };
}

function run(overrides: Partial<WatchdogRunRecord> = {}): WatchdogRunRecord {
  return {
    id: "run-1",
    taskId: "task-1",
    agentSlug: "barekbaal",
    status: "accepted",
    sessionKey: "session-1",
    createdAt: NOW - 2 * MINUTE,
    acceptedAt: NOW - 2 * MINUTE,
    streamingAt: null,
    lastEventAt: NOW - 2 * MINUTE,
    lastAction: null,
    lastActionAt: null,
    settledByAction: null,
    disposition: null,
    ...overrides,
  };
}

function continuation(
  overrides: Partial<WatchdogContinuationRecord> = {},
): WatchdogContinuationRecord {
  return {
    id: "cont-1",
    taskId: "task-1",
    runId: "run-1",
    agentSlug: "barekbaal",
    status: "queued",
    availableAt: NOW,
    ...overrides,
  };
}

function snapshot(overrides: Partial<WatchdogSnapshot> = {}): WatchdogSnapshot {
  return { now: NOW, tasks: [], runs: [], continuations: [], ...overrides };
}

function byDetector(findings: WatchdogFinding[], id: string): WatchdogFinding[] {
  return findings.filter((finding) => finding.detectorId === id);
}

// ------------------------------------------------------------------
// Registry
// ------------------------------------------------------------------

assertEqual(WATCHDOG_DETECTORS.length, 7, "every failure mode in the task description has a detector");
assertEqual(
  new Set(WATCHDOG_DETECTORS.map((detector) => detector.id)).size,
  7,
  "detector ids are unique",
);
for (const detector of WATCHDOG_DETECTORS) {
  assert(detector.statement.trim().length > 0, `${detector.id} states what it checks`);
}

// ------------------------------------------------------------------
// 1 — expired run leases
// ------------------------------------------------------------------

{
  const stale = run({ lastEventAt: NOW - 60 * MINUTE, acceptedAt: NOW - 60 * MINUTE });
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task()], runs: [stale] }),
  );
  const hits = byDetector(findings, "expired_lease");
  assertEqual(hits.length, 1, "an active run with a dead lease is detected");
  assertEqual(hits[0].repair, "settle_run", "the expired-lease repair settles the run");
  assertEqual(hits[0].runId, "run-1", "the finding names the run it is about");
}

{
  const findings = detectWatchdogFindings(snapshot({ tasks: [task()], runs: [run()] }));
  assertEqual(byDetector(findings, "expired_lease").length, 0, "a fresh lease is not a finding");
}

{
  // A terminal run cannot have an expired lease: it is not claiming anything.
  const findings = detectWatchdogFindings(
    snapshot({
      tasks: [task()],
      runs: [run({ status: "completed", lastEventAt: NOW - 60 * MINUTE })],
    }),
  );
  assertEqual(byDetector(findings, "expired_lease").length, 0, "terminal runs are not lease findings");
}

// ------------------------------------------------------------------
// 2 — In Progress with no active run
// ------------------------------------------------------------------

{
  const findings = detectWatchdogFindings(snapshot({ tasks: [task()] }));
  const hits = byDetector(findings, "in_progress_no_active_run");
  assertEqual(hits.length, 1, "an In Progress task with nothing running is detected");
  assertEqual(hits[0].reasonDetail, "no active run", "the reason matches the task description verbatim");
  assertEqual(hits[0].repair, "queue_continuation", "the repair queues one execution turn");
}

{
  const findings = detectWatchdogFindings(snapshot({ tasks: [task()], runs: [run()] }));
  assertEqual(
    byDetector(findings, "in_progress_no_active_run").length,
    0,
    "a live run means the task is not stalled",
  );
}

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task()], continuations: [continuation()] }),
  );
  assertEqual(
    byDetector(findings, "in_progress_no_active_run").length,
    0,
    "an open continuation already owns the next turn",
  );
}

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task()], continuations: [continuation({ status: "superseded" })] }),
  );
  assertEqual(
    byDetector(findings, "in_progress_no_active_run").length,
    1,
    "a superseded continuation owes the task nothing",
  );
}

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task({ lastDurableActionAt: NOW - MINUTE })] }),
  );
  assertEqual(
    byDetector(findings, "in_progress_no_active_run").length,
    0,
    "the stall grace protects a task that just acted",
  );
}

{
  const findings = detectWatchdogFindings(snapshot({ tasks: [task({ assigneeSlug: null })] }));
  assertEqual(findings.length, 0, "an unassigned task is nobody's execution episode");
}

{
  const findings = detectWatchdogFindings(snapshot({ tasks: [task({ status: "Review" })] }));
  assertEqual(findings.length, 0, "Review is the reviewer's, not the watchdog's");
}

{
  const reviewTask = task({
    status: "Review",
    blockerCycles: WATCHDOG_BLOCKER_LOOP_THRESHOLD,
  });
  const reviewRuns = Array.from({ length: WATCHDOG_SESSION_CHURN_THRESHOLD }, (_, index) =>
    run({
      id: `review-run-${index}`,
      sessionKey: `review-session-${index}`,
      status: "completed",
      createdAt: NOW - (index + 1) * MINUTE,
      lastEventAt: NOW - (index + 1) * MINUTE,
    }),
  );
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [reviewTask], runs: reviewRuns }),
  );
  assertEqual(
    findings.length,
    0,
    "historical blocker/session churn on Review never pages or wakes the implementer",
  );
}

{
  const blocked = task({
    activeBlocker: { needsExternalInput: true, permissionGranted: false, raisedAt: STALE },
  });
  const findings = detectWatchdogFindings(snapshot({ tasks: [blocked] }));
  assertEqual(findings.length, 0, "a genuine external blocker is waiting on purpose");
}

// ------------------------------------------------------------------
// 3 — start happened, nothing followed
// ------------------------------------------------------------------

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task({ lastDurableAction: "start" })] }),
  );
  const hits = byDetector(findings, "started_no_work");
  assertEqual(hits.length, 1, "a task parked on `start` is detected");
  assertEqual(hits[0].repair, "queue_continuation", "the repair resumes the episode");
  assert(hits[0].reasonDetail.includes("start"), "the reason names the action that parked it");
}

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task({ lastDurableAction: "ready_for_review" })] }),
  );
  assertEqual(
    byDetector(findings, "started_no_work").length,
    0,
    "an episode-terminal action legitimately ends the episode",
  );
}

// ------------------------------------------------------------------
// 4 — open checklist with no scheduled continuation
// ------------------------------------------------------------------

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task({ openChecklistCount: 3 })] }),
  );
  const hits = byDetector(findings, "open_checklist_no_continuation");
  assertEqual(hits.length, 1, "open checklist items with nothing scheduled are detected");
  assert(hits[0].reasonDetail.includes("3"), "the reason counts the open items");
}

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task({ openChecklistCount: 0 })] }),
  );
  assertEqual(
    byDetector(findings, "open_checklist_no_continuation").length,
    0,
    "an empty checklist is not an open checklist",
  );
}

// ------------------------------------------------------------------
// 5 — blocker whose permission was already granted
// ------------------------------------------------------------------

{
  const granted = task({
    activeBlocker: { needsExternalInput: true, permissionGranted: true, raisedAt: STALE },
  });
  const findings = detectWatchdogFindings(snapshot({ tasks: [granted] }));
  const hits = byDetector(findings, "blocker_permission_already_granted");
  assertEqual(hits.length, 1, "a granted permission blocker is detected");
  assertEqual(hits[0].repair, "wake_assignee", "the repair wakes the assignee");
  assert(
    hits[0].priority > (byDetector(findings, "in_progress_no_active_run")[0]?.priority ?? 0),
    "the granted-permission diagnosis outranks the generic no-active-run one",
  );
}

// ------------------------------------------------------------------
// 6 — blocker/clear loops (escalate only)
// ------------------------------------------------------------------

{
  const looping = task({ blockerCycles: WATCHDOG_BLOCKER_LOOP_THRESHOLD });
  const findings = detectWatchdogFindings(snapshot({ tasks: [looping] }));
  const hits = byDetector(findings, "blocker_clear_loop");
  assertEqual(hits.length, 1, "a blocker/clear loop is detected");
  assertEqual(hits[0].repair, "escalate", "a loop is escalated, never auto-repaired");
  assertEqual(findings[0].detectorId, "blocker_clear_loop", "escalation outranks every repair");
}

{
  const findings = detectWatchdogFindings(
    snapshot({ tasks: [task({ blockerCycles: WATCHDOG_BLOCKER_LOOP_THRESHOLD - 1 })] }),
  );
  assertEqual(
    byDetector(findings, "blocker_clear_loop").length,
    0,
    "cycles below the threshold are not a loop",
  );
}

// ------------------------------------------------------------------
// 7 — session churn / repeated context failures (escalate only)
// ------------------------------------------------------------------

{
  const runs = Array.from({ length: WATCHDOG_SESSION_CHURN_THRESHOLD }, (_, index) =>
    run({
      id: `run-${index}`,
      sessionKey: `session-${index}`,
      status: "completed",
      createdAt: NOW - (index + 1) * MINUTE,
      lastEventAt: NOW - (index + 1) * MINUTE,
    }),
  );
  const findings = detectWatchdogFindings(snapshot({ tasks: [task()], runs }));
  const hits = byDetector(findings, "session_churn");
  assertEqual(hits.length, 1, "excessive session rotation is detected");
  assertEqual(hits[0].repair, "escalate", "churn is escalated, never auto-repaired");
  assertEqual(hits[0].reasonCode, "session_rotation", "the reason code names the rotation");
}

{
  const runs = [0, 1, 2].map((index) =>
    run({
      id: `run-${index}`,
      sessionKey: "session-1",
      status: "failed",
      createdAt: NOW - (index + 1) * MINUTE,
      lastEventAt: NOW - (index + 1) * MINUTE,
    }),
  );
  const findings = detectWatchdogFindings(snapshot({ tasks: [task()], runs }));
  const hits = byDetector(findings, "session_churn");
  assertEqual(hits.length, 1, "repeated run failures are detected");
  assertEqual(hits[0].reasonCode, "repeated_run_failure", "the reason code names the failures");
}

{
  const runs = Array.from({ length: WATCHDOG_SESSION_CHURN_THRESHOLD }, (_, index) =>
    run({
      id: `run-${index}`,
      sessionKey: `session-${index}`,
      status: "completed",
      // Outside the churn window entirely.
      createdAt: NOW - (index + 2) * 24 * 60 * MINUTE,
      lastEventAt: NOW - (index + 2) * 24 * 60 * MINUTE,
    }),
  );
  const findings = detectWatchdogFindings(snapshot({ tasks: [task()], runs }));
  assertEqual(byDetector(findings, "session_churn").length, 0, "old sessions are outside the window");
}

// ------------------------------------------------------------------
// Priority ordering and per-task lead finding
// ------------------------------------------------------------------

{
  const both = task({ blockerCycles: WATCHDOG_BLOCKER_LOOP_THRESHOLD, openChecklistCount: 2 });
  const findings = detectWatchdogFindings(snapshot({ tasks: [both] }));
  assert(findings.length >= 2, "one task can produce several findings");
  for (let i = 1; i < findings.length; i += 1) {
    assert(
      findings[i - 1].priority >= findings[i].priority,
      "findings come back highest-priority first",
    );
  }
}

// ------------------------------------------------------------------
// Healthy states
// ------------------------------------------------------------------

{
  const healthy = healthyExecutionState(task(), snapshot({ tasks: [task()], runs: [run()] }));
  assertEqual(healthy.state, "running", "a live run reads as running");
}

{
  const withContinuation = snapshot({ tasks: [task()], continuations: [continuation()] });
  assertEqual(
    healthyExecutionState(task(), withContinuation).state,
    "running",
    "a scheduled continuation reads as running",
  );
}

{
  assertEqual(
    healthyExecutionState(task({ status: "Review" }), snapshot()).state,
    "waiting_review",
    "Review reads as waiting_review",
  );
}

{
  const blocked = task({
    activeBlocker: { needsExternalInput: true, permissionGranted: false, raisedAt: STALE },
  });
  assertEqual(healthyExecutionState(blocked, snapshot()).state, "blocked", "an open blocker reads as blocked");
}

{
  assertEqual(
    healthyExecutionState(task(), snapshot()).state,
    "idle",
    "nothing running and nothing scheduled reads as idle",
  );
}

// ------------------------------------------------------------------
// Rendering — the exact four lines the task description asks for
// ------------------------------------------------------------------

{
  const at = new Date(2026, 7, 5, 9, 24);
  assertEqual(
    formatLastDurableAction("start", at),
    "start at 09:24",
    "the last durable action renders as `<action> at HH:MM`",
  );
  assertEqual(
    formatLastDurableAction("ready_for_review", at),
    "ready for review at 09:24",
    "underscores render as spaces",
  );
  assertEqual(formatLastDurableAction(null, at), null, "no action renders as nothing");

  const rendered = renderExecutionState({
    state: "stalled",
    reasonDetail: "no active run",
    lastDurableAction: "start",
    lastDurableActionAt: at,
    recoveryAction: "new run queued",
  });
  const lines = executionStateLines(rendered);
  assertEqual(lines[0], "Execution: stalled", "line 1");
  assertEqual(lines[1], "Reason: no active run", "line 2");
  assertEqual(lines[2], "Last durable action: start at 09:24", "line 3");
  assertEqual(lines[3], "Recovery: new run queued", "line 4");
  assertEqual(lines.length, 4, "exactly the four operator lines");
}

{
  const lines = executionStateLines(
    renderExecutionState({
      state: "running",
      reasonDetail: "an execution turn is running",
      lastDurableAction: null,
      lastDurableActionAt: null,
      recoveryAction: null,
    }),
  );
  assertEqual(lines.length, 2, "lines with nothing to say are omitted rather than rendered empty");
}

// ------------------------------------------------------------------
// Ordinary workflow transitions (lib/agents/watchdog/transitions.ts)
//
// The reviewer's constraint on the Action Plan was explicit: ordinary workflow
// transitions, not just watchdog passes, must keep the operator-visible state
// current. The mapping is pure, so it is proved here rather than against a DB.
// ------------------------------------------------------------------
{
  assertEqual(
    executionStateForWorkflowAction({ action: "start", status: "In Progress" }).state,
    "running",
    "start puts the task in running",
  );
  assertEqual(
    executionStateForWorkflowAction({ action: "complete_subtask", status: "In Progress" }).state,
    "running",
    "a continuation-required action means the agent is still working",
  );
  assertEqual(
    executionStateForWorkflowAction({ action: "ready_for_review", status: "Review" }).state,
    "waiting_review",
    "ready_for_review lands in waiting_review",
  );
  assertEqual(
    executionStateForWorkflowAction({ action: "review_done", status: "Done" }).state,
    "idle",
    "a Done task is idle, not running",
  );
  assertEqual(
    executionStateForWorkflowAction({ action: "flag_blocker", status: "In Progress" }).state,
    "blocked",
    "flagging a blocker shows as blocked even though the task stays In Progress",
  );
  // The precedence rule that matters: an unresolved external dependency
  // outranks the action class. Without this a `complete_subtask` on a blocked
  // task would paint "running" over a task that cannot move without a human.
  assertEqual(
    executionStateForWorkflowAction({
      action: "complete_subtask",
      status: "In Progress",
      blockedExternally: true,
    }).state,
    "blocked",
    "an active external blocker outranks a continuation-required action",
  );
  assertEqual(
    executionStateForWorkflowAction({ action: "triage_to_todo", status: "To Do" }).state,
    "idle",
    "an episode-terminal action hands control back",
  );
  // Every action PM can route must produce a state — an unmapped action that
  // silently fell through would leave the strip stale after a real transition.
  for (const action of Object.keys(WORKFLOW_ACTION_CLASS)) {
    const mapped = executionStateForWorkflowAction({ action, status: "In Progress" });
    assert(
      EXECUTION_STATES.includes(mapped.state),
      `every workflow action maps to a known execution state (${action})`,
    );
    assert(mapped.reasonDetail.length > 0, `every mapping explains itself (${action})`);
  }
}

console.log(`[workflow-watchdog] OK — ${checks} checks passed`);
