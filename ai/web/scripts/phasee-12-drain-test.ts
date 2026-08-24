// ENV-157 / Phase E E5 — V2-default creation and legacy-drain gate coverage.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const sandbox = mkdtempSync(path.join(tmpdir(), "phasee-12-drain-"));
const databaseUrl = `file:${path.join(sandbox, "test.db")}`;
process.env.DATABASE_URL = databaseUrl;

execFileSync("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "ignore",
});

async function main() {
  const { db } = await import("@/lib/db");
  const {
    ENGINE_ORCHESTRATOR_V2,
    inspectLegacyDrain,
    newTaskWorkflowOwnership,
  } = await import("@/lib/tasks/orchestrator/ownership");
  const {
    getLegacyDefaultCutoverReport,
    runLegacyDefaultCutover,
  } = await import("@/lib/tasks/orchestrator/default-cutover");

  // The permanent AST gate in workflow-boundary-test.ts discovers every
  // product Task.create/createMany/upsert site. This integration test keeps
  // only the runtime contract instead of freezing a hand-maintained file list.
  assert.equal(newTaskWorkflowOwnership().workflowEngine, ENGINE_ORCHESTRATOR_V2);
  assert.ok(newTaskWorkflowOwnership().workflowEnginePinnedAt instanceof Date);

  const owner = await db.user.create({
    data: {
      username: "phasee-12-owner",
      email: "phasee-12-owner@example.invalid",
      kind: "human",
      status: "active",
      isOwner: true,
    },
  });
  const project = await db.project.create({ data: { slug: "phasee-12", name: "Phase E E5" } });
  const databaseDefault = await db.task.create({
    data: { projectId: project.id, title: "Database-default V2 ownership" },
  });
  assert.equal(databaseDefault.workflowEngine, ENGINE_ORCHESTRATOR_V2,
    "the database default must prevent legacy ownership by omission");
  assert.ok(databaseDefault.workflowEnginePinnedAt instanceof Date,
    "the database default must pin newly-created V2 ownership");
  const candidate = await db.task.create({
    data: { projectId: project.id, title: "Quiescent legacy", status: "To Do", workflowEngine: "legacy" },
  });
  const archived = await db.task.create({
    data: {
      projectId: project.id,
      title: "Archived history",
      status: "Review",
      workflowEngine: "legacy",
      archivedAt: new Date(),
    },
  });
  const draining = await db.task.create({
    data: { projectId: project.id, title: "Owned legacy attempt", status: "In Progress", workflowEngine: "legacy" },
  });
  const cycle = await db.taskWorkflowCycle.create({
    data: { taskId: draining.id, sequence: 1, openedWorkflowVersion: 0, workflowEngine: "legacy" },
  });
  await db.task.update({ where: { id: draining.id }, data: { activeWorkflowCycleId: cycle.id } });

  assert.equal((await inspectLegacyDrain(db, candidate.id)).allowed, false,
    "fresh legacy work is rejected");
  assert.equal((await inspectLegacyDrain(db, draining.id)).allowed, true,
    "an active legacy cycle may drain");

  const initial = await getLegacyDefaultCutoverReport();
  assert.deepEqual(initial.candidates.map((task) => task.taskId), [candidate.id]);
  assert.deepEqual(initial.drain.map((task) => task.taskId), [draining.id]);
  assert.ok(!initial.candidates.some((task) => task.taskId === archived.id), "archived history is excluded");

  const dryRun = await runLegacyDefaultCutover({ operatorUserId: owner.id, dryRun: true });
  assert.equal(dryRun.counts.wouldPin, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: candidate.id } })).workflowEngine, "legacy");
  const applied = await runLegacyDefaultCutover({ operatorUserId: owner.id });
  assert.equal(applied.counts.pinned, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: candidate.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);

  const windowStart = new Date();
  const blockedGate = await getLegacyDefaultCutoverReport({ since: windowStart });
  assert.equal(blockedGate.gate.ready, false);
  assert.equal(blockedGate.gate.legacyDrainCount, 1);
  await db.$transaction([
    db.taskWorkflowCycle.update({
      where: { id: cycle.id },
      data: { status: "closed", outcome: "completed", closedAt: new Date(), closedWorkflowVersion: 0 },
    }),
    db.task.update({ where: { id: draining.id }, data: { status: "Done", activeWorkflowCycleId: null } }),
  ]);
  const readyGate = await getLegacyDefaultCutoverReport({ since: windowStart });
  assert.equal(readyGate.gate.ready, true);

  console.log("ENV-157 Phase E E5 drain tests passed");
  await db.$disconnect();
}

main()
  .finally(() => rmSync(sandbox, { recursive: true, force: true }));
