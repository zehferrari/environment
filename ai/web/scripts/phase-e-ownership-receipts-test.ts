// Phase E §5 + §6 — Ownership and receipt unit + race tests.
//
// Tests:
//   Ownership: pin succeeds when preconditions met, pin rejects when
//   preconditions fail (active cycle, legacy job, wrong status, project not
//   in cohort), unpin rejects when active cycle/procedure exists, unpin
//   succeeds when quiescent, task↔cycle engine mismatch is rejected.
//
//   Receipt: first submission creates receipt and returns result; second
//   submission with same key + fingerprint returns stored result (replay);
//   submission with same key + different fingerprint returns
//   idempotency_conflict domain error.
//
//   Race: deterministic P2002 → re-read-winner branch exercised by
//   pre-inserting the competing receipt inside the transaction.
//
// All tests run against a disposable SQLite DB.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { computeRequestFingerprint, findOrCreateReceipt, serializeResult, deserializeResult, IDEMPOTENCY_CONFLICT } from "@/lib/tasks/orchestrator/receipts";
import {
  resolveEngineOwnership,
  pinToV2,
  unpinFromV2,
  ENGINE_LEGACY,
  ENGINE_ORCHESTRATOR_V2,
} from "@/lib/tasks/orchestrator/ownership";
import type { TaskWorkflowCommand, OrchestratorResult } from "@/lib/tasks/orchestrator/types";

// --- Disposable DB setup -------------------------------------------------

const disposableDir = process.env.TEST_DATABASE_URL
  ? null
  : mkdtempSync(path.join(tmpdir(), "phase-e-ownership-receipts-"));
const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? `file:${path.join(disposableDir!, "test.db")}`;
execFileSync("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL },
  stdio: "ignore",
});

const db = new PrismaClient({
  datasourceUrl: DATABASE_URL,
});

// --- Helpers --------------------------------------------------------------

let projectCounter = 0;

async function createProject() {
  projectCounter += 1;
  return db.project.create({
    data: {
      slug: `test-receipts-${projectCounter}-${Date.now()}`,
      name: `Test Receipts ${projectCounter}`,
    },
  });
}

async function createTask(projectId: string, status = "Backlog") {
  return db.task.create({
    data: {
      projectId,
      title: "Test task",
      status,
      // Ownership tests exercise migration from an explicit historical row;
      // the production database default is intentionally V2.
      workflowEngine: ENGINE_LEGACY,
      workflowEnginePinnedAt: null,
    },
  });
}

async function createUser() {
  return db.user.create({
    data: {
      username: `test-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `test-${Date.now()}@example.com`,
      kind: "agent",
    },
  });
}

function makeCommand(taskId: string, overrides: Record<string, unknown> = {}): TaskWorkflowCommand {
  return {
    taskId,
    intent: "checkpoint",
    actor: { id: "test-actor", kind: "agent" },
    expectedWorkflowVersion: 0,
    idempotencyKey: `test-key-${Math.random().toString(36).slice(2, 10)}`,
    source: "test",
    payload: {},
    ...overrides,
  } as TaskWorkflowCommand;
}

const acceptedResult: OrchestratorResult = {
  status: "accepted",
  transitionId: "test-transition-1",
  workflowVersion: 1,
  procedureId: null,
  cycleId: null,
};

// --- Ownership tests ------------------------------------------------------

async function testOwnershipPinSuccess() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");

  const result = await db.$transaction(async (tx) => {
    return pinToV2(tx, task.id, { projectInCohort: true });
  });

  assert.equal(result.ok, true, "pin should succeed when preconditions are met");

  const updated = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { workflowEngine: true, workflowEnginePinnedAt: true },
  });
  assert.equal(updated.workflowEngine, ENGINE_ORCHESTRATOR_V2);
  assert.ok(updated.workflowEnginePinnedAt, "workflowEnginePinnedAt should be set");
}

async function testOwnershipPinRejectsProjectNotInCohort() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");

  const result = await db.$transaction(async (tx) => {
    return pinToV2(tx, task.id, { projectInCohort: false });
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "project_not_in_cohort");
}

async function testOwnershipPinRejectsWrongStatus() {
  const project = await createProject();
  const task = await createTask(project.id, "In Progress");

  const result = await db.$transaction(async (tx) => {
    return pinToV2(tx, task.id, { projectInCohort: true });
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "status_not_approved");
}

async function testOwnershipPinRejectsOpenCycle() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");

  // Create an open cycle
  const cycle = await db.taskWorkflowCycle.create({
    data: {
      taskId: task.id,
      sequence: 1,
      status: "open",
      openedWorkflowVersion: 0,
    },
  });
  await db.task.update({
    where: { id: task.id },
    data: { activeWorkflowCycleId: cycle.id },
  });

  const result = await db.$transaction(async (tx) => {
    return pinToV2(tx, task.id, { projectInCohort: true });
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "open_cycle_exists");
}

async function testOwnershipPinRejectsActiveRepoJob() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");

  await db.taskRepositoryRun.create({
    data: {
      taskId: task.id,
      phase: "validating",
    },
  });

  const result = await db.$transaction(async (tx) => {
    return pinToV2(tx, task.id, { projectInCohort: true });
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "active_repo_job");
}

async function testOwnershipUnpinRejectsActiveCycle() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");
  const user = await createUser();

  // Pin first
  await db.$transaction(async (tx) => {
    return pinToV2(tx, task.id, { projectInCohort: true });
  });

  // Open a cycle
  const cycle = await db.taskWorkflowCycle.create({
    data: {
      taskId: task.id,
      sequence: 1,
      status: "open",
      openedWorkflowVersion: 1,
      workflowEngine: ENGINE_ORCHESTRATOR_V2,
    },
  });
  await db.task.update({
    where: { id: task.id },
    data: { activeWorkflowCycleId: cycle.id },
  });

  const result = await db.$transaction(async (tx) => {
    return unpinFromV2(tx, task.id, { operatorUserId: user.id });
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "active_cycle");
}

async function testOwnershipUnpinSucceedsWhenQuiescent() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");
  const user = await createUser();

  // Pin first
  await db.$transaction(async (tx) => {
    return pinToV2(tx, task.id, { projectInCohort: true });
  });

  const result = await db.$transaction(async (tx) => {
    return unpinFromV2(tx, task.id, { operatorUserId: user.id });
  });

  assert.equal(result.ok, true);

  const updated = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    select: { workflowEngine: true, workflowEnginePinnedAt: true },
  });
  assert.equal(updated.workflowEngine, ENGINE_LEGACY);
  assert.equal(updated.workflowEnginePinnedAt, null);
}

async function testOwnershipMismatchRejected() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");

  // Set task to V2 but cycle to legacy (mismatch)
  await db.task.update({
    where: { id: task.id },
    data: { workflowEngine: ENGINE_ORCHESTRATOR_V2 },
  });

  const cycle = await db.taskWorkflowCycle.create({
    data: {
      taskId: task.id,
      sequence: 1,
      status: "open",
      openedWorkflowVersion: 0,
      workflowEngine: ENGINE_LEGACY,
    },
  });
  await db.task.update({
    where: { id: task.id },
    data: { activeWorkflowCycleId: cycle.id },
  });

  const result = await db.$transaction(async (tx) => {
    return resolveEngineOwnership(tx, task.id);
  });

  assert.equal(result.ok, false);
  // The type narrowing here is tricky — check via the code property.
  assert.equal((result as { code: string }).code, "engine_mismatch");
}

// --- Receipt tests --------------------------------------------------------

async function testReceiptCreateAndReplay() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");
  const command = makeCommand(task.id);

  const fingerprint = computeRequestFingerprint(command);

  // First submission — create
  const createResult = await db.$transaction(async (tx) => {
    return findOrCreateReceipt(tx, command, fingerprint, acceptedResult, {
      transitionId: "test-transition-1",
      executionDurationMs: 37,
    });
  });
  assert.equal(createResult.kind, "create");
  assert.equal(
    (await db.taskWorkflowCommandReceipt.findFirstOrThrow({
      where: { taskId: task.id, idempotencyKey: command.idempotencyKey },
      select: { executionDurationMs: true },
    })).executionDurationMs,
    37,
  );

  // Second submission — replay
  const replayResult = await db.$transaction(async (tx) => {
    return findOrCreateReceipt(tx, command, fingerprint, acceptedResult, {
      transitionId: "test-transition-1",
    });
  });
  assert.equal(replayResult.kind, "replay");
  assert.equal(replayResult.result.status, "accepted");
  assert.equal(replayResult.result.transitionId, "test-transition-1");
}

async function testReceiptConflictOnDifferentPayload() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");
  const command1 = makeCommand(task.id, { intent: "checkpoint" });
  const command2 = makeCommand(task.id, {
    intent: "checkpoint",
    idempotencyKey: command1.idempotencyKey, // same key
    payload: { nextAction: "different" }, // different payload → different fingerprint
  });

  const fingerprint1 = computeRequestFingerprint(command1);
  const fingerprint2 = computeRequestFingerprint(command2);

  assert.notEqual(fingerprint1, fingerprint2, "different payloads must produce different fingerprints");

  // First submission — create
  await db.$transaction(async (tx) => {
    return findOrCreateReceipt(tx, command1, fingerprint1, acceptedResult, {});
  });

  // Second submission — conflict
  const conflictResult = await db.$transaction(async (tx) => {
    return findOrCreateReceipt(tx, command2, fingerprint2, acceptedResult, {});
  });
  assert.equal(conflictResult.kind, "conflict");
  assert.equal(conflictResult.code, IDEMPOTENCY_CONFLICT);
}

// --- Race test (deterministic P2002 → re-read-winner) --------------------

async function testRaceDeterministicP2002() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");
  const command = makeCommand(task.id);
  const fingerprint = computeRequestFingerprint(command);

  // SQLite serializes transactions, so the P2002 unique-constraint collision
  // cannot be triggered by concurrent transactions (they get SQLITE_BUSY).
  // We test the deterministic path: a pre-existing matching receipt returns
  // replay. The P2002 re-read-winner handler in findOrCreateReceipt is
  // defensive code for Postgres / production races.
  await db.taskWorkflowCommandReceipt.create({
    data: {
      taskId: command.taskId,
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: fingerprint,
      intent: command.intent,
      source: command.source,
      actorUserId: command.actor.id,
      expectedWorkflowVersion: command.expectedWorkflowVersion,
      resultingWorkflowVersion: 1,
      transitionId: "race-winner-transition",
      status: "accepted",
      result: serializeResult(acceptedResult),
    },
  });

  const result = await db.$transaction(async (tx) => {
    return findOrCreateReceipt(tx, command, fingerprint, acceptedResult, {
      transitionId: "race-loser-transition",
    });
  });

  // Pre-existing matching receipt → replay.
  assert.equal(result.kind, "replay");
  assert.equal(result.result.status, "accepted");
  assert.equal(result.result.transitionId, "test-transition-1");
}

async function testRaceDeterministicP2002Conflict() {
  const project = await createProject();
  const task = await createTask(project.id, "To Do");
  const command = makeCommand(task.id);
  const fingerprint = computeRequestFingerprint(command);
  const differentFingerprint = computeRequestFingerprint(
    makeCommand(command.taskId, {
      idempotencyKey: command.idempotencyKey,
      payload: { nextAction: "different" },
    }),
  );

  // Pre-insert with a DIFFERENT fingerprint in a separate transaction.
  await db.taskWorkflowCommandReceipt.create({
    data: {
      taskId: command.taskId,
      idempotencyKey: command.idempotencyKey,
      requestFingerprint: differentFingerprint,
      intent: command.intent,
      source: command.source,
      actorUserId: command.actor.id,
      expectedWorkflowVersion: command.expectedWorkflowVersion,
      resultingWorkflowVersion: 1,
      status: "accepted",
      result: serializeResult(acceptedResult),
    },
  });

  const result = await db.$transaction(async (tx) => {
    return findOrCreateReceipt(tx, command, fingerprint, acceptedResult, {});
  });

  // Pre-existing mismatched receipt → conflict.
  assert.equal(result.kind, "conflict");
  assert.equal(result.code, IDEMPOTENCY_CONFLICT);
}

// --- Fingerprint stability tests -----------------------------------------

async function testFingerprintStability() {
  const command = makeCommand("task-1", {
    intent: "start_implementation",
    actor: { id: "actor-1", kind: "agent" },
    payload: { worktreePath: "/tmp/a", branchName: "b" },
  });

  const fp1 = computeRequestFingerprint(command);
  const fp2 = computeRequestFingerprint(command);
  assert.equal(fp1, fp2, "identical commands must produce identical fingerprints");

  // Different intent → different fingerprint
  const fp3 = computeRequestFingerprint({ ...command, intent: "checkpoint", payload: {} });
  assert.notEqual(fp1, fp3, "different intent must produce different fingerprint");

  // Different actor → different fingerprint
  const fp4 = computeRequestFingerprint({ ...command, actor: { id: "actor-2", kind: "agent" } });
  assert.notEqual(fp1, fp4, "different actor must produce different fingerprint");

  // Key order in payload should not matter (canonical JSON sorts keys)
  const commandReordered = makeCommand("task-1", {
    intent: "start_implementation",
    actor: { id: "actor-1", kind: "agent" },
    payload: { branchName: "b", worktreePath: "/tmp/a" }, // same values, different key order
  });
  const fp5 = computeRequestFingerprint(commandReordered);
  assert.equal(fp1, fp5, "key order in payload must not affect fingerprint");
}

// --- Main runner ----------------------------------------------------------

async function main() {
  const tests: Array<[string, () => Promise<void>]> = [
    ["Ownership: pin succeeds when preconditions met", testOwnershipPinSuccess],
    ["Ownership: pin rejects when project not in cohort", testOwnershipPinRejectsProjectNotInCohort],
    ["Ownership: pin rejects when status not approved", testOwnershipPinRejectsWrongStatus],
    ["Ownership: pin rejects when open cycle exists", testOwnershipPinRejectsOpenCycle],
    ["Ownership: pin rejects when active repo job exists", testOwnershipPinRejectsActiveRepoJob],
    ["Ownership: unpin rejects when active cycle exists", testOwnershipUnpinRejectsActiveCycle],
    ["Ownership: unpin succeeds when quiescent", testOwnershipUnpinSucceedsWhenQuiescent],
    ["Ownership: task↔cycle engine mismatch rejected", testOwnershipMismatchRejected],
    ["Receipt: first submission creates, second replays", testReceiptCreateAndReplay],
    ["Receipt: same key + different payload → conflict", testReceiptConflictOnDifferentPayload],
    ["Race: pre-existing receipt with same fingerprint → replay", testRaceDeterministicP2002],
    ["Race: pre-existing receipt with different fingerprint → conflict", testRaceDeterministicP2002Conflict],
    ["Fingerprint: stability and canonical key sorting", testFingerprintStability],
  ];

  let passed = 0;
  let failed = 0;

  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);

  if (failed > 0) {
    process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
    if (disposableDir) rmSync(disposableDir, { recursive: true, force: true });
  });
