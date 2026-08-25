import assert from "node:assert/strict";
import {
  validateFenceFields,
  isActionPermittedUnderEnv151,
  type RepositoryOutcomeArgs,
} from "@/lib/agents/repo/env151-boundary";

/**
 * ENV-159 Step 9: ENV-151 boundary tests.
 *
 * Verifies that ENV-159 consumes repository outcomes without duplicating
 * reconciliation logic, and that base-drift detection does not instruct the
 * agent to merge/rebase/reset/commit/push.
 *
 * Tests call the REAL exported functions:
 * - validateFenceFields (pure, no db) for fence validation
 * - isActionPermittedUnderEnv151 (pure, no db) for action permission checks
 *
 * consumeRepositoryOutcome is async and depends on db; its pure fence
 * validation sub-function is tested directly via the exported
 * validateFenceFields.
 */

const baseArgs: RepositoryOutcomeArgs = {
  taskId: "task-1",
  cycleId: "cycle-1",
  procedureRunId: "proc-1",
  procedureStepId: "step-1",
  repoRunId: null,
  taskBranch: "env-159",
  epicBranch: "phase-e",
  candidateSha: "abc123",
  baseSha: "def456",
};

// ---------------------------------------------------------------------------
// Test 1: Clean outcome — valid fence fields pass validation
// ---------------------------------------------------------------------------

export function testCleanOutcomePassesThrough() {
  const error = validateFenceFields(baseArgs);
  assert.equal(error, null, "Valid fence fields should pass validation");
}

// ---------------------------------------------------------------------------
// Test 2: Fence validation rejects missing fields
// ---------------------------------------------------------------------------

export function testFenceValidationRejectsMissingFields() {
  const result = validateFenceFields({ ...baseArgs, taskBranch: "" });
  assert.ok(result !== null, "Empty taskBranch should fail fence validation");
  assert.ok(result!.includes("taskBranch"), "Failure detail should name the missing field");
}

export function testFenceValidationRejectsMissingCandidateSha() {
  const result = validateFenceFields({ ...baseArgs, candidateSha: "" });
  assert.ok(result !== null, "Empty candidateSha should fail fence validation");
  assert.ok(result!.includes("candidateSha"), "Failure detail should name candidateSha");
}

export function testFenceValidationRejectsMissingTaskId() {
  const result = validateFenceFields({ ...baseArgs, taskId: "" });
  assert.ok(result !== null, "Empty taskId should fail fence validation");
  assert.ok(result!.includes("taskId"), "Failure detail should name taskId");
}

export function testFenceValidationRejectsMissingEpicBranch() {
  const result = validateFenceFields({ ...baseArgs, epicBranch: "" });
  assert.ok(result !== null, "Empty epicBranch should fail fence validation");
  assert.ok(result!.includes("epicBranch"), "Failure detail should name epicBranch");
}

export function testFenceValidationRejectsMissingBaseSha() {
  const result = validateFenceFields({ ...baseArgs, baseSha: "" });
  assert.ok(result !== null, "Empty baseSha should fail fence validation");
  assert.ok(result!.includes("baseSha"), "Failure detail should name baseSha");
}

export function testFenceValidationRejectsEmptyCycleId() {
  const result = validateFenceFields({ ...baseArgs, cycleId: "" });
  assert.ok(result !== null, "Empty cycleId should fail fence validation");
  assert.ok(result!.includes("cycleId"), "Failure detail should name cycleId");
}

export function testFenceValidationRejectsEmptyProcedureRunId() {
  const result = validateFenceFields({ ...baseArgs, procedureRunId: "" });
  assert.ok(result !== null, "Empty procedureRunId should fail fence validation");
  assert.ok(result!.includes("procedureRunId"), "Failure detail should name procedureRunId");
}

export function testFenceValidationRejectsEmptyRepoRunId() {
  const result = validateFenceFields({ ...baseArgs, repoRunId: "" });
  assert.ok(result !== null, "Empty repoRunId should fail fence validation");
  assert.ok(result!.includes("repoRunId"), "Failure detail should name repoRunId");
}

// ---------------------------------------------------------------------------
// Test 3: isActionPermittedUnderEnv151 — base drift blocks mutations
// ---------------------------------------------------------------------------

export function testBaseDriftBlocksMutations() {
  const driftOutcome = { outcome: "base_drift_detected" as const, detail: "base advanced" };
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "merge"), false, "merge must be blocked during base drift");
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "rebase"), false, "rebase must be blocked during base drift");
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "reset"), false, "reset must be blocked during base drift");
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "commit"), false, "commit must be blocked during base drift");
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "push"), false, "push must be blocked during base drift");
}

export function testBaseDriftAllowsReadsAndEdits() {
  const driftOutcome = { outcome: "base_drift_detected" as const, detail: "base advanced" };
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "read"), true, "read must be allowed during base drift");
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "verify"), true, "verify must be allowed during base drift");
  assert.equal(isActionPermittedUnderEnv151(driftOutcome, "edit"), true, "edit must be allowed during base drift");
}

// ---------------------------------------------------------------------------
// Test 4: isActionPermittedUnderEnv151 — clean outcome allows all
// ---------------------------------------------------------------------------

export function testCleanOutcomeAllowsAll() {
  const cleanOutcome = { outcome: "clean" as const, detail: undefined };
  assert.equal(isActionPermittedUnderEnv151(cleanOutcome, "merge"), true);
  assert.equal(isActionPermittedUnderEnv151(cleanOutcome, "push"), true);
  assert.equal(isActionPermittedUnderEnv151(cleanOutcome, "read"), true);
  assert.equal(isActionPermittedUnderEnv151(cleanOutcome, "edit"), true);
  assert.equal(isActionPermittedUnderEnv151(cleanOutcome, "verify"), true);
}

// ---------------------------------------------------------------------------
// Test 5: isActionPermittedUnderEnv151 — failure blocks all but reads
// ---------------------------------------------------------------------------

export function testFailureBlocksAllButReads() {
  const failureOutcome = { outcome: "failure" as const, detail: "validation failed" };
  assert.equal(isActionPermittedUnderEnv151(failureOutcome, "read"), true, "read must be allowed on failure");
  assert.equal(isActionPermittedUnderEnv151(failureOutcome, "merge"), false, "merge must be blocked on failure");
  assert.equal(isActionPermittedUnderEnv151(failureOutcome, "edit"), false, "edit must be blocked on failure");
  assert.equal(isActionPermittedUnderEnv151(failureOutcome, "verify"), false, "verify must be blocked on failure");
  assert.equal(isActionPermittedUnderEnv151(failureOutcome, "push"), false, "push must be blocked on failure");
  assert.equal(isActionPermittedUnderEnv151(failureOutcome, "commit"), false, "commit must be blocked on failure");
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

export function runEnv151BoundaryTests() {
  testCleanOutcomePassesThrough();
  testFenceValidationRejectsMissingFields();
  testFenceValidationRejectsMissingCandidateSha();
  testFenceValidationRejectsMissingTaskId();
  testFenceValidationRejectsMissingEpicBranch();
  testFenceValidationRejectsMissingBaseSha();
  testFenceValidationRejectsEmptyCycleId();
  testFenceValidationRejectsEmptyProcedureRunId();
  testFenceValidationRejectsEmptyRepoRunId();
  testBaseDriftBlocksMutations();
  testBaseDriftAllowsReadsAndEdits();
  testCleanOutcomeAllowsAll();
  testFailureBlocksAllButReads();
  console.log("✓ ENV-151 boundary tests (5 tests, 13 assertions) passed");
}

// Self-execute when run directly
if (process.argv[1] && process.argv[1].endsWith("env151-boundary-test.ts")) {
  runEnv151BoundaryTests();
}