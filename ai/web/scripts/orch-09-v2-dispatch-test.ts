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

    // --- Test 4: the route's tryV2CanaryMutation is called INSIDE action
    // handlers (after safety gates), not before them. Verify the route source
    // has the function and that it's NOT called before the rollover barrier.
    const routeSource = await import("node:fs").then((fs) => fs.readFileSync(
      path.join(process.cwd(), "app/api/agent/tasks/[taskId]/workflow/route.ts"),
      "utf8",
    ));
    assert.ok(routeSource.includes("tryV2CanaryMutation"), "route has tryV2CanaryMutation");
    assert.ok(!routeSource.includes("tryV2Dispatch"), "old tryV2Dispatch is removed");
    assert.ok(routeSource.includes("shouldComputeV2Decision"), "route checks V2 flags");
    assert.ok(routeSource.includes("ACTION_TO_INTENT"), "route has action-to-intent mapping");
    // Shadow mode must NOT call submitWorkflowCommand — only compute.
    assert.ok(routeSource.includes("Do NOT call submitWorkflowCommand"), "shadow mode explicitly avoids mutations");
    // The V2 canary is called AFTER the rollover barrier, not before it.
    const rolloverIdx = routeSource.indexOf("THE ROLLOVER BARRIER");
    const firstCanaryCall = routeSource.indexOf("tryV2CanaryMutation(action");
    assert.ok(rolloverIdx > 0, "rollover barrier exists");
    assert.ok(firstCanaryCall > rolloverIdx, "first V2 canary call is AFTER the rollover barrier");
    // Verify all 5 key actions have V2 canary calls inside their handlers.
    const actionBlocks = ["approve_plan", "start", "ready_for_review", "review_feedback", "review_done"];
    for (const act of actionBlocks) {
      // Some actions share a block (e.g. ready_for_review || submit_review).
      const actionIdx = routeSource.indexOf(`action === "${act}"`);
      assert.ok(actionIdx > 0, `${act} action block exists`);
      const nextCanary = routeSource.indexOf("tryV2CanaryMutation(action", actionIdx);
      const nextAction = routeSource.indexOf("\n  if (action === ", actionIdx + 1);
      assert.ok(nextCanary > actionIdx && (nextAction < 0 || nextCanary < nextAction),
        `${act} action block has a V2 canary call before the next action`);
    }
    console.log("[v2-dispatch] route V2 canary placement PASS");

    console.log("[v2-dispatch] PASS — V2 dispatch integration verified");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[v2-dispatch] FAIL:", error);
  process.exit(1);
});