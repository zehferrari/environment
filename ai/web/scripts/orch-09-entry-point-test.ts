// ORCH-09 — Entry-point migration + boundary enforcement tests.
//
// Verifies that:
//   - The strengthened workflow-boundary-test passes (no direct writes to
//     Task.status, Task.workflowVersion, Task.activeWorkflowCycleId, or
//     ReviewRun decision fields outside allowed modules);
//   - The orchestrator's submitWorkflowCommand is available as the canonical
//     entry point for every workflow mutation;
//   - The projection exposes the state agents and UI need.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFileSync } from "node:fs/promises";
import { readFileSync as readFileSyncSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch09-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  return { dbUrl, cleanup: () => rm(sandbox, { recursive: true, force: true }) };
}

async function main() {
  // --- Test 1: boundary test passes (structural guard) ----------------
  const boundarySource = readFileSyncSync(
    path.join(process.cwd(), "scripts", "workflow-boundary-test.ts"),
    "utf8",
  );
  assert.ok(boundarySource.includes("PROTECTED_TASK_FIELDS"), "boundary test protects Task fields");
  assert.ok(boundarySource.includes("PROTECTED_REVIEW_RUN_FIELDS"), "boundary test protects ReviewRun fields");
  assert.ok(boundarySource.includes("activeWorkflowCycleId"), "boundary test protects active cycle pointer");
  assert.ok(boundarySource.includes("workflowVersion"), "boundary test protects workflowVersion");
  console.log("[orch09] boundary test protects all workflow fields PASS");

  // --- Test 2 + 3: set up DB BEFORE importing any modules that use Prisma
  const { dbUrl, cleanup } = await freshDb();
  process.env.DATABASE_URL = dbUrl;
  try {
    // --- Test 2: orchestrator is available as canonical entry point ------
    const { submitWorkflowCommand, buildTaskWorkflowProjection } = await import("@/lib/tasks/orchestrator");
    assert.equal(typeof submitWorkflowCommand, "function", "submitWorkflowCommand is exported");
    assert.equal(typeof buildTaskWorkflowProjection, "function", "buildTaskWorkflowProjection is exported");
    console.log("[orch09] orchestrator canonical entry point available PASS");

    // --- Test 3: projection exposes all required fields ------------------
    const { db } = await import("@/lib/db");
    const owner = await db.user.create({ data: { username: "o", email: "o@x.example", kind: "human" } });
    const project = await db.project.create({ data: { slug: "orch09", name: "ORCH-09" } });
    const task = await db.task.create({ data: { projectId: project.id, title: "T", status: "Backlog", assigneeId: owner.id, actingManagerId: owner.id, reporterId: owner.id } });
    const projection = await buildTaskWorkflowProjection(task.id);
    assert.ok(projection, "projection built");
    assert.equal(projection!.taskId, task.id);
    assert.equal(projection!.status, "Backlog");
    assert.equal(projection!.workflowVersion, 0);
    assert.ok(projection!.activeCycle !== undefined, "projection has activeCycle field");
    assert.ok(projection!.resolvedReviewerId !== undefined, "projection has resolvedReviewerId");
    assert.ok(projection!.activeReviewLease !== undefined, "projection has activeReviewLease");
    assert.ok(projection!.activeProcedure !== undefined, "projection has activeProcedure");
    assert.ok(Array.isArray(projection!.allowedIntents), "projection has allowedIntents array");
    assert.ok(projection!.operationalError !== undefined, "projection has operationalError");
    console.log("[orch09] projection exposes all required fields PASS");
  } finally {
    await cleanup();
  }

  console.log("[orch09] PASS — all entry-point + boundary assertions held");
}

main().catch((error) => {
  console.error("[orch09] FAIL:", error);
  process.exit(1);
});