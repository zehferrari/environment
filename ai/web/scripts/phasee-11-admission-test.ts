// PHASEE-11 — deterministic effectful-admission and rollback coverage.
// Runs only against a disposable SQLite database.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const disposableDir = mkdtempSync(path.join(tmpdir(), "phasee-11-admission-"));
const databaseUrl = `file:${path.join(disposableDir, "test.db")}`;
process.env.DATABASE_URL = databaseUrl;

execFileSync("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: "ignore",
});

async function main() {
  const { db } = await import("@/lib/db");
  const {
    orchestratorShadowEnabled,
    shouldComputeV2Decision,
    isV2MutationAdmissionEnabledForProject,
  } = await import("@/lib/tasks/orchestrator/flags");
  const {
    runProjectAdmission,
    unpinQuiescentTask,
  } = await import("@/lib/tasks/orchestrator/admission");
  const {
    ENGINE_LEGACY,
    ENGINE_ORCHESTRATOR_V2,
    pinToV2,
    unpinFromV2,
  } = await import("@/lib/tasks/orchestrator/ownership");
  const { evaluateRolloutGates } = await import("@/lib/tasks/orchestrator/rollout-gates");

  process.env.PM_ORCHESTRATOR_V2_SHADOW = "1";
  process.env.PM_ORCHESTRATOR_V2_PROJECTS = "*";
  delete process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS;
  assert.equal(orchestratorShadowEnabled(), true);
  assert.equal(shouldComputeV2Decision("internal-canary"), true);
  assert.equal(isV2MutationAdmissionEnabledForProject("internal-canary"), false,
    "compute-only flags must never enable effectful admission");

  const owner = await db.user.create({
    data: {
      username: "phasee-11-owner",
      email: "phasee-11-owner@example.invalid",
      kind: "human",
      status: "active",
      isOwner: true,
    },
  });
  const project = await db.project.create({
    data: { slug: "internal-canary", name: "Synthetic private Phase E canary" },
  });
  const eligible = await db.task.create({
    data: { projectId: project.id, title: "Private quiescent task", status: "To Do", private: true },
  });
  const active = await db.task.create({
    data: { projectId: project.id, title: "Private active task", status: "In Progress", private: true },
  });
  const publicTask = await db.task.create({
    data: { projectId: project.id, title: "Public task", status: "Backlog", private: false },
  });

  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = project.slug;
  const evidence = {
    schemaVersion: 1 as const,
    evidenceId: "phasee-11-test-evidence",
    generatedAt: new Date().toISOString(),
    targetProjectSlug: project.slug,
    mode: "e2_internal_canary" as const,
    syntheticPrivateProject: true,
    checks: {
      migrations: true,
      typecheck: true,
      workflowSuite: true,
      phaseESuites: true,
      build: true,
      lint: true,
      procedureHandlerIdempotency: true,
      callbackV2Correlation: true,
      comparisonParity: true,
      doctorInvariants: true,
    },
    ownership: { backupOwner: "owner", rollbackOwner: "owner", onCallOwner: "owner" },
    artifacts: ["disposable-db:test"],
  };
  assert.equal(evaluateRolloutGates(evidence).ready, true);

  const dryRun = await runProjectAdmission({
    projectSlug: project.slug,
    operatorUserId: owner.id,
    evidence,
    dryRun: true,
  });
  assert.equal(dryRun.counts.wouldAdmit, 1);
  assert.equal(dryRun.tasks.find((task) => task.taskId === active.id)?.reasonCode, "status_not_approved");
  assert.equal(dryRun.tasks.find((task) => task.taskId === publicTask.id)?.reasonCode, "canary_task_not_private");
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_LEGACY);

  const admitted = await runProjectAdmission({
    projectSlug: project.slug,
    operatorUserId: owner.id,
    evidence,
  });
  assert.equal(admitted.counts.admitted, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);

  const replayed = await runProjectAdmission({
    projectSlug: project.slug,
    operatorUserId: owner.id,
    evidence,
  });
  assert.equal(replayed.counts.admitted, 0);
  assert.equal(replayed.counts.alreadyPinned, 1);
  assert.equal(await db.activityLog.count({
    where: { taskId: eligible.id, kind: "task.workflow.engine_pinned" },
  }), 1, "repeated admission must not duplicate the pin or its audit row");
  assert.equal(await db.activityLog.count({
    where: { taskId: publicTask.id, kind: "task.workflow.engine_admission_skipped" },
  }), 1, "repeated skip evidence must be deduplicated");

  // Removing the allowlist stops only new admission. Durable V2 ownership is
  // unchanged and remains authoritative.
  delete process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS;
  const laterTask = await db.task.create({
    data: { projectId: project.id, title: "Created after rollback", status: "Backlog", private: true },
  });
  assert.equal(isV2MutationAdmissionEnabledForProject(project.slug), false);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: laterTask.id } })).workflowEngine, ENGINE_LEGACY);

  // Quiescent unpin rejects every active workflow phase. The task engine is
  // never changed by a rejection.
  await db.task.update({ where: { id: eligible.id }, data: { status: "In Progress" } });
  let unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);

  await db.task.update({ where: { id: eligible.id }, data: { status: "Review" } });
  unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);

  await db.task.update({ where: { id: eligible.id }, data: { status: "To Do" } });
  await db.taskRepositoryRun.create({ data: { taskId: eligible.id, phase: "validating" } });
  unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);
  assert.equal((unpin as { code: string }).code, "active_repository_work");
  await db.taskRepositoryRun.delete({ where: { taskId: eligible.id } });

  const transition = await db.workflowTransition.create({
    data: {
      taskId: eligible.id,
      workflowVersion: 1,
      intent: "test",
      fromStatus: "To Do",
      toStatus: "To Do",
      source: "phasee-11-test",
      idempotencyKey: "phasee-11-procedure-transition",
    },
  });
  const procedure = await db.taskProcedureRun.create({
    data: {
      taskId: eligible.id,
      triggerTransitionId: transition.id,
      type: "start_implementation_cycle",
      status: "queued",
    },
  });
  unpin = await db.$transaction((tx) => unpinFromV2(tx, eligible.id, { operatorUserId: owner.id }));
  assert.equal(unpin.ok, false);
  assert.equal((unpin as { code: string }).code, "active_procedure");
  await db.taskProcedureRun.update({ where: { id: procedure.id }, data: { status: "completed", completedAt: new Date() } });

  const result = await unpinQuiescentTask({
    projectSlug: project.slug,
    taskIdOrKey: eligible.id,
    operatorUserId: owner.id,
  });
  assert.deepEqual(result, { ok: true, code: "unpinned" });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_LEGACY);

  // A fresh re-pin is possible only after the cohort is re-enabled; two
  // concurrent attempts converge on exactly one durable owner.
  process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = project.slug;
  const concurrent = await Promise.all([
    db.$transaction((tx) => pinToV2(tx, eligible.id, { projectInCohort: true, operatorUserId: owner.id })),
    db.$transaction((tx) => pinToV2(tx, eligible.id, { projectInCohort: true, operatorUserId: owner.id })),
  ]);
  assert.equal(concurrent.filter((item) => item.ok && item.code === "pinned").length, 1);
  assert.equal(concurrent.filter((item) => item.ok && item.code === "already_pinned").length, 1);
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: eligible.id } })).workflowEngine, ENGINE_ORCHESTRATOR_V2);

  console.log("PHASEE-11 admission: compute-only isolation, gated pinning, rollback, unpin, and concurrency passed");
  await db.$disconnect();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(disposableDir, { recursive: true, force: true });
  });
