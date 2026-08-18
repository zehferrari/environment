// ORCH-09/10 integration test: V2 dispatch from the agent workflow route.
//
// Verifies that:
//   - With no flags set, the V2 dispatch is a no-op (legacy path runs).
//   - With PM_ORCHESTRATOR_V2_PROJECTS set, the V2 path handles the action.
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
    const { shouldComputeV2Decision, shouldRunV2Effects, orchestratorShadowEnabled } = await import("@/lib/tasks/orchestrator/flags");

    // --- Test 1: no flags → V2 not active ------------------------------
    delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
    delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
    assert.equal(shouldComputeV2Decision("any-project"), false, "V2 not active without flags");
    assert.equal(shouldRunV2Effects("any-project"), false, "V2 effects not run without flags");
    console.log("[v2-dispatch] no flags → V2 inactive PASS");

    // --- Test 2: canary mode → V2 active for allowlisted project ------
    process.env.PM_ORCHESTRATOR_V2_PROJECTS = "test-project";
    assert.equal(shouldComputeV2Decision("test-project"), true, "V2 active for canary project");
    assert.equal(shouldRunV2Effects("test-project"), true, "V2 effects run for canary project");
    assert.equal(shouldRunV2Effects("other-project"), false, "V2 effects do not run for non-canary");
    delete process.env.PM_ORCHESTRATOR_V2_PROJECTS;
    console.log("[v2-dispatch] canary mode → V2 active PASS");

    // --- Test 3: shadow mode → V2 computes but no effects -------------
    process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
    assert.equal(orchestratorShadowEnabled(), true, "shadow enabled");
    assert.equal(shouldComputeV2Decision("any-project"), true, "V2 computes in shadow mode");
    assert.equal(shouldRunV2Effects("any-project"), false, "V2 effects do not run in shadow mode");
    delete process.env.PM_ORCHESTRATOR_V2_SHADOW;
    console.log("[v2-dispatch] shadow mode → compute but no effects PASS");

    // --- Test 4: the route uses computeV2Prediction + recordV2Comparison
    // (two-phase comparison probe), never calls submitWorkflowCommand, and
    // never returns early from a V2 call.
    const routeSource = await import("node:fs").then((fs) => fs.readFileSync(
      path.join(process.cwd(), "app/api/agent/tasks/[taskId]/workflow/route.ts"),
      "utf8",
    ));
    assert.ok(routeSource.includes("computeV2Prediction"), "route has computeV2Prediction");
    assert.ok(routeSource.includes("recordV2Comparison"), "route has recordV2Comparison");
    assert.ok(!routeSource.includes("tryV2Dispatch"), "old tryV2Dispatch is removed");
    assert.ok(!routeSource.includes("tryV2CanaryMutation"), "old tryV2CanaryMutation is removed");
    assert.ok(!routeSource.match(/await\s+submitWorkflowCommand\(/), "route never calls submitWorkflowCommand as a function call");
    // No early returns from V2 calls.
    assert.ok(!routeSource.includes("if (v2StartResult) return"), "no early return from V2 start");
    assert.ok(!routeSource.includes("if (v2ReviewResult) return"), "no early return from V2 review");
    assert.ok(!routeSource.includes("if (v2FeedbackResult) return"), "no early return from V2 feedback");
    assert.ok(!routeSource.includes("if (v2DoneResult) return"), "no early return from V2 done");
    // The probe is called AFTER the rollover barrier.
    const rolloverIdx = routeSource.indexOf("THE ROLLOVER BARRIER");
    const firstComputeCall = routeSource.indexOf("await computeV2Prediction(action");
    assert.ok(rolloverIdx > 0, "rollover barrier exists");
    assert.ok(firstComputeCall > rolloverIdx, "first V2 compute call is AFTER the rollover barrier");
    // All 5 key actions have compute + record calls.
    const actionBlocks = ["approve_plan", "start", "ready_for_review", "review_feedback", "review_done"];
    for (const act of actionBlocks) {
      const actionIdx = routeSource.indexOf(`action === "${act}"`);
      assert.ok(actionIdx > 0, `${act} action block exists`);
      const nextCompute = routeSource.indexOf("computeV2Prediction(", actionIdx);
      const nextAction = routeSource.indexOf("\n  if (action === ", actionIdx + 1);
      assert.ok(nextCompute > actionIdx && (nextAction < 0 || nextCompute < nextAction),
        `${act} action block has a computeV2Prediction call before the next action`);
    }
    console.log("[v2-dispatch] route two-phase comparison probe PASS");

    console.log("[v2-dispatch] PASS — V2 dispatch integration verified");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[v2-dispatch] FAIL:", error);
  process.exit(1);
});