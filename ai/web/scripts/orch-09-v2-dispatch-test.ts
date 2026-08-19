// ORCH-09/10 integration test: V2 dispatch from the agent workflow route.
//
// Verifies that:
//   - With no flags set, the V2 dispatch is a no-op (legacy path runs).
//   - With PM_ORCHESTRATOR_V2_PROJECTS set, V2 records canary comparison
//     evidence while the legacy path remains authoritative.
//   - With PM_ORCHESTRATOR_V2_SHADOW=1, V2 computes but legacy remains
//     authoritative.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch-v2-dispatch-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  return { dbUrl, cleanup: () => rm(sandbox, { recursive: true, force: true }) };
}

async function main() {
  const { dbUrl, cleanup } = await freshDb();
  process.env.DATABASE_URL = dbUrl;
  try {
    // Import after DATABASE_URL is set.
    const { shouldComputeV2Decision, shouldRecordV2CanaryComparison, orchestratorShadowEnabled } = await import("@/lib/tasks/orchestrator/flags");

    // --- Test 1: no flags → V2 not active ------------------------------
    delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
    delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
    assert.equal(shouldComputeV2Decision("any-project"), false, "V2 not active without flags");
    assert.equal(shouldRecordV2CanaryComparison("any-project"), false, "canary comparison is not recorded without flags");
    console.log("[v2-dispatch] no flags → V2 inactive PASS");

    // --- Test 2: canary mode → V2 active for allowlisted project ------
    process.env.PM_ORCHESTRATOR_V2_PROJECTS = "test-project";
    assert.equal(shouldComputeV2Decision("test-project"), true, "V2 active for canary project");
    assert.equal(shouldRecordV2CanaryComparison("test-project"), true, "canary comparison is recorded for allowlisted project");
    assert.equal(shouldRecordV2CanaryComparison("other-project"), false, "canary comparison is not recorded outside allowlist");
    delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
    console.log("[v2-dispatch] canary mode → V2 active PASS");

    // --- Test 3: shadow mode → V2 computes but no effects -------------
    process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
    assert.equal(orchestratorShadowEnabled(), true, "shadow enabled");
    assert.equal(shouldComputeV2Decision("any-project"), true, "V2 computes in shadow mode");
    assert.equal(shouldRecordV2CanaryComparison("any-project"), false, "shadow activity takes precedence over canary activity");
    delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
    console.log("[v2-dispatch] shadow mode → compute but no effects PASS");

    // --- Test 4: durable ownership selects the authoritative adapter once.
    // Comparison remains only in the legacy drain branch.
    const routeSource = await import("node:fs").then((fs) => fs.readFileSync(
      path.join(process.cwd(), "app/api/agent/tasks/[taskId]/workflow/route.ts"),
      "utf8",
    ));
    assert.ok(routeSource.includes("resolveEngineOwnership"), "route resolves durable ownership");
    assert.ok(routeSource.includes("dispatchByDurableEngine"), "route branches once by durable engine");
    assert.ok(routeSource.includes("submitAuthoritativeAgentWorkflowAction"), "V2 owner enters the canonical command adapter");
    assert.ok(routeSource.includes("computeV2Prediction"), "legacy comparison code remains during drain");
    assert.ok(routeSource.includes("recordV2Comparison"), "legacy comparison telemetry remains during drain");
    const ownershipIndex = routeSource.indexOf("const ownership = await resolveEngineOwnership");
    const legacyCounterIndex = routeSource.indexOf("await recordLegacyWorkflowBoundaryInvocation", ownershipIndex);
    assert.ok(ownershipIndex > 0 && legacyCounterIndex > ownershipIndex,
      "legacy counter is unreachable until durable legacy ownership is selected");
    assert.ok(routeSource.includes("if (captured.authoritativeV2) return response"),
      "V2 response bypasses the legacy mutationful response decorator");
    const finalizeHelper = routeSource.slice(
      routeSource.indexOf("async function recordV2ComparisonAfterLegacy"),
      routeSource.indexOf("async function runLegacyMutationWithV2Comparison"),
    );
    assert.ok(finalizeHelper.indexOf("if (!prediction) return") >= 0, "comparison finalizer has a no-probe fast path");
    assert.ok(
      finalizeHelper.indexOf("if (!prediction) return") < finalizeHelper.indexOf("db.task.findUnique"),
      "no-flags path returns before the post-mutation database query",
    );
    assert.ok(finalizeHelper.includes("V2 comparison finalization failed"), "comparison finalization is fail-soft");
    assert.ok(routeSource.includes("matches: differences.length === 0"), "comparison records an explicit overall match result");
    assert.ok(routeSource.includes("differences,"), "comparison always records a differences array");
    assert.ok(
      routeSource.indexOf("if (!auth.allowed)") < routeSource.indexOf("const decision = decideCommand"),
      "V2 decision is not computed after authorization or guard rejection",
    );
    console.log("[v2-dispatch] durable owner route adapter PASS");

    console.log("[v2-dispatch] PASS — authoritative dispatch and legacy drain verified");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[v2-dispatch] FAIL:", error);
  process.exit(1);
});
