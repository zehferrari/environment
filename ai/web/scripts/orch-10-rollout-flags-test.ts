// ORCH-10 — Shadow/canary rollout flags + cleanup tests.
//
// Verifies:
//   - Shadow mode computes V2 decisions without running effects.
//   - Project allowlist gates V2 effects.
//   - "*" enables V2 for all projects (phase E).
//   - Empty allowlist means legacy paths remain authoritative.

import assert from "node:assert/strict";

async function main() {
  const { orchestratorShadowEnabled, orchestratorV2Projects, isV2EnabledForProject, shouldRunV2Effects, shouldComputeV2Decision } = await import("@/lib/tasks/orchestrator/flags");

  // --- Test 1: default — no flags set, legacy paths authoritative ------
  delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
  delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
  assert.equal(orchestratorShadowEnabled(), false, "shadow disabled by default");
  assert.equal(orchestratorV2Projects().size, 0, "no V2 projects by default");
  assert.equal(isV2EnabledForProject("any-project"), false, "V2 not enabled for any project by default");
  assert.equal(shouldRunV2Effects("any-project"), false, "V2 effects not run by default");
  assert.equal(shouldComputeV2Decision("any-project"), false, "V2 decisions not computed by default");
  console.log("[orch10] default: legacy paths authoritative PASS");

  // --- Test 2: shadow mode — compute decisions, no effects ------------
  process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
  assert.equal(orchestratorShadowEnabled(), true, "shadow enabled");
  assert.equal(shouldRunV2Effects("any-project"), false, "shadow mode does not run V2 effects");
  assert.equal(shouldComputeV2Decision("any-project"), true, "shadow mode computes V2 decisions");
  delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
  console.log("[orch10] shadow mode PASS");

  // --- Test 3: canary mode — project allowlist ------------------------
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "test-project,canary-project";
  assert.equal(isV2EnabledForProject("test-project"), true, "canary project enabled");
  assert.equal(isV2EnabledForProject("canary-project"), true, "second canary project enabled");
  assert.equal(isV2EnabledForProject("other-project"), false, "non-canary project not enabled");
  assert.equal(shouldRunV2Effects("test-project"), true, "V2 effects run for canary project");
  assert.equal(shouldRunV2Effects("other-project"), false, "V2 effects do not run for non-canary");
  assert.equal(shouldComputeV2Decision("test-project"), true, "V2 decisions computed for canary");
  delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
  console.log("[orch10] canary mode PASS");

  // --- Test 4: wildcard — all projects (phase E) ----------------------
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "*";
  assert.equal(isV2EnabledForProject("any-project"), true, "wildcard enables all projects");
  assert.equal(isV2EnabledForProject("another-project"), true, "wildcard enables all projects");
  assert.equal(shouldRunV2Effects("any-project"), true, "V2 effects run for all projects with wildcard");
  delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
  console.log("[orch10] wildcard (phase E) PASS");

  // --- Test 5: shadow + canary — shadow takes precedence (no effects) -
  process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "test-project";
  assert.equal(shouldRunV2Effects("test-project"), false, "shadow takes precedence over canary");
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