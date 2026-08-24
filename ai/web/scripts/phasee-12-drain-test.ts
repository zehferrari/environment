// ENV-157 / Phase E E5 — V2-default creation and legacy-drain gate coverage.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  const creationFiles = [
    "lib/create/actions.ts",
    "lib/work-items/apply.ts",
    "lib/epics/actions.ts",
    "lib/tasks/action-plan-store.ts",
    "app/api/agent/epics/[epicId]/workflow/route.ts",
    "app/(app)/projects/[slug]/page.tsx",
  ];
  let taskCreateCount = 0;
  for (const file of creationFiles) {
    const source = readFileSync(path.join(process.cwd(), file), "utf8");
    const matches = [...source.matchAll(/\.task\.create\(\{\s*data:\s*\{/g)];
    taskCreateCount += matches.length;
    for (const match of matches) {
      assert.match(source.slice(match.index, match.index + 250), /newTaskWorkflowOwnership\(/,
        `${file} must stamp durable V2 ownership at task creation`);
    }
  }
  assert.equal(taskCreateCount, 7, "all product task-creation boundaries are frozen by this test");
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
