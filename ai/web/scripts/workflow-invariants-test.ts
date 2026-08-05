// ENV-116 — fixture unit tests for the workflow invariant registry.
//
// Pure: no database, no Prisma, no network. Every predicate in
// lib/workflow-invariants.ts gets a positive case (the shape it must reject)
// and a negative case (the shape it must accept), plus coverage of the
// baseline comparator's three drift kinds.
//
// Exit 0 on success, non-zero on the first failed assertion.

import {
  WORKFLOW_INVARIANTS,
  WORKFLOW_DISPOSITIONS,
  WORKFLOW_ACTION_CLASS,
  WORKFLOW_RUN_LEASE_TTL_MS,
  compareToBaseline,
  emptySnapshot,
  evaluateWorkflowInvariants,
  isContinuationRequiredAction,
  isWorkflowDisposition,
  runLeaseAnchor,
  runLeaseExpired,
  workflowInvariantById,
  type BlockerRecord,
  type InvariantBaseline,
  type RunRecord,
  type TaskRecord,
  type WorkflowInvariantSnapshot,
} from "@/lib/workflow-invariants";

let checks = 0;

function fail(msg: string): never {
  console.error(`[workflow-invariants] FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, label: string): asserts cond {
  checks += 1;
  if (!cond) fail(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  checks += 1;
  if (actual !== expected) {
    fail(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const NOW = 1_800_000_000_000;
const FRESH = NOW - 60_000;
const STALE = NOW - WORKFLOW_RUN_LEASE_TTL_MS - 60_000;

let runSeq = 0;

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  runSeq += 1;
  return {
    id: `run-${runSeq}`,
    agentSlug: "barekbaal",
    taskId: "task-1",
    epicId: null,
    messageId: `msg-${runSeq}`,
    status: "completed",
    createdAt: FRESH,
    acceptedAt: FRESH,
    streamingAt: null,
    completedAt: FRESH,
    failedAt: null,
    lastEventAt: FRESH,
    settledByAction: null,
    finalResponseText: "done",
    disposition: "completed",
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    status: "In Progress",
    assigneeSlug: "barekbaal",
    approvedOn: FRESH,
    checklistCount: 3,
    planStepSource: "structured",
    ...overrides,
  };
}

function blocker(overrides: Partial<BlockerRecord> = {}): BlockerRecord {
  return {
    id: "blocker-1",
    taskId: "task-1",
    kind: "task.blocker",
    externalActor: "zeh",
    requirement: "Grant publish_checkpoint for env-116 onto pm-workflow.",
    clearedAt: null,
    ...overrides,
  };
}

function snapshot(
  parts: Partial<WorkflowInvariantSnapshot> = {},
): WorkflowInvariantSnapshot {
  return { ...emptySnapshot(NOW), ...parts };
}

function codesFor(
  invariantId: string,
  snap: WorkflowInvariantSnapshot,
): string[] {
  const invariant = workflowInvariantById(invariantId);
  if (!invariant) fail(`registry is missing ${invariantId}`);
  return invariant
    .predicate(snap)
    .violations.map((violation) => violation.code)
    .sort();
}

function expectViolations(
  invariantId: string,
  snap: WorkflowInvariantSnapshot,
  expected: string[],
  label: string,
): void {
  const actual = codesFor(invariantId, snap);
  assertEqual(actual.join(","), [...expected].sort().join(","), label);
}

// ------------------------------------------------------------------
// Registry shape
// ------------------------------------------------------------------
{
  assertEqual(WORKFLOW_INVARIANTS.length, 8, "registry holds eight invariants");

  const ids = WORKFLOW_INVARIANTS.map((invariant) => invariant.id);
  assertEqual(new Set(ids).size, ids.length, "invariant ids are unique");
  for (const id of ids) {
    assert(/^WFI-\d{3}$/.test(id), `invariant id ${id} follows WFI-NNN`);
  }
  for (const invariant of WORKFLOW_INVARIANTS) {
    assert(
      invariant.statement.trim().length > 20,
      `${invariant.id} carries a real statement`,
    );
    assert(
      invariant.epicItem >= 1 && invariant.epicItem <= 9,
      `${invariant.id} maps to an Epic item`,
    );
  }
  assertEqual(
    workflowInvariantById("WFI-999"),
    null,
    "unknown invariant id resolves to null",
  );

  // An empty world violates nothing.
  const clean = evaluateWorkflowInvariants(emptySnapshot(NOW));
  assert(clean.ok, "empty snapshot is clean");
  assertEqual(clean.violations.length, 0, "empty snapshot yields no violations");
}

// ------------------------------------------------------------------
// Disposition enum + action classification (Epic items 1 and 3)
// ------------------------------------------------------------------
{
  assertEqual(
    WORKFLOW_DISPOSITIONS.join(","),
    "continue,waiting_external,ready_for_review,completed,failed",
    "disposition enum is the closed set from the task description",
  );
  assert(isWorkflowDisposition("waiting_external"), "known disposition accepted");
  assert(!isWorkflowDisposition("succeeded"), "unknown disposition rejected");
  assert(!isWorkflowDisposition(null), "null disposition rejected");

  for (const action of [
    "start",
    "add_subtask",
    "complete_subtask",
    "clear_blocker",
  ]) {
    assert(
      isContinuationRequiredAction(action),
      `${action} is continuation-required (Epic item 1)`,
    );
  }
  for (const action of ["ready_for_review", "review_done", "flag_blocker"]) {
    assert(
      !isContinuationRequiredAction(action),
      `${action} is episode-terminal`,
    );
  }
  assert(
    !isContinuationRequiredAction("not_an_action"),
    "unknown action is not continuation-required",
  );
  assert(
    !isContinuationRequiredAction(null),
    "absent action is not continuation-required",
  );

  // The classification table must cover every action the live endpoint
  // accepts. Kept in sync by hand; this assertion is the tripwire.
  const endpointActions = [
    "start",
    "checkpoint",
    "publish_checkpoint",
    "ready_for_review",
    "submit_review",
    "review_feedback",
    "review_done",
    "triage_to_todo",
    "approve_plan",
    "assign_after_plan_approval",
    "add_subtask",
    "complete_subtask",
    "remove_subtask",
    "request_subtask",
    "request_task",
    "flag_blocker",
    "clear_blocker",
    "flag_extra_work_blocker",
  ];
  for (const action of endpointActions) {
    assert(
      WORKFLOW_ACTION_CLASS[action] != null,
      `workflow action ${action} is classified`,
    );
  }
  assertEqual(
    Object.keys(WORKFLOW_ACTION_CLASS).length,
    endpointActions.length,
    "classification table has no entries the endpoint does not accept",
  );
}

// ------------------------------------------------------------------
// Lease helpers
// ------------------------------------------------------------------
{
  const anchored = run({
    lastEventAt: null,
    streamingAt: null,
    acceptedAt: STALE,
    createdAt: STALE - 1000,
  });
  assertEqual(runLeaseAnchor(anchored), STALE, "lease falls back to acceptedAt");

  const bare = run({
    lastEventAt: null,
    streamingAt: null,
    acceptedAt: null,
    createdAt: STALE,
  });
  assertEqual(runLeaseAnchor(bare), STALE, "lease falls back to createdAt");

  assert(runLeaseExpired(bare, NOW), "stale anchor is expired");
  assert(
    !runLeaseExpired(run({ lastEventAt: FRESH }), NOW),
    "fresh anchor is not expired",
  );
  // Exactly at the TTL boundary is still alive — expiry is strictly greater.
  assert(
    !runLeaseExpired(
      run({ lastEventAt: NOW - WORKFLOW_RUN_LEASE_TTL_MS }),
      NOW,
    ),
    "TTL boundary is inclusive",
  );
}

// ------------------------------------------------------------------
// WFI-001 — at most one genuinely active run per lane
// ------------------------------------------------------------------
{
  expectViolations(
    "WFI-001",
    snapshot({
      runs: [
        run({ id: "a", status: "accepted", lastEventAt: FRESH }),
        run({ id: "b", status: "streaming", lastEventAt: FRESH }),
      ],
    }),
    ["WFI-001/multiple-active-runs"],
    "two live runs in one lane violate WFI-001",
  );

  expectViolations(
    "WFI-001",
    snapshot({
      runs: [
        run({ id: "a", status: "accepted", lastEventAt: FRESH }),
        run({ id: "b", status: "accepted", lastEventAt: STALE }),
      ],
    }),
    [],
    "a stale sibling is not genuinely active, so WFI-001 stays clean",
  );

  expectViolations(
    "WFI-001",
    snapshot({
      runs: [
        run({ id: "a", status: "accepted", lastEventAt: FRESH }),
        run({
          id: "b",
          status: "accepted",
          lastEventAt: FRESH,
          agentSlug: "carmen",
        }),
      ],
    }),
    [],
    "different agents are different lanes",
  );

  expectViolations(
    "WFI-001",
    snapshot({
      runs: [
        run({ id: "a", status: "accepted", lastEventAt: FRESH }),
        run({
          id: "b",
          status: "accepted",
          lastEventAt: FRESH,
          taskId: "task-2",
        }),
      ],
    }),
    [],
    "different tasks are different lanes",
  );
}

// ------------------------------------------------------------------
// WFI-002 — renew the lease or become terminal
// ------------------------------------------------------------------
{
  expectViolations(
    "WFI-002",
    snapshot({ runs: [run({ status: "accepted", lastEventAt: STALE })] }),
    ["WFI-002/lease-not-renewed"],
    "an accepted run past TTL violates WFI-002",
  );

  expectViolations(
    "WFI-002",
    snapshot({ runs: [run({ status: "queued", lastEventAt: STALE })] }),
    ["WFI-002/lease-not-renewed"],
    "a queued run past TTL violates WFI-002",
  );

  expectViolations(
    "WFI-002",
    snapshot({ runs: [run({ status: "accepted", lastEventAt: FRESH })] }),
    [],
    "a renewed accepted run is fine",
  );

  expectViolations(
    "WFI-002",
    snapshot({
      runs: [run({ status: "failed", lastEventAt: STALE, failedAt: STALE })],
    }),
    [],
    "a terminal run is exempt from lease renewal however old",
  );
}

// ------------------------------------------------------------------
// WFI-003 — an old accepted run is not proof of work in progress
// ------------------------------------------------------------------
{
  expectViolations(
    "WFI-003",
    snapshot({
      tasks: [task({ status: "In Progress" })],
      runs: [run({ status: "accepted", lastEventAt: STALE, createdAt: STALE })],
    }),
    ["WFI-003/stale-active-run-without-successor"],
    "In Progress backed only by a stale accepted run violates WFI-003",
  );

  expectViolations(
    "WFI-003",
    snapshot({
      tasks: [task({ status: "In Progress" })],
      runs: [
        run({ id: "old", status: "accepted", lastEventAt: STALE, createdAt: STALE }),
        run({ id: "new", status: "streaming", createdAt: FRESH, lastEventAt: FRESH }),
      ],
    }),
    [],
    "a superseding run clears WFI-003",
  );

  expectViolations(
    "WFI-003",
    snapshot({
      tasks: [task({ status: "Review" })],
      runs: [run({ status: "accepted", lastEventAt: STALE, createdAt: STALE })],
    }),
    [],
    "WFI-003 only judges In Progress tasks",
  );
}

// ------------------------------------------------------------------
// WFI-004 — continuation-required actions cannot end an episode
// ------------------------------------------------------------------
{
  for (const action of ["start", "add_subtask", "complete_subtask", "clear_blocker"]) {
    expectViolations(
      "WFI-004",
      snapshot({
        runs: [
          run({ status: "completed", settledByAction: action, completedAt: FRESH }),
        ],
      }),
      ["WFI-004/continuation-action-settled-episode"],
      `${action} settling a run complete violates WFI-004`,
    );
  }

  expectViolations(
    "WFI-004",
    snapshot({
      runs: [
        run({ status: "completed", settledByAction: "ready_for_review", completedAt: FRESH }),
      ],
    }),
    [],
    "ready_for_review is a legitimate episode end",
  );

  expectViolations(
    "WFI-004",
    snapshot({
      runs: [
        run({
          id: "settled",
          status: "completed",
          settledByAction: "start",
          completedAt: STALE,
          createdAt: STALE,
        }),
        run({ id: "continuation", status: "streaming", createdAt: FRESH }),
      ],
    }),
    [],
    "a continuation run following the action clears WFI-004",
  );
}

// ------------------------------------------------------------------
// WFI-005 — explicit disposition on every terminal run
// ------------------------------------------------------------------
{
  expectViolations(
    "WFI-005",
    snapshot({ runs: [run({ status: "completed", disposition: null })] }),
    ["WFI-005/missing-disposition"],
    "a complete run with no disposition violates WFI-005",
  );

  expectViolations(
    "WFI-005",
    snapshot({
      runs: [run({ status: "failed", failedAt: FRESH, disposition: null })],
    }),
    ["WFI-005/missing-disposition"],
    "a failed run with no disposition violates WFI-005",
  );

  expectViolations(
    "WFI-005",
    snapshot({ runs: [run({ status: "completed", disposition: "succeeded" })] }),
    ["WFI-005/unknown-disposition"],
    "an off-enum disposition violates WFI-005",
  );

  expectViolations(
    "WFI-005",
    snapshot({ runs: [run({ status: "completed", disposition: "completed" })] }),
    [],
    "a valid disposition satisfies WFI-005",
  );

  expectViolations(
    "WFI-005",
    snapshot({ runs: [run({ status: "cancelled", disposition: null })] }),
    [],
    "cancellation is not an agent turn ending",
  );

  expectViolations(
    "WFI-005",
    snapshot({ runs: [run({ status: "accepted", disposition: null })] }),
    [],
    "a still-running run has no disposition yet",
  );
}

// ------------------------------------------------------------------
// WFI-006 — an empty response is never successful completion
// ------------------------------------------------------------------
{
  for (const text of [null, "", "   \n\t "]) {
    expectViolations(
      "WFI-006",
      snapshot({
        runs: [run({ status: "completed", finalResponseText: text, settledByAction: null })],
      }),
      ["WFI-006/empty-final-response"],
      `an empty final response (${JSON.stringify(text)}) violates WFI-006`,
    );
  }

  expectViolations(
    "WFI-006",
    snapshot({
      runs: [
        run({
          status: "completed",
          finalResponseText: null,
          settledByAction: "ready_for_review",
        }),
      ],
    }),
    [],
    "a workflow action is a concrete outcome, so a silent reply is legitimate",
  );

  expectViolations(
    "WFI-006",
    snapshot({
      runs: [run({ status: "failed", failedAt: FRESH, finalResponseText: null })],
    }),
    [],
    "WFI-006 judges success, not failure",
  );
}

// ------------------------------------------------------------------
// WFI-007 — blockers need an external actor and an actionable requirement
// ------------------------------------------------------------------
{
  expectViolations(
    "WFI-007",
    snapshot({ blockers: [blocker({ externalActor: null })] }),
    ["WFI-007/blocker-missing-external-actor"],
    "a blocker with no external actor violates WFI-007",
  );

  expectViolations(
    "WFI-007",
    snapshot({ blockers: [blocker({ requirement: "  " })] }),
    ["WFI-007/blocker-missing-requirement"],
    "a blocker with a blank requirement violates WFI-007",
  );

  expectViolations(
    "WFI-007",
    snapshot({ blockers: [blocker({ externalActor: null, requirement: null })] }),
    [
      "WFI-007/blocker-missing-external-actor",
      "WFI-007/blocker-missing-requirement",
    ],
    "both gaps are reported independently",
  );

  expectViolations(
    "WFI-007",
    snapshot({
      blockers: [blocker({ externalActor: null, requirement: null, clearedAt: FRESH })],
    }),
    [],
    "a cleared blocker is out of scope",
  );

  expectViolations("WFI-007", snapshot({ blockers: [blocker()] }), [], "a well-formed blocker passes");
}

// ------------------------------------------------------------------
// WFI-008 — approved plans produce a durable checklist without prose parsing
// ------------------------------------------------------------------
{
  expectViolations(
    "WFI-008",
    snapshot({
      tasks: [task({ checklistCount: 0, planStepSource: "none" })],
    }),
    ["WFI-008/plan-without-structured-steps"],
    "an approved plan with no checklist violates WFI-008",
  );

  expectViolations(
    "WFI-008",
    snapshot({
      tasks: [task({ checklistCount: 5, planStepSource: "markdown-prose" })],
    }),
    ["WFI-008/checklist-parsed-from-prose"],
    "a checklist scraped from Markdown violates WFI-008 even when populated",
  );

  expectViolations(
    "WFI-008",
    snapshot({ tasks: [task({ approvedOn: null, checklistCount: 0 })] }),
    [],
    "an unapproved plan is out of scope",
  );

  expectViolations(
    "WFI-008",
    snapshot({
      tasks: [task({ assigneeSlug: null, checklistCount: 0, planStepSource: "none" })],
    }),
    [],
    "an unassigned task is out of scope",
  );

  expectViolations(
    "WFI-008",
    snapshot({ tasks: [task({ checklistCount: 3, planStepSource: "structured" })] }),
    [],
    "a structured plan with a checklist passes",
  );
}

// ------------------------------------------------------------------
// Baseline comparator
// ------------------------------------------------------------------
{
  const baseline: InvariantBaseline = {
    scenario: "unit",
    entries: [
      {
        invariantId: "WFI-005",
        epicItem: 3,
        codes: { "WFI-005/missing-disposition": 2 },
        note: "runs carry no disposition column yet",
      },
    ],
  };

  const matching = snapshot({
    runs: [
      run({ id: "m1", status: "completed", disposition: null, settledByAction: "ready_for_review" }),
      run({ id: "m2", status: "completed", disposition: null, settledByAction: "ready_for_review" }),
    ],
  });
  assertEqual(
    compareToBaseline(evaluateWorkflowInvariants(matching).violations, baseline).length,
    0,
    "an exact baseline match is green",
  );

  const undercount = snapshot({
    runs: [
      run({ id: "u1", status: "completed", disposition: null, settledByAction: "ready_for_review" }),
    ],
  });
  const undercountDrift = compareToBaseline(
    evaluateWorkflowInvariants(undercount).violations,
    baseline,
  );
  assertEqual(undercountDrift.length, 1, "a count change is drift");
  assertEqual(undercountDrift[0].kind, "count_mismatch", "count drift is classified");
  assertEqual(undercountDrift[0].expected, 2, "count drift reports the expectation");
  assertEqual(undercountDrift[0].actual, 1, "count drift reports the observation");

  const fixed = snapshot({ runs: [] });
  const fixedDrift = compareToBaseline(
    evaluateWorkflowInvariants(fixed).violations,
    baseline,
  );
  assertEqual(fixedDrift.length, 1, "an invariant that stops firing is drift");
  assertEqual(
    fixedDrift[0].kind,
    "unrecorded_pass",
    "a fixed invariant must delete its baseline entry atomically",
  );

  const regressed = snapshot({
    runs: [
      run({ id: "r1", status: "completed", disposition: null, settledByAction: "ready_for_review" }),
      run({ id: "r2", status: "completed", disposition: null, settledByAction: "ready_for_review" }),
      // Valid disposition, so this run adds a NEW code rather than inflating
      // the baselined WFI-005 count.
      run({ id: "r3", status: "completed", disposition: "completed", finalResponseText: null, settledByAction: null }),
    ],
  });
  const regressedDrift = compareToBaseline(
    evaluateWorkflowInvariants(regressed).violations,
    baseline,
  );
  assertEqual(regressedDrift.length, 1, "a new violation code is drift");
  assertEqual(regressedDrift[0].kind, "regression", "new codes are regressions");
  assertEqual(
    regressedDrift[0].code,
    "WFI-006/empty-final-response",
    "the regression names the offending code",
  );

  const stale = compareToBaseline([], {
    scenario: "unit",
    entries: [
      { invariantId: "WFI-404", epicItem: 1, codes: {}, note: "gone" },
    ],
  });
  assertEqual(stale.length, 1, "a baseline entry for an unknown invariant is drift");
  assertEqual(
    stale[0].kind,
    "unknown_baseline_invariant",
    "unknown baseline invariants are reported",
  );
}

console.log(`[workflow-invariants] OK — ${checks} assertions passed`);
