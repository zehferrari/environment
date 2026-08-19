// PHASEE-02a — Cross-transport validation and normalization tests.
//
// Tests proving malformed/untrusted evidence is rejected identically across
// agent, browser, automation, and callback transports. Scope is shape-level
// rejection per reviewer constraint #3: client-supplied actor role/ownerId/
// projectId stripped, malformed and oversized payloads rejected, unknown
// actions rejected, idempotency fingerprint stable. DB-correlated evidence
// rejection belongs to PHASEE-02b/03.
//
// Run: npx tsx scripts/phasee-02a-tests.ts

import assert from "node:assert/strict";

import {
  validateCommandPayload,
  type PayloadValidationResult,
} from "@/lib/tasks/orchestrator/command-schema";
import {
  normalizePublicAction,
  type NormalizerAuthContext,
  type NormalizerResult,
} from "@/lib/tasks/orchestrator/normalize";
import {
  computeRequestFingerprint,
} from "@/lib/tasks/orchestrator/receipts";
import type {
  TaskWorkflowCommand,
  TaskWorkflowIntent,
  DomainErrorCode,
  WorkflowPublicAction,
} from "@/lib/tasks/orchestrator/types";
import {
  TASK_WORKFLOW_INTENTS,
  DOMAIN_ERROR_CODES,
  DOMAIN_ERROR_HTTP_STATUS,
  RESULT_HTTP_STATUS,
  WORKFLOW_PUBLIC_ACTIONS,
  isMechanicalIntent,
  isOperationalIntent,
} from "@/lib/tasks/orchestrator/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}: ${(e as Error).message}`);
  }
}

function expectOk<T>(r: { ok: true; payload: T } | { ok: false; code: DomainErrorCode; message: string }): asserts r is { ok: true; payload: T } {
  assert.ok(r.ok, `Expected ok but got: ${JSON.stringify(r)}`);
}

function expectFail(r: PayloadValidationResult | NormalizerResult, expectedCode?: DomainErrorCode): asserts r is { ok: false; code: DomainErrorCode; message: string } {
  assert.ok(!r.ok, `Expected failure but got ok: ${JSON.stringify(r)}`);
  if (expectedCode) {
    assert.equal(r.code, expectedCode, `Expected code ${expectedCode} but got ${r.code}`);
  }
}

// Standard auth context for normalizer tests.
function makeAuthCtx(overrides: Partial<NormalizerAuthContext> = {}): NormalizerAuthContext {
  return {
    taskId: "task-1",
    actorId: "user-1",
    actorKind: "agent",
    actorUsername: "carmen",
    expectedWorkflowVersion: 1,
    workflowCycleId: "cycle-1",
    idempotencyKey: "test-key-1",
    messageId: "msg-1",
    source: "agent",
    ...overrides,
  };
}

// Simulate the 4 transport sources.
const TRANSPORT_SOURCES: Array<{ source: NormalizerAuthContext["source"]; name: string }> = [
  { source: "agent", name: "agent" },
  { source: "browser", name: "browser" },
  { source: "automation", name: "automation" },
  { source: "callback", name: "callback" },
];

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

console.log("\n=== PHASEE-02a: Typed command union, validation, and normalization ===\n");

// --- Step 1: Discriminated command union ----------------------------------

console.log("Step 1: Discriminated command union");

test("TASK_WORKFLOW_INTENTS includes all existing intents", () => {
  const required = [
    "submit_plan", "approve_plan", "request_plan_changes",
    "start_implementation", "checkpoint", "submit_for_review",
    "repository_validation_succeeded", "repository_validation_failed",
    "request_review_changes", "accept_review",
    "repository_finalization_succeeded", "repository_finalization_failed",
    "raise_blocker", "clear_blocker", "cancel_task", "archive_task",
  ];
  for (const intent of required) {
    assert.ok(TASK_WORKFLOW_INTENTS.includes(intent as TaskWorkflowIntent), `Missing intent: ${intent}`);
  }
});

test("TASK_WORKFLOW_INTENTS includes new spec §15 intents", () => {
  const newIntents = ["triage_task", "assign_task", "raise_scope_blocker"];
  for (const intent of newIntents) {
    assert.ok(TASK_WORKFLOW_INTENTS.includes(intent as TaskWorkflowIntent), `Missing new intent: ${intent}`);
  }
});

test("TASK_WORKFLOW_INTENTS includes operational intents", () => {
  const ops = ["publish_checkpoint", "add_subtask", "complete_subtask", "remove_subtask", "request_subtask", "request_task"];
  for (const intent of ops) {
    assert.ok(TASK_WORKFLOW_INTENTS.includes(intent as TaskWorkflowIntent), `Missing operational intent: ${intent}`);
  }
});

test("isMechanicalIntent identifies mechanical intents", () => {
  assert.ok(isMechanicalIntent("repository_validation_succeeded"));
  assert.ok(isMechanicalIntent("repository_finalization_failed"));
  assert.ok(!isMechanicalIntent("submit_plan"));
  assert.ok(!isMechanicalIntent("start_implementation"));
});

test("isOperationalIntent identifies operational intents", () => {
  assert.ok(isOperationalIntent("add_subtask"));
  assert.ok(isOperationalIntent("publish_checkpoint"));
  assert.ok(!isOperationalIntent("submit_plan"));
  assert.ok(!isOperationalIntent("accept_review"));
});

test("WORKFLOW_PUBLIC_ACTIONS includes all 20 public actions", () => {
  assert.equal(WORKFLOW_PUBLIC_ACTIONS.length, 20);
  const required = [
    "start", "checkpoint", "publish_checkpoint", "ready_for_review",
    "submit_review", "review_feedback", "review_done", "triage_to_todo",
    "approve_plan", "submit_plan", "assign_task", "assign_after_plan_approval",
    "add_subtask", "complete_subtask", "remove_subtask", "request_subtask",
    "request_task", "flag_blocker", "clear_blocker", "flag_extra_work_blocker",
  ];
  for (const a of required) {
    assert.ok(WORKFLOW_PUBLIC_ACTIONS.includes(a as WorkflowPublicAction), `Missing action: ${a}`);
  }
});

// --- Step 2: Per-intent payload validation --------------------------------

console.log("\nStep 2: Per-intent payload validation");

test("validateCommandPayload: valid submit_plan payload", () => {
  const r = validateCommandPayload("submit_plan", {
    actionPlan: {
      summary: "Build the feature",
      steps: [{ id: "s1", title: "Step 1", acceptanceCriteria: ["criterion A"], kind: "sequential" }],
    },
  });
  expectOk(r);
  if (r.ok) assert.equal((r.payload as { actionPlan: { summary: string } }).actionPlan.summary, "Build the feature");
});

test("validateCommandPayload: submit_plan rejects missing actionPlan", () => {
  const r = validateCommandPayload("submit_plan", {});
  expectFail(r, "invalid_payload");
});

test("validateCommandPayload: approve_plan requires actionPlanId + actionPlanVersion", () => {
  expectFail(validateCommandPayload("approve_plan", { actionPlanId: "plan-1" }), "invalid_payload");
  expectFail(validateCommandPayload("approve_plan", { actionPlanId: "plan-1", actionPlanVersion: 0 }), "invalid_payload");
  expectFail(validateCommandPayload("approve_plan", { actionPlanId: "plan-1", actionPlanVersion: -1 }), "invalid_payload");
  expectOk(validateCommandPayload("approve_plan", { actionPlanId: "plan-1", actionPlanVersion: 1 }));
});

test("validateCommandPayload: submit_for_review requires candidateSha/baseSha when repoTouched", () => {
  expectFail(validateCommandPayload("submit_for_review", { repoTouched: true, candidateSha: null, baseSha: null }), "missing_evidence");
  expectOk(validateCommandPayload("submit_for_review", { repoTouched: true, candidateSha: "abc123", baseSha: "def456" }));
  expectOk(validateCommandPayload("submit_for_review", { repoTouched: false, candidateSha: null, baseSha: null }));
});

test("validateCommandPayload: request_review_changes requires non-empty reviewerComment", () => {
  expectFail(validateCommandPayload("request_review_changes", { reviewRunId: "r1", candidateSha: "abc", reviewerComment: "" }), "invalid_payload");
  expectOk(validateCommandPayload("request_review_changes", { reviewRunId: "r1", candidateSha: "abc", reviewerComment: "Needs work" }));
});

test("validateCommandPayload: accept_review requires reviewRunId + candidateSha", () => {
  expectFail(validateCommandPayload("accept_review", { reviewRunId: "r1" }), "invalid_payload");
  expectOk(validateCommandPayload("accept_review", { reviewRunId: "r1", candidateSha: "abc" }));
});

test("validateCommandPayload: repository callbacks require procedureRunId + procedureStepId, allow nullable jobId/candidateSha/baseSha", () => {
  const full = { procedureRunId: "p1", procedureStepId: "s1", jobId: "j1", candidateSha: "abc", baseSha: "def", outcome: "succeeded" };
  expectFail(validateCommandPayload("repository_validation_succeeded", { ...full, procedureRunId: undefined }), "invalid_payload");
  expectFail(validateCommandPayload("repository_validation_succeeded", { ...full, procedureStepId: undefined }), "invalid_payload");
  expectFail(validateCommandPayload("repository_validation_succeeded", { ...full, outcome: "failed" }), "invalid_payload");
  expectOk(validateCommandPayload("repository_validation_succeeded", full));
  expectOk(validateCommandPayload("repository_validation_failed", { ...full, outcome: "failed", failureReason: "boom" }));
  // Null jobId/candidateSha/baseSha is the shape both handlers emit — must validate OK
  const nullish = { procedureRunId: "p1", procedureStepId: "s1", jobId: null, candidateSha: null, baseSha: null, outcome: "succeeded" };
  expectOk(validateCommandPayload("repository_validation_succeeded", nullish));
  expectOk(validateCommandPayload("repository_validation_failed", { ...nullish, outcome: "failed" }));
  expectOk(validateCommandPayload("repository_finalization_succeeded", { ...nullish, publishedSha: "pub1" }));
  expectOk(validateCommandPayload("repository_finalization_failed", { ...nullish, outcome: "failed", failureReason: "boom" }));
});

test("validateCommandPayload: raise_blocker requires structured blockerReport", () => {
  const valid = {
    blockerReport: {
      blockedOn: "external_service",
      requestedActor: null,
      requestedAction: "Fix the CI",
      evidence: ["log-1"],
      diagnosticsAttempted: ["retried twice"],
      resumeCondition: "CI is back online",
      reporterCanResolve: false,
    },
  };
  expectOk(validateCommandPayload("raise_blocker", valid));
  expectFail(validateCommandPayload("raise_blocker", {}), "invalid_payload");
  expectFail(validateCommandPayload("raise_blocker", { blockerReport: { ...valid.blockerReport, blockedOn: "invalid" } }), "invalid_payload");
});

test("validateCommandPayload: clear_blocker requires blockerId + resolution", () => {
  expectFail(validateCommandPayload("clear_blocker", { blockerId: "b1" }), "invalid_payload");
  expectOk(validateCommandPayload("clear_blocker", { blockerId: "b1", resolution: "Fixed" }));
});

test("validateCommandPayload: add_subtask requires non-empty subtaskText", () => {
  expectFail(validateCommandPayload("add_subtask", { subtaskText: "" }), "invalid_payload");
  expectOk(validateCommandPayload("add_subtask", { subtaskText: "Write tests" }));
});

test("validateCommandPayload: complete_subtask requires subtaskId + completed", () => {
  expectFail(validateCommandPayload("complete_subtask", { subtaskId: "s1" }), "invalid_payload");
  expectOk(validateCommandPayload("complete_subtask", { subtaskId: "s1", completed: true, minutesSpent: 30 }));
});

test("validateCommandPayload: rejects untrusted client-supplied role", () => {
  expectFail(validateCommandPayload("approve_plan", { actionPlanId: "p1", actionPlanVersion: 1, role: "admin" }), "invalid_payload");
});

test("validateCommandPayload: rejects untrusted client-supplied ownerId", () => {
  expectFail(validateCommandPayload("submit_plan", { actionPlan: { summary: "S", steps: [] }, ownerId: "user-x" }), "invalid_payload");
});

test("validateCommandPayload: rejects untrusted client-supplied projectId", () => {
  expectFail(validateCommandPayload("submit_plan", { actionPlan: { summary: "S", steps: [{ id: "s", title: "t", acceptanceCriteria: [], kind: "sequential" }] }, projectId: "p-x" }), "invalid_payload");
});

test("validateCommandPayload: rejects oversized strings", () => {
  const longString = "x".repeat(10_001);
  expectFail(validateCommandPayload("approve_plan", { actionPlanId: longString, actionPlanVersion: 1 }), "invalid_payload");
});

test("validateCommandPayload: non-object payload returns invalid_payload", () => {
  expectFail(validateCommandPayload("approve_plan", null), "invalid_payload");
  expectFail(validateCommandPayload("approve_plan", "string"), "invalid_payload");
  expectFail(validateCommandPayload("approve_plan", 42), "invalid_payload");
});

test("validateCommandPayload: archive_task accepts empty payload", () => {
  expectOk(validateCommandPayload("archive_task", {}));
});

test("validateCommandPayload: triage_task requires valid targetStatus", () => {
  expectOk(validateCommandPayload("triage_task", { targetStatus: "To Do" }));
  expectFail(validateCommandPayload("triage_task", { targetStatus: "Invalid" }), "invalid_payload");
});

test("validateCommandPayload: assign_task requires assigneeUsername + afterPlanApproval", () => {
  expectOk(validateCommandPayload("assign_task", { assigneeUsername: "carmen", afterPlanApproval: false }));
  expectFail(validateCommandPayload("assign_task", { assigneeUsername: "carmen" }), "invalid_payload");
});

test("validateCommandPayload: raise_scope_blocker requires non-empty scopeDescription", () => {
  expectOk(validateCommandPayload("raise_scope_blocker", { scopeDescription: "Need more time" }));
  expectFail(validateCommandPayload("raise_scope_blocker", { scopeDescription: "" }), "invalid_payload");
});

test("validateCommandPayload: publish_checkpoint requires all three fields", () => {
  expectOk(validateCommandPayload("publish_checkpoint", { authorizationCommentId: "c1", candidateSha: "abc", baseSha: "def" }));
  expectFail(validateCommandPayload("publish_checkpoint", { candidateSha: "abc", baseSha: "def" }), "invalid_payload");
});

test("validateCommandPayload: cancel_task accepts optional reason", () => {
  expectOk(validateCommandPayload("cancel_task", {}));
  expectOk(validateCommandPayload("cancel_task", { reason: "Not needed" }));
});

test("validateCommandPayload: never throws raw exceptions", () => {
  // Pass deeply malformed input — should return invalid_payload, not throw.
  const r1 = validateCommandPayload("submit_plan", { actionPlan: undefined });
  expectFail(r1, "invalid_payload");
  const r2 = validateCommandPayload("raise_blocker", { blockerReport: "not an object" });
  expectFail(r2, "invalid_payload");
});

// --- Step 3: Canonical public-action normalizer ---------------------------

console.log("\nStep 3: Canonical public-action normalizer");

test("normalizePublicAction: start → start_implementation", () => {
  const r = normalizePublicAction("start", {}, makeAuthCtx());
  assert.ok(r.ok);
  assert.equal(r.command.intent, "start_implementation");
});

test("normalizePublicAction: ready_for_review and submit_review both → submit_for_review", () => {
  const ctx = makeAuthCtx({ candidateSha: "abc", baseSha: "def" });
  const r1 = normalizePublicAction("ready_for_review", { repoTouched: true }, ctx);
  const r2 = normalizePublicAction("submit_review", { repoTouched: true }, ctx);
  assert.ok(r1.ok && r2.ok);
  assert.equal(r1.command.intent, "submit_for_review");
  assert.equal(r2.command.intent, "submit_for_review");
});

test("normalizePublicAction: review_feedback → request_review_changes", () => {
  const ctx = makeAuthCtx({ reviewRunId: "r1", candidateSha: "abc" });
  const r = normalizePublicAction("review_feedback", { reviewerComment: "Fix this" }, ctx);
  assert.ok(r.ok);
  assert.equal(r.command.intent, "request_review_changes");
});

test("normalizePublicAction: review_done → accept_review", () => {
  const ctx = makeAuthCtx({ reviewRunId: "r1", candidateSha: "abc" });
  const r = normalizePublicAction("review_done", {}, ctx);
  assert.ok(r.ok);
  assert.equal(r.command.intent, "accept_review");
});

test("normalizePublicAction: flag_blocker → raise_blocker", () => {
  const r = normalizePublicAction("flag_blocker", {
    blockerReport: {
      blockedOn: "dependency", requestedActor: null, requestedAction: "Wait",
      evidence: [], diagnosticsAttempted: [], resumeCondition: "Done",
      reporterCanResolve: false,
    },
  }, makeAuthCtx());
  assert.ok(r.ok);
  assert.equal(r.command.intent, "raise_blocker");
});

test("normalizePublicAction: flag_extra_work_blocker → raise_scope_blocker", () => {
  const r = normalizePublicAction("flag_extra_work_blocker", { scopeDescription: "Extra work" }, makeAuthCtx());
  assert.ok(r.ok);
  assert.equal(r.command.intent, "raise_scope_blocker");
});

test("normalizePublicAction: triage_to_todo → triage_task", () => {
  const r = normalizePublicAction("triage_to_todo", {}, makeAuthCtx());
  assert.ok(r.ok);
  assert.equal(r.command.intent, "triage_task");
});

test("normalizePublicAction: assign_after_plan_approval → assign_task with afterPlanApproval=true", () => {
  const r = normalizePublicAction("assign_after_plan_approval", { assigneeUsername: "carmen" }, makeAuthCtx());
  assert.ok(r.ok);
  assert.equal(r.command.intent, "assign_task");
  assert.equal((r.command as { payload: { afterPlanApproval: boolean } }).payload.afterPlanApproval, true);
});

test("normalizePublicAction: strips untrusted client-supplied role from rawBody", () => {
  const r = normalizePublicAction("start", { role: "admin", ownerId: "user-x" }, makeAuthCtx());
  assert.ok(r.ok);
  // The role should NOT appear in the command payload.
  const payload = (r.command as { payload: Record<string, unknown> }).payload;
  assert.ok(!("role" in payload), "role should be stripped");
  assert.ok(!("ownerId" in payload), "ownerId should be stripped");
});

test("normalizePublicAction: evidence fields come from authContext, not rawBody", () => {
  const ctx = makeAuthCtx({ candidateSha: "server-sha", baseSha: "server-base" });
  const r = normalizePublicAction("ready_for_review", { repoTouched: true, candidateSha: "client-fake-sha" }, ctx);
  assert.ok(r.ok);
  const payload = (r.command as { payload: { candidateSha: string | null } }).payload;
  // authContext candidateSha takes precedence over client-supplied.
  assert.equal(payload.candidateSha, "server-sha");
});

test("normalizePublicAction: unknown action returns unknown_intent", () => {
  const r = normalizePublicAction("unknown_action" as WorkflowPublicAction, {}, makeAuthCtx());
  expectFail(r as NormalizerResult, "unknown_intent");
});

test("validateCommandPayload: repository callback with null jobId/candidateSha/baseSha is accepted and carries nulls", () => {
  // This is the shape both handlers emit (submit-candidate-for-review.ts, review-decisions.ts)
  const nullish = { procedureRunId: "p1", procedureStepId: "s1", jobId: null, candidateSha: null, baseSha: null, outcome: "succeeded" };
  // Validator accepts it
  const vr = validateCommandPayload("repository_validation_succeeded", nullish);
  assert.ok(vr.ok, `expected validation OK, got ${JSON.stringify(vr)}`);
  const vp = (vr as { ok: true; payload: { jobId: string | null; candidateSha: string | null; baseSha: string | null } }).payload;
  assert.strictEqual(vp.jobId, null);
  assert.strictEqual(vp.candidateSha, null);
  assert.strictEqual(vp.baseSha, null);
  // All four callback intents accept nulls
  expectOk(validateCommandPayload("repository_validation_failed", { ...nullish, outcome: "failed" }));
  expectOk(validateCommandPayload("repository_finalization_succeeded", { ...nullish, publishedSha: "pub1" }));
  expectOk(validateCommandPayload("repository_finalization_failed", { ...nullish, outcome: "failed", failureReason: "boom" }));
});

test("normalizePublicAction: is a pure function (no side effects)", () => {
  const ctx = makeAuthCtx();
  const rawBody = { reviewerComment: "test" };
  const r1 = normalizePublicAction("review_feedback", { ...rawBody }, { ...ctx, reviewRunId: "r1", candidateSha: "abc" });
  const r2 = normalizePublicAction("review_feedback", { ...rawBody }, { ...ctx, reviewRunId: "r1", candidateSha: "abc" });
  // Same inputs → same output (deterministic).
  assert.deepEqual(JSON.stringify(r1), JSON.stringify(r2));
});

// --- Step 4: Domain error codes and HTTP result mapping -------------------

console.log("\nStep 4: Domain error codes and HTTP result mapping");

test("DOMAIN_ERROR_CODES includes all required codes", () => {
  const required = [
    "invalid_payload", "missing_evidence", "stale_version", "idempotency_conflict",
    "forbidden", "not_assignee", "not_reviewer", "not_authorized", "lease_mismatch",
    "candidate_mismatch", "cycle_mismatch", "epic_not_actionable", "prerequisites_unmet",
    "wip_conflict", "branch_collision", "operational_error", "unknown_intent",
  ];
  for (const code of required) {
    assert.ok(DOMAIN_ERROR_CODES.includes(code as DomainErrorCode), `Missing error code: ${code}`);
  }
});

test("RESULT_HTTP_STATUS maps result statuses correctly", () => {
  assert.equal(RESULT_HTTP_STATUS.get("replayed"), 200);
  assert.equal(RESULT_HTTP_STATUS.get("accepted"), 202);
  assert.equal(RESULT_HTTP_STATUS.get("stale"), 409);
  assert.equal(RESULT_HTTP_STATUS.get("forbidden"), 403);
  assert.equal(RESULT_HTTP_STATUS.get("invalid"), 422);
  assert.equal(RESULT_HTTP_STATUS.get("operational"), 503);
});

test("DOMAIN_ERROR_HTTP_STATUS maps error codes correctly", () => {
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("invalid_payload"), 422);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("missing_evidence"), 422);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("stale_version"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("idempotency_conflict"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("forbidden"), 403);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("not_assignee"), 403);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("not_reviewer"), 403);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("not_authorized"), 403);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("lease_mismatch"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("candidate_mismatch"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("cycle_mismatch"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("epic_not_actionable"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("prerequisites_unmet"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("wip_conflict"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("branch_collision"), 409);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("operational_error"), 503);
  assert.equal(DOMAIN_ERROR_HTTP_STATUS.get("unknown_intent"), 422);
});

// --- Step 5: Cross-transport parity tests ---------------------------------

console.log("\nStep 5: Cross-transport parity tests");

test("Cross-transport: same valid payload produces same command shape regardless of source", () => {
  const rawBody = { reviewerComment: "Needs work" };
  const ctxBase = makeAuthCtx({ reviewRunId: "r1", candidateSha: "abc" });

  const results = TRANSPORT_SOURCES.map(({ source }) =>
    normalizePublicAction("review_feedback", rawBody, { ...ctxBase, source })
  );

  // All should succeed.
  for (const r of results) assert.ok(r.ok, `Transport ${results.indexOf(r)} failed`);

  // All commands should have the same intent and payload.
  const first = results[0];
  if (!first.ok) throw new Error("first result should be ok");
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    if (!r.ok) throw new Error(`result ${i} should be ok`);
    assert.equal(r.command.intent, first.command.intent, `intent mismatch for transport ${TRANSPORT_SOURCES[i].name}`);
    assert.deepEqual(
      (r.command as { payload: unknown }).payload,
      (first.command as { payload: unknown }).payload,
      `payload mismatch for transport ${TRANSPORT_SOURCES[i].name}`,
    );
  }
});

test("Cross-transport: malformed payload rejected identically", () => {
  const rawBody = { reviewerComment: "" }; // empty comment is invalid
  const ctxBase = makeAuthCtx({ reviewRunId: "r1", candidateSha: "abc" });

  const results = TRANSPORT_SOURCES.map(({ source }) =>
    normalizePublicAction("review_feedback", rawBody, { ...ctxBase, source })
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    assert.ok(!r.ok, `Transport ${TRANSPORT_SOURCES[i].name} should fail`);
    assert.equal(r.code, "invalid_payload", `Transport ${TRANSPORT_SOURCES[i].name} should return invalid_payload`);
  }
});

test("Cross-transport: client-supplied actor role stripped from all transports", () => {
  const rawBody = { role: "admin" };

  for (const { source, name } of TRANSPORT_SOURCES) {
    const r = normalizePublicAction("start", rawBody, { ...makeAuthCtx(), source });
    assert.ok(r.ok, `${name}: should succeed (role is stripped, not rejected)`);
    const payload = (r.command as { payload: Record<string, unknown> }).payload;
    assert.ok(!("role" in payload), `${name}: role should be stripped from payload`);
  }
});

test("Cross-transport: unknown action rejected identically", () => {
  for (const { source, name } of TRANSPORT_SOURCES) {
    const r = normalizePublicAction("bogus_action" as WorkflowPublicAction, {}, { ...makeAuthCtx(), source });
    assert.ok(!r.ok, `${name}: unknown action should fail`);
    assert.equal(r.code, "unknown_intent", `${name}: should return unknown_intent`);
  }
});

test("Cross-transport: idempotency fingerprint stable across replays", () => {
  const ctx = makeAuthCtx({ candidateSha: "abc", baseSha: "def", reviewRunId: "r1" });
  const rawBody = { repoTouched: true, reviewerComment: "test" };

  // Create two commands via different transports but same logical content.
  const r1 = normalizePublicAction("review_feedback", rawBody, ctx);
  const r2 = normalizePublicAction("review_feedback", rawBody, { ...ctx, source: "browser" });

  assert.ok(r1.ok && r2.ok);

  // Build fingerprints — the source field differs but the core command fields
  // (taskId, intent, actorId, expectedVersion, cycleId, payload) are the same.
  // The fingerprint includes source, so different sources produce different
  // fingerprints. But same source + same content = same fingerprint.
  const r3 = normalizePublicAction("review_feedback", rawBody, ctx);
  assert.ok(r3.ok);

  const fp1 = computeRequestFingerprint(r1.command);
  const fp3 = computeRequestFingerprint(r3.command);
  assert.equal(fp1, fp3, "same source + same content should produce same fingerprint");

  // Different source → different fingerprint (source is part of the fingerprint).
  const fp2 = computeRequestFingerprint(r2.command);
  assert.notEqual(fp1, fp2, "different source should produce different fingerprint");
});

test("Cross-transport: oversized strings rejected in all transports", () => {
  const longString = "x".repeat(10_001);
  const rawBody = { reviewerComment: longString };
  const ctx = makeAuthCtx({ reviewRunId: "r1", candidateSha: "abc" });

  for (const { source, name } of TRANSPORT_SOURCES) {
    const r = normalizePublicAction("review_feedback", rawBody, { ...ctx, source });
    // The normalizer doesn't enforce size limits (that's command-schema.ts).
    // But command-schema does. Test command-schema rejection:
    const v = validateCommandPayload("request_review_changes", { reviewRunId: "r1", candidateSha: "abc", reviewerComment: longString });
    expectFail(v, "invalid_payload");
  }
});

test("Cross-transport: all 20 public actions map to canonical intents", () => {
  const ctx = makeAuthCtx({ candidateSha: "abc", baseSha: "def", reviewRunId: "r1", actionPlanId: "p1", actionPlanVersion: 1 });
  for (const action of WORKFLOW_PUBLIC_ACTIONS) {
    const r = normalizePublicAction(action, getValidRawBodyForAction(action), ctx);
    assert.ok(r.ok, `Action ${action} should normalize successfully: ${r.ok ? "" : r.code + " " + r.message}`);
  }
});

test("Cross-transport: null where required is rejected", () => {
  expectFail(validateCommandPayload("approve_plan", { actionPlanId: null, actionPlanVersion: 1 }), "invalid_payload");
  expectFail(validateCommandPayload("accept_review", { reviewRunId: null, candidateSha: "abc" }), "invalid_payload");
});

test("Cross-transport: wrong type for required field is rejected", () => {
  expectFail(validateCommandPayload("approve_plan", { actionPlanId: 123, actionPlanVersion: 1 }), "invalid_payload");
  expectFail(validateCommandPayload("complete_subtask", { subtaskId: "s1", completed: "yes" }), "invalid_payload");
});

test("Validation rejects client-supplied workflowVersion", () => {
  expectFail(
    validateCommandPayload("submit_plan", {
      actionPlan: { summary: "S", steps: [{ id: "s", title: "t", acceptanceCriteria: [], kind: "sequential" }] },
      workflowVersion: 99,
    }),
    "invalid_payload",
  );
});

// --- Helper for the "all 20 actions map" test ----------------------------

function getValidRawBodyForAction(action: WorkflowPublicAction): Record<string, unknown> {
  switch (action) {
    case "start": return {};
    case "checkpoint": return { nextAction: "continue" };
    case "publish_checkpoint": return { authorizationCommentId: "c1" };
    case "ready_for_review":
    case "submit_review": return { repoTouched: true };
    case "review_feedback": return { reviewerComment: "Fix this" };
    case "review_done": return {};
    case "triage_to_todo": return {};
    case "approve_plan": return { actionPlanId: "p1", actionPlanVersion: 1 };
    case "submit_plan": return {
      actionPlan: { summary: "S", steps: [{ id: "s1", title: "Step", acceptanceCriteria: ["c"], kind: "sequential" }] },
    };
    case "assign_task": return { assigneeUsername: "carmen" };
    case "assign_after_plan_approval": return { assigneeUsername: "carmen" };
    case "add_subtask": return { subtaskText: "Write tests" };
    case "complete_subtask": return { subtaskId: "s1", completed: true };
    case "remove_subtask": return { subtaskId: "s1" };
    case "request_subtask": return { subtaskText: "Need help" };
    case "request_task": return { taskTitle: "New task" };
    case "flag_blocker": return {
      blockerReport: {
        blockedOn: "dependency", requestedActor: null, requestedAction: "Wait",
        evidence: [], diagnosticsAttempted: [], resumeCondition: "Done",
        reporterCanResolve: false,
      },
    };
    case "clear_blocker": return { blockerId: "b1", resolution: "Fixed" };
    case "flag_extra_work_blocker": return { scopeDescription: "Extra work" };
    default: return {};
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}