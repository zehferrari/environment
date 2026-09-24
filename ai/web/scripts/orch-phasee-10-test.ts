// PHASEE-10 — UI and agent visibility tests for the expanded projection,
// activity dedup, dashboard data, invariant detectors, and doctor output.
//
// Pure unit tests: no database, no Prisma, no network. Tests the pure
// functions exported from projection.ts (computeAllowedIntents with
// actorRole), activity-dedup.ts (computeActivityDedupeKey), and
// phase-e-invariants.ts (all four detectors + detectPhaseEInvariants).
//
// Exit 0 on success, non-zero on the first failed assertion.

import {
  computeAllowedIntents,
  type TaskWorkflowProjection,
} from "@/lib/tasks/orchestrator/projection";
import type {
  TaskStateSnapshot,
  TaskWorkflowIntent,
  WorkflowActorRole,
} from "@/lib/tasks/orchestrator/types";
import {
  computeActivityDedupeKey,
} from "@/lib/tasks/orchestrator/activity-dedup";
import {
  detectEngineOwnershipMismatch,
  detectStaleReceiptWithoutTransition,
  detectProcedureRunWithoutCycle,
  detectUnknownEngineValue,
  detectPhaseEInvariants,
  type PhaseEInvariantInput,
  type PhaseEInvariantFinding,
} from "@/lib/tasks/orchestrator/phase-e-invariants";

let checks = 0;

function fail(msg: string): never {
  console.error(`[orch-phasee-10] FAIL: ${msg}`);
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

function assertDeepEqual<T>(actual: T, expected: T, label: string): void {
  checks += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    fail(`${label}: expected ${e}, got ${a}`);
  }
}

function assertIncludes<T>(arr: T[], item: T, label: string): void {
  checks += 1;
  if (!arr.includes(item)) {
    fail(`${label}: expected array to include ${JSON.stringify(item)}, got [${arr.map(String).join(", ")}]`);
  }
}

function assertNotIncludes<T>(arr: T[], item: T, label: string): void {
  checks += 1;
  if (arr.includes(item)) {
    fail(`${label}: expected array to NOT include ${JSON.stringify(item)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers — build TaskStateSnapshot fixtures
// ---------------------------------------------------------------------------

function baseSnapshot(overrides: Partial<TaskStateSnapshot> = {}): TaskStateSnapshot {
  return {
    id: "task-1",
    status: "In Progress",
    workflowVersion: 1,
    projectId: "proj-1",
    epicId: "epic-1",
    assigneeId: "user-1",
    actingManagerId: null,
    reporterId: "user-2",
    approvedOn: new Date("2026-01-01T00:00:00Z"),
    approvedById: "user-2",
    activeWorkflowCycleId: "cycle-1",
    resolvedReviewOwnerId: "user-3",
    activeReviewRun: null,
    repositoryRun: null,
    project: {
      onlyReportersCanApproveActionPlans: false,
      onlyReportersCanSetTasksDone: false,
      repositoryPath: "/srv/Code/environment",
    },
    epic: { status: "In Progress", actingManagerId: "user-3" },
    ...overrides,
  };
}

function invariantInput(overrides: Partial<PhaseEInvariantInput> = {}): PhaseEInvariantInput {
  return {
    taskId: "task-1",
    taskEngine: "orchestrator_v2",
    taskEnginePinnedAt: new Date("2026-01-01T00:00:00Z"),
    activeCycle: {
      id: "cycle-1",
      workflowEngine: "orchestrator_v2",
      status: "open",
    },
    lastReceipt: {
      idempotencyKey: "key-1",
      intent: "start_implementation",
      status: "accepted",
      transitionId: "trans-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    activeProcedureRuns: [
      { id: "proc-1", type: "start_implementation", workflowCycleId: "cycle-1" },
    ],
    taskStatus: "In Progress",
    ...overrides,
  };
}

// ===========================================================================
// §1 — computeAllowedIntents with actorRole filtering
// ===========================================================================

// --- No actorRole: backward-compatible full set ---
{
  const snap = baseSnapshot({ status: "Backlog", approvedOn: null, activeWorkflowCycleId: null });
  const intents = computeAllowedIntents(snap);
  assertIncludes(intents, "submit_plan", "Backlog without approval includes submit_plan");
  assertIncludes(intents, "approve_plan", "Backlog without approval includes approve_plan");
  assertIncludes(intents, "request_plan_changes", "Backlog without approval includes request_plan_changes");
  assertIncludes(intents, "cancel_task", "Backlog includes cancel_task");
  assertNotIncludes(intents, "start_implementation", "Backlog without approval excludes start_implementation");
}

{
  const snap = baseSnapshot({ status: "To Do", approvedOn: new Date("2026-01-01T00:00:00Z") });
  const intents = computeAllowedIntents(snap);
  assertIncludes(intents, "start_implementation", "To Do with approval includes start_implementation");
}

{
  const snap = baseSnapshot({ status: "In Progress", activeWorkflowCycleId: "cycle-1" });
  const intents = computeAllowedIntents(snap);
  assertIncludes(intents, "checkpoint", "In Progress includes checkpoint");
  assertIncludes(intents, "submit_for_review", "In Progress includes submit_for_review");
  assertIncludes(intents, "raise_blocker", "In Progress includes raise_blocker");
  assertIncludes(intents, "clear_blocker", "In Progress includes clear_blocker");
}

{
  const snap = baseSnapshot({
    status: "Review",
    activeWorkflowCycleId: "cycle-1",
    activeReviewRun: {
      id: "review-1",
      status: "awaiting_review",
      candidateSha: "abc123",
      reviewerId: "user-3",
      baseSha: "def456",
      repoTouched: true,
      validationOutcome: "passed",
    },
  });
  const intents = computeAllowedIntents(snap);
  assertIncludes(intents, "accept_review", "Review with awaiting lease includes accept_review");
  assertIncludes(intents, "request_review_changes", "Review with awaiting lease includes request_review_changes");
  assertIncludes(intents, "repository_finalization_succeeded", "Review includes mechanical finalization intents");
}

{
  const snap = baseSnapshot({ status: "Done", activeWorkflowCycleId: null });
  const intents = computeAllowedIntents(snap);
  assertIncludes(intents, "archive_task", "Done includes archive_task");
  assertNotIncludes(intents, "cancel_task", "Done excludes cancel_task");
}

// --- actorRole filtering: assignee ---
{
  const snap = baseSnapshot({ status: "In Progress", activeWorkflowCycleId: "cycle-1" });
  const intents = computeAllowedIntents(snap, "assignee");
  assertIncludes(intents, "checkpoint", "assignee can checkpoint");
  assertIncludes(intents, "submit_for_review", "assignee can submit_for_review");
  assertIncludes(intents, "raise_blocker", "assignee can raise_blocker");
  assertNotIncludes(intents, "accept_review", "assignee cannot accept_review");
  assertNotIncludes(intents, "repository_finalization_succeeded", "assignee cannot submit mechanical intents");
}

// --- actorRole filtering: reviewer ---
{
  const snap = baseSnapshot({
    status: "Review",
    activeWorkflowCycleId: "cycle-1",
    activeReviewRun: {
      id: "review-1",
      status: "awaiting_review",
      candidateSha: "abc123",
      reviewerId: "user-3",
      baseSha: "def456",
      repoTouched: true,
      validationOutcome: "passed",
    },
  });
  const intents = computeAllowedIntents(snap, "reviewer");
  assertIncludes(intents, "accept_review", "reviewer can accept_review");
  assertIncludes(intents, "request_review_changes", "reviewer can request_review_changes");
  assertNotIncludes(intents, "checkpoint", "reviewer cannot checkpoint");
  assertNotIncludes(intents, "submit_for_review", "reviewer cannot submit_for_review");
  assertNotIncludes(intents, "repository_finalization_succeeded", "reviewer cannot submit mechanical intents");
}

// --- actorRole filtering: monitor ---
{
  const snap = baseSnapshot({ status: "Review", activeWorkflowCycleId: "cycle-1" });
  const intents = computeAllowedIntents(snap, "monitor");
  assertIncludes(intents, "repository_finalization_succeeded", "monitor can submit mechanical finalization");
  assertIncludes(intents, "repository_finalization_failed", "monitor can submit mechanical finalization failed");
  assertNotIncludes(intents, "checkpoint", "monitor cannot checkpoint");
  assertNotIncludes(intents, "submit_for_review", "monitor cannot submit_for_review");
  assertNotIncludes(intents, "accept_review", "monitor cannot accept_review");
}

// --- actorRole filtering: reporter ---
{
  const snap = baseSnapshot({ status: "Backlog", approvedOn: null, activeWorkflowCycleId: null });
  const intents = computeAllowedIntents(snap, "reporter");
  assertIncludes(intents, "approve_plan", "reporter can approve_plan");
  assertIncludes(intents, "request_plan_changes", "reporter can request_plan_changes");
  assertNotIncludes(intents, "submit_plan", "reporter cannot submit_plan");
  assertNotIncludes(intents, "start_implementation", "reporter cannot start_implementation");
}

// --- actorRole filtering: admin sees everything ---
{
  const snap = baseSnapshot({ status: "In Progress", activeWorkflowCycleId: "cycle-1" });
  const adminIntents = computeAllowedIntents(snap, "admin");
  const noRoleIntents = computeAllowedIntents(snap);
  // Admin should see at least everything the unfiltered set sees for In Progress.
  for (const intent of noRoleIntents) {
    assertIncludes(adminIntents, intent, `admin can submit ${intent}`);
  }
}

// --- actorRole: null preserves backward compatibility ---
{
  const snap = baseSnapshot({ status: "To Do", approvedOn: new Date("2026-01-01T00:00:00Z") });
  const nullRole = computeAllowedIntents(snap, null);
  const noRole = computeAllowedIntents(snap);
  assertDeepEqual(nullRole, noRole, "null actorRole matches omitted actorRole");
}

// --- dedup: no duplicate intents in output ---
{
  const snap = baseSnapshot({ status: "To Do", approvedOn: new Date("2026-01-01T00:00:00Z") });
  const intents = computeAllowedIntents(snap);
  const unique = new Set(intents);
  assertEqual(unique.size, intents.length, "no duplicate intents in output");
}

// ===========================================================================
// §2 — computeActivityDedupeKey
// ===========================================================================

{
  const key1 = computeActivityDedupeKey("task.workflow.legacy_boundary.invoked", "task-1", { legacyBoundary: "agent-task-workflow-route", entryPoint: "execute.ts" });
  const key2 = computeActivityDedupeKey("task.workflow.legacy_boundary.invoked", "task-1", { legacyBoundary: "agent-task-workflow-route", entryPoint: "execute.ts" });
  assertEqual(key1, key2, "same inputs produce same dedupe key");
}

{
  const key1 = computeActivityDedupeKey("task.workflow.legacy_boundary.invoked", "task-1", { legacyBoundary: "agent-task-workflow-route", entryPoint: "execute.ts" });
  const key2 = computeActivityDedupeKey("task.workflow.legacy_boundary.invoked", "task-1", { legacyBoundary: "browser-board-move-actions", entryPoint: "board.ts" });
  assert(key1 !== key2, "different payloads produce different dedupe keys");
}

{
  const key1 = computeActivityDedupeKey("some.kind", "task-1", { a: 1, b: 2 });
  const key2 = computeActivityDedupeKey("some.kind", "task-1", { b: 2, a: 1 });
  assertEqual(key1, key2, "key order in payload does not affect dedupe key");
}

{
  const key1 = computeActivityDedupeKey("some.kind", "task-1", { foo: "bar" });
  const key2 = computeActivityDedupeKey("some.kind", "task-2", { foo: "bar" });
  assert(key1 !== key2, "different taskIds produce different dedupe keys");
}

{
  const key1 = computeActivityDedupeKey("kind.a", "task-1", { foo: "bar" });
  const key2 = computeActivityDedupeKey("kind.b", "task-1", { foo: "bar" });
  assert(key1 !== key2, "different kinds produce different dedupe keys");
}

{
  const key1 = computeActivityDedupeKey("some.kind", null, { foo: "bar" });
  const key2 = computeActivityDedupeKey("some.kind", "task-1", { foo: "bar" });
  assert(key1 !== key2, "null taskId vs real taskId produce different keys");
}

{
  const key = computeActivityDedupeKey("test.kind", "task-1", { foo: "bar" });
  assert(key.startsWith("test.kind:task-1:"), "dedupe key has format kind:taskId:hash");
  const parts = key.split(":");
  assert(parts.length >= 3, "dedupe key has at least 3 colon-separated parts");
  // Hash part should be a hex string
  const hashPart = parts.slice(2).join(":");
  assert(/^[0-9a-f]+$/.test(hashPart), "hash part of dedupe key is hex");
}

// ===========================================================================
// §3 — Phase E invariant detectors
// ===========================================================================

// --- detectEngineOwnershipMismatch ---

{
  const input = invariantInput({
    taskEngine: "orchestrator_v2",
    activeCycle: { id: "cycle-1", workflowEngine: "orchestrator_v2", status: "open" },
  });
  const finding = detectEngineOwnershipMismatch(input);
  assertEqual(finding, null, "matching engines → no finding");
}

{
  const input = invariantInput({
    taskEngine: "orchestrator_v2",
    activeCycle: { id: "cycle-1", workflowEngine: "legacy", status: "open" },
  });
  const finding = detectEngineOwnershipMismatch(input);
  assert(finding !== null, "mismatched engines → finding");
  assertEqual(finding!.kind, "engine_ownership_mismatch", "finding kind");
  assertEqual(finding!.repair, "escalate", "repair is escalate");
  assert(finding!.detail.includes("cycle-1"), "finding detail names the cycle");
}

{
  const input = invariantInput({ activeCycle: null });
  const finding = detectEngineOwnershipMismatch(input);
  assertEqual(finding, null, "no active cycle → no mismatch finding");
}

// --- detectStaleReceiptWithoutTransition ---

{
  const input = invariantInput({
    lastReceipt: {
      idempotencyKey: "key-1",
      intent: "start_implementation",
      status: "accepted",
      transitionId: "trans-1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const finding = detectStaleReceiptWithoutTransition(input);
  assertEqual(finding, null, "accepted receipt with transition → no finding");
}

{
  const input = invariantInput({
    lastReceipt: {
      idempotencyKey: "key-1",
      intent: "start_implementation",
      status: "accepted",
      transitionId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const finding = detectStaleReceiptWithoutTransition(input);
  assert(finding !== null, "accepted receipt without transition → finding");
  assertEqual(finding!.kind, "stale_receipt_without_transition", "finding kind");
  assertEqual(finding!.repair, "escalate", "repair is escalate");
}

{
  const input = invariantInput({
    lastReceipt: {
      idempotencyKey: "key-1",
      intent: "start_implementation",
      status: "rejected",
      transitionId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const finding = detectStaleReceiptWithoutTransition(input);
  assertEqual(finding, null, "rejected receipt without transition → no finding (rejected is ok)");
}

{
  const input = invariantInput({ lastReceipt: null });
  const finding = detectStaleReceiptWithoutTransition(input);
  assertEqual(finding, null, "no receipt → no finding");
}

// Commands that keep the workflow version deliberately have no transition.
for (const intent of ["submit_plan", "checkpoint", "complete_subtask", "submit_for_review"]) {
  const receipt = {
    idempotencyKey: `same-state-${intent}`, intent, status: "completed",
    transitionId: null, expectedWorkflowVersion: 5, resultingWorkflowVersion: 5,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  assertEqual(detectStaleReceiptWithoutTransition(invariantInput({ lastReceipt: receipt })),
    null, `${intent} without a status transition is valid`);
  assert(detectStaleReceiptWithoutTransition(invariantInput({
    lastReceipt: { ...receipt, resultingWorkflowVersion: 6 },
  })) !== null, "a version advance still requires a transition");
}

// --- detectProcedureRunWithoutCycle ---

{
  const input = invariantInput({
    activeProcedureRuns: [
      { id: "proc-1", type: "start_implementation", workflowCycleId: "cycle-1" },
    ],
  });
  const finding = detectProcedureRunWithoutCycle(input);
  assertEqual(finding, null, "procedure with cycle → no finding");
}

{
  const input = invariantInput({
    activeProcedureRuns: [
      { id: "proc-1", type: "start_implementation", workflowCycleId: null },
    ],
  });
  const finding = detectProcedureRunWithoutCycle(input);
  assert(finding !== null, "procedure without cycle → finding");
  assertEqual(finding!.kind, "procedure_run_without_cycle", "finding kind");
  assertEqual(finding!.repair, "escalate", "repair is escalate");
  assert(finding!.detail.includes("proc-1"), "finding detail names the procedure");
}

{
  const input = invariantInput({
    activeProcedureRuns: [
      { id: "proc-1", type: "prepare_todo_task", workflowCycleId: null },
    ],
  });
  const finding = detectProcedureRunWithoutCycle(input);
  assertEqual(finding, null, "prepare_todo_task without cycle is exempted → no finding");
}

{
  const input = invariantInput({ activeProcedureRuns: [] });
  const finding = detectProcedureRunWithoutCycle(input);
  assertEqual(finding, null, "no procedure runs → no finding");
}

// --- detectUnknownEngineValue ---

{
  const input = invariantInput({
    taskEngine: "orchestrator_v2",
    activeCycle: { id: "cycle-1", workflowEngine: "orchestrator_v2", status: "open" },
  });
  const finding = detectUnknownEngineValue(input);
  assertEqual(finding, null, "valid engine → no finding");
}

{
  const input = invariantInput({
    taskEngine: "legacy",
    activeCycle: { id: "cycle-1", workflowEngine: "legacy", status: "open" },
  });
  const finding = detectUnknownEngineValue(input);
  assertEqual(finding, null, "legacy engine (valid) → no finding");
}

{
  const input = invariantInput({
    taskEngine: "unknown_engine",
    activeCycle: { id: "cycle-1", workflowEngine: "orchestrator_v2", status: "open" },
  });
  const finding = detectUnknownEngineValue(input);
  assert(finding !== null, "unknown engine value → finding");
  assertEqual(finding!.kind, "unknown_engine_value", "finding kind");
  assertEqual(finding!.repair, "escalate", "repair is escalate");
}

{
  const input = invariantInput({ activeCycle: null });
  // detectUnknownEngineValue fires on the task engine field regardless of cycle state
  const finding = detectUnknownEngineValue(input);
  assertEqual(finding, null, "no active cycle, valid engine → no finding");
}

{
  const input = invariantInput({ taskEngine: "bad_engine", activeCycle: null });
  // detectUnknownEngineValue fires even without a cycle (moved ahead of activeCycle guard)
  const finding = detectUnknownEngineValue(input);
  assert(finding !== null, "unknown engine with no cycle → finding fires");
  assertEqual(finding!.kind, "unknown_engine_value", "finding kind for cycle-less unknown engine");
}

// --- detectPhaseEInvariants (aggregate) ---

{
  const input = invariantInput(); // healthy
  const findings = detectPhaseEInvariants(input);
  assertEqual(findings.length, 0, "healthy input → zero findings");
}

{
  const input = invariantInput({
    taskEngine: "legacy",
    activeCycle: { id: "cycle-1", workflowEngine: "orchestrator_v2", status: "open" },
    lastReceipt: {
      idempotencyKey: "key-1",
      intent: "start_implementation",
      status: "accepted",
      transitionId: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    activeProcedureRuns: [
      { id: "proc-1", type: "start_implementation", workflowCycleId: null },
    ],
  });
  const findings = detectPhaseEInvariants(input);
  assertEqual(findings.length, 3, "triple violation → 3 findings (mismatch + stale receipt + proc without cycle)");
  const kinds = findings.map((f) => f.kind).sort();
  assertDeepEqual(kinds, ["engine_ownership_mismatch", "procedure_run_without_cycle", "stale_receipt_without_transition"].sort(), "finding kinds match");
}

{
  const input = invariantInput({
    taskEngine: "bad_engine",
    activeCycle: { id: "cycle-1", workflowEngine: "orchestrator_v2", status: "open" },
  });
  const findings = detectPhaseEInvariants(input);
  // engine_ownership_mismatch (task vs cycle) + unknown_engine_value (bad engine) + stale_receipt is null (receipt has transitionId)
  // Actually receipt has transitionId "trans-1" in base, so no stale receipt.
  // engine_ownership_mismatch + unknown_engine_value = 2
  assertEqual(findings.length, 2, "bad engine → 2 findings (mismatch + unknown engine)");
  const kinds = findings.map((f) => f.kind).sort();
  assertDeepEqual(kinds, ["engine_ownership_mismatch", "unknown_engine_value"].sort(), "finding kinds for bad engine");
}

// ===========================================================================
// §4 — Projection type shape verification
// ===========================================================================

// Verify the TaskWorkflowProjection type has all PHASEE-10 fields by
// constructing a value and checking its shape. This is a compile-time +
// runtime check that the exported type includes the new fields.
{
  const projection: TaskWorkflowProjection = {
    taskId: "task-1",
    status: "In Progress",
    workflowVersion: 2,
    workflowEngine: "orchestrator_v2",
    workflowEnginePinnedAt: new Date("2026-01-01T00:00:00Z"),
    activeCycle: {
      id: "cycle-1",
      sequence: 1,
      status: "open",
      outcome: null,
      candidateSha: "abc123",
      baseSha: "def456",
      workflowEngine: "orchestrator_v2",
    },
    lastCommandReceipt: {
      idempotencyKey: "key-1",
      intent: "start_implementation",
      actorUserId: "user-1",
      decisionActorId: "user-2",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      status: "accepted",
      result: null,
      replayed: false,
    },
    episodeState: {
      episodeNo: 1,
      agentSlug: "carmen",
      status: "open",
      cycleCount: 3,
      cycleBudget: 6,
      checkpointSummary: {
        completedWork: ["step 1 done"],
        nextAction: "write tests",
        openChecklist: ["step 7"],
      },
    },
    repositoryState: {
      phase: "validation",
      candidateSha: "abc123",
      baseSha: "def456",
      repoTouched: true,
      procedureRunId: "proc-1",
      procedureStepId: "validate",
    },
    resolvedReviewerId: "user-3",
    activeReviewLease: null,
    activeProcedure: {
      type: "start_implementation",
      status: "running",
      currentStep: "execute",
    },
    allowedIntents: ["checkpoint", "submit_for_review"],
    operationalError: null,
  };

  assertEqual(projection.workflowEngine, "orchestrator_v2", "projection has workflowEngine");
  assert(projection.workflowEnginePinnedAt !== null, "projection has workflowEnginePinnedAt");
  assert(projection.lastCommandReceipt !== null, "projection has lastCommandReceipt");
  assert(projection.episodeState !== null, "projection has episodeState");
  assert(projection.repositoryState !== null, "projection has repositoryState");
  assertEqual(projection.activeCycle?.workflowEngine, "orchestrator_v2", "cycle has workflowEngine");
  assertEqual(projection.lastCommandReceipt?.idempotencyKey, "key-1", "receipt has idempotencyKey");
  assertEqual(projection.lastCommandReceipt?.replayed, false, "receipt has replayed flag");
  assertEqual(projection.episodeState?.episodeNo, 1, "episode has episodeNo");
  assertEqual(projection.episodeState?.checkpointSummary?.nextAction, "write tests", "episode has checkpoint summary");
  assertEqual(projection.repositoryState?.phase, "validation", "repo state has phase");
  assertEqual(projection.repositoryState?.procedureRunId, "proc-1", "repo state has procedureRunId");
}

// ===========================================================================
// §5 — computeAllowedIntents edge cases
// ===========================================================================

// --- No active cycle in In Progress: fewer intents ---
{
  const snap = baseSnapshot({ status: "In Progress", activeWorkflowCycleId: null });
  const intents = computeAllowedIntents(snap);
  // Without an active cycle, submit_for_review and checkpoint should not appear
  // (they require an active cycle). cancel_task is still available.
  assertNotIncludes(intents, "submit_for_review", "In Progress without cycle excludes submit_for_review");
  assertNotIncludes(intents, "checkpoint", "In Progress without cycle excludes checkpoint");
  assertIncludes(intents, "cancel_task", "cancel_task always available for non-Done");
}

// --- Review without awaiting lease: no review decision intents ---
{
  const snap = baseSnapshot({
    status: "Review",
    activeWorkflowCycleId: "cycle-1",
    activeReviewRun: {
      id: "review-1",
      status: "validated",
      candidateSha: "abc123",
      reviewerId: "user-3",
      baseSha: "def456",
      repoTouched: true,
      validationOutcome: "passed",
    },
  });
  const intents = computeAllowedIntents(snap);
  assertNotIncludes(intents, "accept_review", "Review without awaiting lease excludes accept_review");
  assertNotIncludes(intents, "request_review_changes", "Review without awaiting lease excludes request_review_changes");
}

// --- operator role (same as admin) ---
{
  const snap = baseSnapshot({ status: "In Progress", activeWorkflowCycleId: "cycle-1" });
  const operatorIntents = computeAllowedIntents(snap, "operator");
  const adminIntents = computeAllowedIntents(snap, "admin");
  assertDeepEqual(operatorIntents, adminIntents, "operator and admin see same intents");
}

// --- triage_task and assign_task for reporter ---
{
  const snap = baseSnapshot({ status: "Backlog", approvedOn: null, activeWorkflowCycleId: null });
  const reporterIntents = computeAllowedIntents(snap, "reporter");
  // triage_task and assign_task are in the full set? They are NOT in the computed
  // set for Backlog — they are added by the route, not by computeAllowedIntents.
  // The projection is a hint, not an exhaustive command list. Verify that
  // reporter at least cannot submit_plan (that's assignee-only).
  assertNotIncludes(reporterIntents, "submit_plan", "reporter cannot submit_plan");
}

// ===========================================================================
// §6 — PhaseEInvariantFinding repair values
// ===========================================================================

{
  const input = invariantInput({
    taskEngine: "legacy",
    activeCycle: { id: "c1", workflowEngine: "orchestrator_v2", status: "open" },
  });
  const findings = detectPhaseEInvariants(input);
  for (const f of findings) {
    assertEqual(f.repair, "escalate", `finding ${f.kind} has repair=escalate`);
    assert(f.taskId === "task-1", `finding ${f.kind} has taskId`);
    assert(f.detail.length > 10, `finding ${f.kind} has meaningful detail`);
  }
}

// ===========================================================================
// SUMMARY
// ===========================================================================

console.log(`[orch-phasee-10] ${checks} checks passed`);
process.exit(0);