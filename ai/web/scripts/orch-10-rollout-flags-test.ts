// ORCH-10 — Shadow/canary rollout flags + cleanup tests.
//
// Verifies:
//   - Shadow mode computes V2 decisions without running effects.
//   - Project allowlist gates canary comparison activities.
//   - "*" enables the compute-only comparison probe for all projects.
//   - Empty allowlist means legacy paths remain authoritative.

import assert from "node:assert/strict";

async function main() {
  const { orchestratorShadowEnabled, orchestratorV2Projects, isV2EnabledForProject, shouldRecordV2CanaryComparison, shouldComputeV2Decision } = await import("@/lib/tasks/orchestrator/flags");

  // --- Test 1: default — no flags set, legacy paths authoritative ------
  delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
  delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
  assert.equal(orchestratorShadowEnabled(), false, "shadow disabled by default");
  assert.equal(orchestratorV2Projects().size, 0, "no V2 projects by default");
  assert.equal(isV2EnabledForProject("any-project"), false, "V2 not enabled for any project by default");
  assert.equal(shouldRecordV2CanaryComparison("any-project"), false, "canary comparison is not recorded by default");
  assert.equal(shouldComputeV2Decision("any-project"), false, "V2 decisions not computed by default");
  console.log("[orch10] default: legacy paths authoritative PASS");

  // --- Test 2: shadow mode — compute decisions, no effects ------------
  process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
  assert.equal(orchestratorShadowEnabled(), true, "shadow enabled");
  assert.equal(shouldRecordV2CanaryComparison("any-project"), false, "shadow mode records shadow, not canary, activity");
  assert.equal(shouldComputeV2Decision("any-project"), true, "shadow mode computes V2 decisions");
  delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
  console.log("[orch10] shadow mode PASS");

  // --- Test 3: canary mode — project allowlist ------------------------
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "test-project,canary-project";
  assert.equal(isV2EnabledForProject("test-project"), true, "canary project enabled");
  assert.equal(isV2EnabledForProject("canary-project"), true, "second canary project enabled");
  assert.equal(isV2EnabledForProject("other-project"), false, "non-canary project not enabled");
  assert.equal(shouldRecordV2CanaryComparison("test-project"), true, "canary comparison is recorded for allowlisted project");
  assert.equal(shouldRecordV2CanaryComparison("other-project"), false, "canary comparison is not recorded outside allowlist");
  assert.equal(shouldComputeV2Decision("test-project"), true, "V2 decisions computed for canary");
  delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
  console.log("[orch10] canary mode PASS");

  // --- Test 4: wildcard — comparison probe for all projects -----------
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "*";
  assert.equal(isV2EnabledForProject("any-project"), true, "wildcard enables all projects");
  assert.equal(isV2EnabledForProject("another-project"), true, "wildcard enables all projects");
  assert.equal(shouldRecordV2CanaryComparison("any-project"), true, "canary comparison is recorded for all projects with wildcard");
  delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
  console.log("[orch10] wildcard comparison probe PASS");

  // --- Test 5: shadow + canary — shadow takes precedence (no effects) -
  process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "test-project";
  assert.equal(shouldRecordV2CanaryComparison("test-project"), false, "shadow activity takes precedence over canary activity");
  assert.equal(shouldComputeV2Decision("test-project"), true, "V2 decisions still computed");
  delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
  delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
  console.log("[orch10] shadow + canary precedence PASS");

  console.log("[orch10] PASS — all rollout flag assertions held");
}

main().catch((error) => {
  console.error("[orch10] FAIL:", error);
  process.exit(1);
});
