// ORCH-01 — Task workflow cycle lifecycle and backfill tests.
//
// Verifies the invariants from §4.5 of the orchestration plan:
//   - same task, same candidate SHA, two different cycles (V23-36 property)
//   - one task cannot have two open cycles (invariant 5)
//   - sequence increments correctly across cycles
//   - migration backfill is deterministic and idempotent
//   - close/update on a task with no active cycle return null (safe no-ops)

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const CYCLE_MIGRATION_ID = "20260818012400_task_workflow_cycles";

async function main() {
  // Single sandbox DB shared by both test phases — the Prisma client is
  // global/memoized, so switching DATABASE_URL between phases would leave the
  // client connected to the first DB. We re-seed between phases.
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch01-cycle-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  try {
    await execFileP(
      "pnpm",
      ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
      { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
    );
    await backfillTests();
    // Clear all data so the lifecycle phase starts fresh.
    const { db } = await import("@/lib/db");
    await db.taskWorkflowCycle.deleteMany({});
    await db.workflowTransition.deleteMany({});
    await db.reviewRun.deleteMany({});
    await db.taskRepositoryRun.deleteMany({});
    await db.task.deleteMany({});
    await db.project.deleteMany({});
    await db.user.deleteMany({});
    await lifecycleTests();
    console.log("[orch01-cycle] PASS — all cycle lifecycle and backfill assertions held");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

// --- Backfill tests --------------------------------------------------------
// Seed data on a fully-migrated DB (using Prisma's typed client to avoid raw
// column-name pain), then DELETE the backfilled cycle rows and re-run the
// backfill SQL block from the migration to verify it reproduces the same
// cycles deterministically (idempotency).
async function backfillTests() {
  const { db } = await import("@/lib/db");

    const owner = await db.user.create({
      data: { username: "bfowner", email: "bf@x.example", kind: "human" },
    });
    const project = await db.project.create({
      data: { slug: "bfproj", name: "BF Project" },
    });

    // taskDone: Done with 3 transitions (start, submit_review, accept_review)
    const taskDone = await db.task.create({
      data: {
        projectId: project.id,
        title: "Done task",
        status: "Done",
        workflowVersion: 3,
        approvedOn: new Date(),
        approvedById: owner.id,
      },
    });
    const t1 = await db.workflowTransition.create({
      data: { taskId: taskDone.id, workflowVersion: 1, intent: "start", fromStatus: "To Do", toStatus: "In Progress", actorUserId: owner.id, source: "test", idempotencyKey: "bf-k1" },
    });
    const t2 = await db.workflowTransition.create({
      data: { taskId: taskDone.id, workflowVersion: 2, intent: "submit_review", fromStatus: "In Progress", toStatus: "Review", actorUserId: owner.id, source: "test", idempotencyKey: "bf-k2" },
    });
    const t3 = await db.workflowTransition.create({
      data: { taskId: taskDone.id, workflowVersion: 3, intent: "accept_review", fromStatus: "Review", toStatus: "Done", actorUserId: owner.id, source: "test", idempotencyKey: "bf-k3" },
    });

    // taskIp: In Progress with 1 start transition (open cycle)
    const taskIp = await db.task.create({
      data: { projectId: project.id, title: "IP task", status: "In Progress", workflowVersion: 1, approvedOn: new Date(), approvedById: owner.id },
    });
    await db.workflowTransition.create({
      data: { taskId: taskIp.id, workflowVersion: 1, intent: "start", fromStatus: "To Do", toStatus: "In Progress", actorUserId: owner.id, source: "test", idempotencyKey: "bf-k4" },
    });

    // taskBacklog: Backlog with 1 cancel transition (closed cycle, cancelled)
    const taskBacklog = await db.task.create({
      data: { projectId: project.id, title: "Backlog task", status: "Backlog", workflowVersion: 1 },
    });
    await db.workflowTransition.create({
      data: { taskId: taskBacklog.id, workflowVersion: 1, intent: "cancel", fromStatus: "To Do", toStatus: "Backlog", actorUserId: owner.id, source: "test", idempotencyKey: "bf-k5" },
    });

    // The migration backfill already ran on this empty DB and produced 0
    // cycles (no rows existed at migration time). Now manually run the backfill
    // SQL block to verify it produces the expected cycles for the seeded data.
    // Prisma's $executeRawUnsafe runs a single statement, so split on ';'.
    const migrationSql = readFileSync(
      path.join(process.cwd(), "prisma", "migrations", CYCLE_MIGRATION_ID, "migration.sql"),
      "utf8",
    );
    const backfillStart = migrationSql.indexOf("-- Backfill (expand phase)");
    const backfillEnd = migrationSql.indexOf("-- Add foreign key constraints");
    const backfillSql = migrationSql.slice(backfillStart, backfillEnd);
    const sqlOnly = backfillSql.replace(/^--[^\n]*\n/gm, "").trim();
    const statements = sqlOnly.split(";").map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await db.$executeRawUnsafe(stmt);
    }

    // --- Verify backfill produced expected cycles --------------------------
    const taskDoneCycles = await db.taskWorkflowCycle.findMany({
      where: { taskId: taskDone.id },
      orderBy: { sequence: "asc" },
    });
    assert.equal(taskDoneCycles.length, 1, "Done task should have 1 backfilled cycle");
    assert.equal(taskDoneCycles[0].status, "closed");
    assert.equal(taskDoneCycles[0].outcome, "completed");
    assert.equal(taskDoneCycles[0].sequence, 1);
    assert.equal(taskDoneCycles[0].openedByTransitionId, t1.id, "openedByTransitionId = first transition");
    assert.equal(taskDoneCycles[0].closedByTransitionId, t3.id, "closedByTransitionId = last transition");
    assert.equal(taskDoneCycles[0].openedWorkflowVersion, 1);
    assert.equal(taskDoneCycles[0].closedWorkflowVersion, 3);
    const attachedTransitions = await db.workflowTransition.count({
      where: { taskId: taskDone.id, workflowCycleId: taskDoneCycles[0].id },
    });
    assert.equal(attachedTransitions, 3, "all 3 Done-task transitions attached to backfilled cycle");

    const taskIpCycles = await db.taskWorkflowCycle.findMany({
      where: { taskId: taskIp.id },
    });
    assert.equal(taskIpCycles.length, 1, "In Progress task should have 1 backfilled cycle");
    assert.equal(taskIpCycles[0].status, "open");
    assert.equal(taskIpCycles[0].outcome, null);
    const taskIpTask = await db.task.findUnique({ where: { id: taskIp.id }, select: { activeWorkflowCycleId: true } });
    assert.equal(taskIpTask?.activeWorkflowCycleId, taskIpCycles[0].id, "In Progress task active cycle pointer set");

    const taskBacklogCycles = await db.taskWorkflowCycle.findMany({
      where: { taskId: taskBacklog.id },
    });
    assert.equal(taskBacklogCycles.length, 1, "cancelled-Backlog task should have 1 backfilled cycle");
    assert.equal(taskBacklogCycles[0].status, "closed");
    assert.equal(taskBacklogCycles[0].outcome, "cancelled");

    // --- Idempotency: delete all cycle rows + clear pointers, re-run -------
    await db.task.updateMany({ where: { activeWorkflowCycleId: { not: null } }, data: { activeWorkflowCycleId: null } });
    await db.workflowTransition.updateMany({ where: { workflowCycleId: { not: null } }, data: { workflowCycleId: null } });
    await db.workflowOutbox.updateMany({ where: { workflowCycleId: { not: null } }, data: { workflowCycleId: null } });
    await db.taskRepositoryRun.updateMany({ where: { workflowCycleId: { not: null } }, data: { workflowCycleId: null } });
    await db.reviewRun.updateMany({ where: { workflowCycleId: { not: null } }, data: { workflowCycleId: null } });
    await db.taskWorkflowCycle.deleteMany({});
    for (const stmt of statements) {
      await db.$executeRawUnsafe(stmt);
    }
    const taskDoneCyclesRe = await db.taskWorkflowCycle.findMany({ where: { taskId: taskDone.id } });
    assert.equal(taskDoneCyclesRe.length, 1, "re-run backfill produces 1 cycle for Done task");
    assert.equal(taskDoneCyclesRe[0].id, taskDoneCycles[0].id, "re-run produces same cycle id (deterministic)");
    assert.equal(taskDoneCyclesRe[0].status, "closed");
    assert.equal(taskDoneCyclesRe[0].outcome, "completed");

    console.log("[orch01-cycle] backfill assertions PASS");
}

// --- Lifecycle tests -------------------------------------------------------
async function lifecycleTests() {
  const { db } = await import("@/lib/db");
  const {
    openTaskWorkflowCycle,
    closeTaskWorkflowCycle,
    updateTaskWorkflowCycleCandidate,
    getActiveTaskWorkflowCycle,
    getTaskWorkflowCycle,
    CycleInvariantError,
  } = await import("@/lib/tasks/workflow-cycle");

    const owner = await db.user.create({
      data: { username: "orch01-owner", email: "orch01@example.invalid", kind: "human" },
    });
    const project = await db.project.create({
      data: { slug: "orch01", name: "ORCH-01" },
    });
    const task = await db.task.create({
      data: { projectId: project.id, title: "Lifecycle task", status: "To Do" },
    });

    // --- Open first cycle --------------------------------------------------
    const cycle1 = await db.$transaction(async (tx) =>
      openTaskWorkflowCycle(tx, {
        taskId: task.id,
        openedWorkflowVersion: 1,
        openedByTransitionId: "transition-1",
      }),
    );
    assert.equal(cycle1.sequence, 1, "first cycle should be sequence 1");
    assert.equal(cycle1.status, "open");
    assert.equal(cycle1.openedWorkflowVersion, 1);
    const active1 = await getActiveTaskWorkflowCycle(task.id);
    assert.equal(active1?.id, cycle1.id, "active cycle pointer set");

    // --- Cannot open a second cycle while one is open (invariant 5) --------
    await assert.rejects(
      () => db.$transaction((tx) =>
        openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 2 }),
      ),
      (err: unknown) => {
        assert.ok(err instanceof CycleInvariantError);
        assert.equal((err as InstanceType<typeof CycleInvariantError>).code, "open_cycle_exists");
        return true;
      },
    );

    // --- Close the cycle, then open another (sequence increments) ----------
    const closed = await db.$transaction(async (tx) =>
      closeTaskWorkflowCycle(tx, {
        taskId: task.id,
        outcome: "changes_requested",
        closedWorkflowVersion: 2,
        candidateSha: "abc123",
      }),
    );
    assert.ok(closed);
    assert.equal(closed.status, "closed");
    assert.equal(closed.outcome, "changes_requested");
    assert.equal(closed.candidateSha, "abc123");
    assert.equal(closed.closedWorkflowVersion, 2);
    assert.equal(await getActiveTaskWorkflowCycle(task.id), null, "active pointer cleared");

    const cycle2 = await db.$transaction(async (tx) =>
      openTaskWorkflowCycle(tx, {
        taskId: task.id,
        openedWorkflowVersion: 3,
        openedByTransitionId: "transition-2",
      }),
    );
    assert.equal(cycle2.sequence, 2, "second cycle should be sequence 2");

    // --- Update candidate SHA on the active cycle (no new cycle) -----------
    const updated = await db.$transaction(async (tx) =>
      updateTaskWorkflowCycleCandidate(tx, {
        taskId: task.id,
        candidateSha: "def456",
        baseSha: "base-1",
      }),
    );
    assert.ok(updated);
    assert.equal(updated.candidateSha, "def456");
    assert.equal(updated.baseSha, "base-1");
    assert.equal(updated.sequence, 2, "update should not create a new cycle");

    // --- Same candidate SHA across two cycles (V23-36 property) ------------
    await db.$transaction(async (tx) =>
      closeTaskWorkflowCycle(tx, {
        taskId: task.id,
        outcome: "validation_failed",
        closedWorkflowVersion: 4,
        candidateSha: "shared-sha",
      }),
    );
    const cycle3 = await db.$transaction(async (tx) =>
      openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 5 }),
    );
    await db.$transaction(async (tx) =>
      updateTaskWorkflowCycleCandidate(tx, {
        taskId: task.id,
        candidateSha: "shared-sha",
      }),
    );
    assert.equal(cycle3.sequence, 3, "third cycle should be sequence 3");
    const cyclesWithSharedSha = await db.taskWorkflowCycle.findMany({
      where: { taskId: task.id, candidateSha: "shared-sha" },
      orderBy: { sequence: "asc" },
    });
    assert.equal(cyclesWithSharedSha.length, 2, "same SHA appears in two cycles");
    assert.equal(cyclesWithSharedSha[0].sequence, 2);
    assert.equal(cyclesWithSharedSha[0].status, "closed");
    assert.equal(cyclesWithSharedSha[1].sequence, 3);
    assert.equal(cyclesWithSharedSha[1].status, "open");

    // --- getTaskWorkflowCycle reads a specific cycle -----------------------
    const fetched = await getTaskWorkflowCycle(cycle1.id);
    assert.ok(fetched);
    assert.equal(fetched.id, cycle1.id);
    assert.equal(fetched.status, "closed");

    // --- Close the active cycle3, then ops on no-active-cycle are null -----
    await db.$transaction(async (tx) =>
      closeTaskWorkflowCycle(tx, { taskId: task.id, outcome: "completed", closedWorkflowVersion: 6 }),
    );
    const nullClose = await db.$transaction(async (tx) =>
      closeTaskWorkflowCycle(tx, { taskId: task.id, outcome: "completed" }),
    );
    assert.equal(nullClose, null, "closing a task with no active cycle returns null");
    const nullUpdate = await db.$transaction(async (tx) =>
      updateTaskWorkflowCycleCandidate(tx, { taskId: task.id, candidateSha: "x" }),
    );
    assert.equal(nullUpdate, null, "updating a task with no active cycle returns null");

    console.log("[orch01-cycle] lifecycle assertions PASS");
}

main().catch((error) => {
  console.error("[orch01-cycle] FAIL:", error);
  process.exit(1);
});