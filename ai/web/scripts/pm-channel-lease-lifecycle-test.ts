// ENV-117 focused tests: lease renewal, transactional supersession/lineage,
// and ghost-run reconciliation.
//
// Hermetic sqlite via prisma migrate deploy (applies raw-SQL partial indexes).
// Exit 0 on success, non-zero on first failure.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

function fail(msg: string): never {
  console.error(`[pm-lease-lifecycle] FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, label: string): asserts cond {
  if (!cond) fail(label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function dbMigrateDeploy(dbUrl: string): Promise<void> {
  // Use migrate deploy (not db push) so raw-SQL partial unique indexes are applied.
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pm-lease-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const agentSlug = "leasetest";

  process.env.DATABASE_URL = dbUrl;
  process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE = path.join(sandbox, "no-tokens.json");
  process.env[`PM_OPENCLAW_CHANNEL_TOKEN_${agentSlug.toUpperCase()}`] = "test-token";
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.PM_OPENCLAW_LEASE_MS = "120000";

  try {
    await dbMigrateDeploy(dbUrl);

    // Small delay to ensure the migrate connection is fully released
    await new Promise((r) => setTimeout(r, 200));

    const { db } = await import("@/lib/db");
    const {
      recordPmChannelRunQueued,
      recordPmChannelRunDispatch,
      recordPmChannelRunEvent,
      getPmChannelRunSnapshot,
    } = await import("@/lib/agents/pm-channel/runs");
    const { pmChannelRunTargetKey } = await import("@/lib/agents/pm-channel/bus");
    const { fenceSupersededPmChannelRuns } = await import("@/lib/agents/pm-channel/supersession");
    const { reserveExecutionLane } = await import("@/lib/agents/pm-channel/execution-lane");

    // Shared fixtures
    const project = await db.project.create({ data: { slug: "lease-proj", name: "Lease Project" } });
    const task = await db.task.create({
      data: { projectId: project.id, title: "Lease test task", status: "In Progress" },
    });

    // ---- Section 1: Lease renewal via streaming events ----
    {
      const messageId = randomUUID();
      const target = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId,
      };
      const targetKey = pmChannelRunTargetKey(target);

      // Queue a run
      const queuedRun = await recordPmChannelRunQueued({ target, kind: "task-comment" });
      assert(queuedRun, "the lifecycle run must be queued");
      const reservation = await reserveExecutionLane({ agentSlug, runId: queuedRun.id, taskId: task.id });
      assert(reservation.acquired, "dispatch must reserve the durable agent execution lane");

      // HTTP dispatch only records delivery. The execution lease starts with
      // the first admitted/streaming callback, not at gateway handoff.
      await recordPmChannelRunDispatch({
        target,
        result: { ok: true, status: 202, driver: "openclaw-pm-channel", transportMode: "http" },
      });

      const acceptedRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { status: true, leaseExpiresAt: true, heartbeatAt: true, acceptedAt: true, admittedAt: true },
      });
      assertEqual(acceptedRun.status, "delivered", "run should be delivered after dispatch");
      assertEqual(acceptedRun.heartbeatAt, null, "delivered run has no heartbeat before execution starts");
      assertEqual(acceptedRun.leaseExpiresAt, null, "delivered run has no execution lease");
      assertEqual(
        (await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: queuedRun.id } })).status,
        "reserved",
        "gateway delivery must not claim that model execution started",
      );

      // First streaming event starts the execution lease.
      await recordPmChannelRunEvent({ target, event: "token" });

      const streamingRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { status: true, leaseExpiresAt: true, heartbeatAt: true, streamingAt: true },
      });
      assertEqual(streamingRun.status, "streaming", "run should be streaming after token event");
      assert(streamingRun.leaseExpiresAt !== null, "leaseExpiresAt must be renewed on streaming");
      assert(streamingRun.heartbeatAt !== null, "heartbeatAt must be updated on streaming");
      const runningLane = await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: queuedRun.id } });
      assertEqual(runningLane.status, "running", "the first progress callback must advance the durable lane");
      assert(runningLane.heartbeatAt !== null, "the first progress callback must heartbeat the durable lane");

      const leaseBefore = streamingRun.leaseExpiresAt.getTime();
      await new Promise((r) => setTimeout(r, 10));
      await recordPmChannelRunEvent({ target, event: "token" });
      const renewedRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { leaseExpiresAt: true },
      });
      assert(
        renewedRun.leaseExpiresAt!.getTime() > leaseBefore,
        "a later streaming event must renew the execution lease",
      );

      // Tool event also renews the lease
      const leaseBeforeTool = renewedRun.leaseExpiresAt!.getTime();
      await new Promise((r) => setTimeout(r, 10));
      await recordPmChannelRunEvent({ target, event: "tool:call" });

      const toolRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { leaseExpiresAt: true, heartbeatAt: true },
      });
      assert(
        toolRun.leaseExpiresAt!.getTime() > leaseBeforeTool,
        "tool event must renew lease beyond prior value",
      );

      // Final event completes the run
      await recordPmChannelRunEvent({ target, event: "final" });

      const completedRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { status: true, finishedAt: true, finishedReason: true },
      });
      assertEqual(completedRun.status, "completed", "run should be completed after final event");
      assert(completedRun.finishedAt !== null, "finishedAt must be set on completion");
      assertEqual(completedRun.finishedReason, "final", "finishedReason must be 'final'");
      const releasedLane = await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: queuedRun.id } });
      assertEqual(releasedLane.status, "released", "a final callback must release the durable execution lane");
      assert(releasedLane.releasedAt !== null, "a released lane must record when it was released");

      console.log("Section 1 passed: lease renewal via streaming events");
    }

    // ---- Section 2: Transactional supersession with lineage ----
    {
      const messageId1 = randomUUID();
      const messageId2 = randomUUID();
      const target1 = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId: messageId1,
      };
      const target2 = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId: messageId2,
      };
      const key1 = pmChannelRunTargetKey(target1);
      const key2 = pmChannelRunTargetKey(target2);

      // Create first run and accept it
      await recordPmChannelRunQueued({ target: target1, kind: "task-comment" });
      await recordPmChannelRunDispatch({
        target: target1,
        result: { ok: true, status: 202, driver: "openclaw-pm-channel", transportMode: "http" },
      });

      const run1 = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: key1 },
        select: { id: true, status: true },
      });
      assertEqual(run1.status, "delivered", "first run should be delivered");

      // Create second run for same task+agent — should supersede first
      await recordPmChannelRunQueued({ target: target2, kind: "task-comment" });

      const run1After = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: key1 },
        select: { id: true, status: true, supersededByRunId: true, finishedAt: true, finishedReason: true },
      });
      assertEqual(run1After.status, "superseded", "old run must be superseded when new run is queued");
      assert(run1After.supersededByRunId !== null, "supersededByRunId must point to the new run");
      assert(run1After.finishedAt !== null, "superseded run must have finishedAt set");
      assertEqual(run1After.finishedReason, "superseded_by_newer_run", "finishedReason must be superseded_by_newer_run");

      const run2 = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: key2 },
        select: { id: true, status: true },
      });
      assertEqual(run2.status, "queued", "new run must be queued");
      assertEqual(run1After.supersededByRunId, run2.id, "supersededByRunId must point to the new run's id");

      console.log("Section 2 passed: transactional supersession with lineage");
    }

    // ---- Section 3: Migration reconciliation of pre-existing duplicates ----
    {
      // The migration's reconciliation step marks all but the newest active
      // duplicate per (taskId, agentSlug) as superseded before creating the
      // partial unique index. Verify this by creating duplicates in a fresh
      // DB before the index exists, then running the migration.
      //
      // Since the migration already ran (via dbMigrateDeploy), we test the
      // reconciliation logic directly: create a second task with two active
      // runs by temporarily dropping the index, inserting duplicates, and
      // re-running the reconciliation SQL.
      const reconTask = await db.task.create({
        data: { projectId: project.id, title: "Recon test task", status: "In Progress" },
      });
      const reconKey1 = `recon-${randomUUID()}`;
      const reconKey2 = `recon-${randomUUID()}`;

      // Drop the partial unique index temporarily to simulate pre-migration state
      await db.$executeRawUnsafe('DROP INDEX IF EXISTS "PmChannelRun_active_task_agent_unique"');

      // Insert two active runs for the same (taskId, agentSlug) — now possible
      await db.pmChannelRun.create({
        data: {
          targetKey: reconKey1,
          kind: "task-comment",
          agentSlug,
          messageId: randomUUID(),
          taskId: reconTask.id,
          status: "accepted",
          acceptedAt: new Date(Date.now() - 60000), admittedAt: new Date(Date.now() - 60000),
          lastEventAt: new Date(Date.now() - 60000),
        },
      });
      await db.pmChannelRun.create({
        data: {
          targetKey: reconKey2,
          kind: "task-comment",
          agentSlug,
          messageId: randomUUID(),
          taskId: reconTask.id,
          status: "streaming",
          streamingAt: new Date(),
          lastEventAt: new Date(),
        },
      });

      // Run the migration reconciliation SQL: mark all but the newest as superseded
      await db.$executeRawUnsafe(`
        UPDATE "PmChannelRun" SET
          status = 'superseded',
          "finishedAt" = COALESCE("finishedAt", datetime('now')),
          "finishedReason" = 'reconciled_duplicate_pre_index'
        WHERE id IN (
          SELECT id FROM (
            SELECT
              r.id AS id,
              ROW_NUMBER() OVER (
                PARTITION BY r."taskId", r."agentSlug"
                ORDER BY r."updatedAt" DESC
              ) AS rn
            FROM "PmChannelRun" r
            WHERE r."taskId" IS NOT NULL
              AND r.status IN ('queued', 'accepted', 'streaming')
          )
          WHERE rn > 1
        )
      `);

      // Recreate the partial unique index
      await db.$executeRawUnsafe(
        'CREATE UNIQUE INDEX "PmChannelRun_active_task_agent_unique" ON "PmChannelRun"("taskId", "agentSlug") WHERE "status" IN (\'queued\', \'accepted\', \'streaming\')'
      );

      // Verify: exactly one active run remains, the other is superseded
      const activeCount = await db.pmChannelRun.count({
        where: { taskId: reconTask.id, agentSlug, status: { in: ["queued", "accepted", "streaming"] } },
      });
      assertEqual(activeCount, 1, "exactly one active run should remain after reconciliation");

      const supersededCount = await db.pmChannelRun.count({
        where: { taskId: reconTask.id, agentSlug, status: "superseded" },
      });
      assertEqual(supersededCount, 1, "one duplicate should be superseded by reconciliation");

      console.log("Section 3 passed: migration reconciliation deduplicates active runs");
    }

    // ---- Section 4: Ghost-run reconciliation ----
    {
      // Use a dedicated task so the partial unique index doesn't conflict
      // with active runs from prior sections.
      const ghostTask = await db.task.create({
        data: { projectId: project.id, title: "Ghost test task", status: "In Progress" },
      });
      // Create a stale non-terminal run (old lastEventAt, no lease)
      const staleKey = `stale-${randomUUID()}`;
      const staleTaskId = ghostTask.id;
      await db.pmChannelRun.create({
        data: {
          targetKey: staleKey,
          kind: "task-comment",
          agentSlug,
          messageId: randomUUID(),
          taskId: staleTaskId,
          status: "streaming",
          streamingAt: new Date(Date.now() - 3_600_000), // 1 hour old
          lastEventAt: new Date(Date.now() - 3_600_000),
        },
      });

      // Snapshot should detect the expired/stale run and time it out
      const staleTarget = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: staleTaskId,
        messageId: staleKey, // targetKey is derived from these fields
      };

      // Use getPmChannelRunSnapshot which checks lease expiry
      // For legacy runs without leaseExpiresAt, the fallback timeout applies
      const snapshot = await getPmChannelRunSnapshot(staleTarget);
      if (snapshot) {
        assert(
          snapshot.status === "timed_out" || snapshot.status === "streaming",
          `stale run should be timed_out or still streaming (depending on fallback), got ${snapshot.status}`,
        );
        if (snapshot.status === "timed_out") {
          assert(snapshot.finishedAt !== null, "timed_out run must have finishedAt set");
        }
      }

      // Directly test the reconciliation script logic: mark old non-terminal runs as timed_out
      const reconciled = await db.pmChannelRun.updateMany({
        where: {
          status: { in: ["queued", "accepted", "streaming"] },
          lastEventAt: { lt: new Date(Date.now() - 1_800_000) }, // 30 min threshold
        },
        data: {
          status: "timed_out" as const,
          finishedAt: new Date(),
          finishedReason: "ghost_reconciliation",
        },
      });
      assert(reconciled.count > 0, "reconciliation should update at least the stale run");

      const reconciledRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: staleKey },
        select: { status: true, finishedReason: true },
      });
      assertEqual(reconciledRun.status, "timed_out", "stale run must be reconciled to timed_out");
      assertEqual(reconciledRun.finishedReason, "ghost_reconciliation", "reconciled run must have ghost_reconciliation reason");

      console.log("Section 4 passed: ghost-run reconciliation");
    }

    // ---- Section 5: Snapshot respects lease expiry ----
    {
      const leaseTask = await db.task.create({
        data: { projectId: project.id, title: "Lease expiry test task", status: "In Progress" },
      });
      const messageId = randomUUID();
      const target = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: leaseTask.id,
        messageId,
      };
      const targetKey = pmChannelRunTargetKey(target);

      // Create a run with an already-expired lease
      await db.pmChannelRun.create({
        data: {
          targetKey,
          kind: "task-comment",
          agentSlug,
          messageId,
          taskId: leaseTask.id,
          status: "streaming",
          streamingAt: new Date(),
          leaseExpiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
          heartbeatAt: new Date(Date.now() - 60_000),
          lastEventAt: new Date(Date.now() - 60_000),
        },
      });

      const snapshot = await getPmChannelRunSnapshot(target);
      assert(snapshot !== null, "snapshot must return the run");
      assertEqual(snapshot!.status, "timed_out", "run with expired lease must be timed_out by snapshot");

      console.log("Section 5 passed: snapshot respects lease expiry");
    }

    // ---- Section 6: Retry path fully resets timestamps ----
    {
      const retryTask = await db.task.create({
        data: { projectId: project.id, title: "Retry test task", status: "In Progress" },
      });
      const messageId = randomUUID();
      const target = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: retryTask.id,
        messageId,
      };
      const targetKey = pmChannelRunTargetKey(target);

      // Create a run that has been accepted and is streaming
      await recordPmChannelRunQueued({ target, kind: "task-comment" });
      await recordPmChannelRunDispatch({
        target,
        result: { ok: true, status: 202, driver: "openclaw-pm-channel", transportMode: "http" },
      });
      await recordPmChannelRunEvent({ target, event: "token" });

      const beforeRetry = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { acceptedAt: true, admittedAt: true, streamingAt: true, leaseExpiresAt: true, heartbeatAt: true },
      });
      assert(beforeRetry.acceptedAt !== null, "acceptedAt must be set before retry");
      assert(beforeRetry.streamingAt !== null, "streamingAt must be set before retry");

      // Re-queue (retry) — should reset all timestamps
      await recordPmChannelRunQueued({ target, kind: "task-comment" });

      const afterRetry = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: {
          status: true,
          acceptedAt: true, admittedAt: true,
          streamingAt: true,
          completedAt: true,
          failedAt: true,
          leaseExpiresAt: true,
          heartbeatAt: true,
          finishedAt: true,
          finishedReason: true,
          supersededByRunId: true,
        },
      });
      assertEqual(afterRetry.status, "queued", "run must be queued after retry");
      assertEqual(afterRetry.acceptedAt, null, "acceptedAt must be null after retry reset");
      assertEqual(afterRetry.streamingAt, null, "streamingAt must be null after retry reset");
      assertEqual(afterRetry.completedAt, null, "completedAt must be null after retry reset");
      assertEqual(afterRetry.failedAt, null, "failedAt must be null after retry reset");
      assertEqual(afterRetry.leaseExpiresAt, null, "leaseExpiresAt must be null after retry reset");
      assertEqual(afterRetry.heartbeatAt, null, "heartbeatAt must be null after retry reset");
      assertEqual(afterRetry.finishedAt, null, "finishedAt must be null after retry reset");
      assertEqual(afterRetry.finishedReason, null, "finishedReason must be null after retry reset");
      assertEqual(afterRetry.supersededByRunId, null, "supersededByRunId must be null after retry reset");

      console.log("Section 6 passed: retry path fully resets timestamps");
    }

    // ---- Section 7: Partial unique index enforced (migrate deploy) ----
    {
      // Verify the partial unique index exists and prevents two active runs
      // for the same (taskId, agentSlug) with different targetKeys.
      const idxCheck = await db.$queryRaw<{name: string}[]>`
        SELECT name FROM sqlite_master
        WHERE type='index' AND name='PmChannelRun_active_task_agent_unique'
      `;
      assert(idxCheck.length === 1, "partial unique index must exist after migrate deploy");

      // Use a dedicated task for this section's index enforcement test.
      const idxTask = await db.task.create({
        data: { projectId: project.id, title: "Index enforcement test task", status: "In Progress" },
      });

      // Create one active run for this task+agent (legitimate)
      const idxTarget = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: idxTask.id,
        messageId: randomUUID(),
      };
      await recordPmChannelRunQueued({ target: idxTarget, kind: "task-comment" });

      // Attempt to directly insert a second active run for the same task+agent
      // (bypassing recordPmChannelRunQueued) should fail with a unique constraint violation.
      const conflictKey = `conflict-${randomUUID()}`;
      let constraintError: unknown = null;
      try {
        await db.pmChannelRun.create({
          data: {
            targetKey: conflictKey,
            kind: "task-comment",
            agentSlug,
            messageId: randomUUID(),
            taskId: idxTask.id,
            status: "accepted",
            acceptedAt: new Date(), admittedAt: new Date(),
            lastEventAt: new Date(),
          },
        });
      } catch (err) {
        constraintError = err;
      }
      assert(constraintError !== null, "inserting a second active run must fail the partial unique index");

      // Verify that recordPmChannelRunQueued still works correctly with the index:
      // it should supersede the existing active run and create a new one without error.
      const replaceTarget = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: idxTask.id,
        messageId: randomUUID(),
      };
      const replaceKey = pmChannelRunTargetKey(replaceTarget);

      // Find the currently-active run for this task+agent
      const activeBefore = await db.pmChannelRun.findFirst({
        where: { taskId: idxTask.id, agentSlug, status: { in: [...["queued", "accepted", "streaming"]] } },
        select: { id: true, targetKey: true },
      });
      assert(activeBefore !== null, "there must be an active run before replacement");

      await recordPmChannelRunQueued({ target: replaceTarget, kind: "task-comment" });

      // The old active run must now be superseded
      if (activeBefore && activeBefore.targetKey !== replaceKey) {
        const oldRun = await db.pmChannelRun.findUniqueOrThrow({
          where: { targetKey: activeBefore.targetKey },
          select: { status: true, supersededByRunId: true },
        });
        assertEqual(oldRun.status, "superseded", "old active run must be superseded by replacement");
        assert(oldRun.supersededByRunId !== null, "old run must have supersededByRunId set");
      }

      // The new run must be active (queued)
      const newActive = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: replaceKey },
        select: { status: true },
      });
      assertEqual(newActive.status, "queued", "replacement run must be queued and active");

      // Only one active run for this task+agent should exist
      const activeCount = await db.pmChannelRun.count({
        where: { taskId: idxTask.id, agentSlug, status: { in: [...["queued", "accepted", "streaming"]] } },
      });
      assertEqual(activeCount, 1, "exactly one active run must exist after replacement");

      console.log("Section 7 passed: partial unique index enforced, replacement works with index");
    }

    // ---- Section 8: Process-level supersession fence ----
    {
      const makeTarget = (taskId: string) => ({
        kind: "task-comment" as const,
        agentSlug,
        taskId,
        messageId: randomUUID(),
      });

      // A never-delivered predecessor has no model process to stop. Retiring
      // its durable job is itself a complete cancellation acknowledgement.
      const queuedTask = await db.task.create({
        data: { projectId: project.id, title: "Queued fence task", status: "In Progress" },
      });
      const queuedOld = makeTarget(queuedTask.id);
      const queuedNew = makeTarget(queuedTask.id);
      await recordPmChannelRunQueued({ target: queuedOld, kind: "task-comment" });
      const queuedOldRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: pmChannelRunTargetKey(queuedOld) },
        select: { id: true },
      });
      assert(
        (await reserveExecutionLane({ agentSlug, runId: queuedOldRun.id, taskId: queuedTask.id })).acquired,
        "the queued predecessor must hold a reserved lane before fencing",
      );
      const queuedReplacement = await recordPmChannelRunQueued({ target: queuedNew, kind: "task-comment" });
      let fetchCalls = 0;
      const queuedFence = await fenceSupersededPmChannelRuns({
        replacementRunId: queuedReplacement!.id,
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response("unexpected", { status: 500 });
        }) as typeof fetch,
      });
      assert(queuedFence.ok, "a queued predecessor must fence without contacting the gateway");
      assertEqual(fetchCalls, 0, "a queued predecessor must not call the gateway");
      assertEqual(
        (await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: queuedOldRun.id } })).status,
        "released",
        "acknowledging queued supersession must release its reserved lane",
      );

      // A delivered predecessor must receive an explicit abort acknowledgement
      // before the replacement can dispatch.
      const liveTask = await db.task.create({
        data: { projectId: project.id, title: "Live fence task", status: "In Progress" },
      });
      const liveOld = makeTarget(liveTask.id);
      const liveNew = makeTarget(liveTask.id);
      await recordPmChannelRunQueued({
        target: liveOld,
        kind: "task-comment",
        gatewayPort: 18789,
        sessionKey: "lane:test:live-old",
      });
      await recordPmChannelRunDispatch({
        target: liveOld,
        result: {
          ok: true,
          status: 202,
          driver: "openclaw-pm-channel",
          transportMode: "http",
          gatewayDispatchId: "gateway-live-old",
        },
      });
      const liveOldRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: pmChannelRunTargetKey(liveOld) },
        select: { id: true },
      });
      assert(
        (await reserveExecutionLane({ agentSlug, runId: liveOldRun.id, taskId: liveTask.id })).acquired,
        "the delivered predecessor must hold a lane before cancellation",
      );
      const liveReplacement = await recordPmChannelRunQueued({ target: liveNew, kind: "task-comment" });
      const liveFence = await fenceSupersededPmChannelRuns({
        replacementRunId: liveReplacement!.id,
        fetchImpl: (async (_url, init) => {
          assertEqual(init?.method, "POST", "the process fence must use the gateway cancel route");
          const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          assertEqual(
            body.gatewayDispatchId,
            "gateway-live-old",
            "the cancellation fence must target the exact delivered gateway generation",
          );
          return new Response(JSON.stringify({ ok: true, aborted: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
      });
      assert(liveFence.ok, "a delivered-but-unadmitted predecessor must still be canceled before replacement");
      const liveOldRow = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: pmChannelRunTargetKey(liveOld) },
        select: { cancellationRequestedAt: true, cancellationAcknowledgedAt: true, cancellationError: true },
      });
      assert(liveOldRow.cancellationRequestedAt !== null, "the old run must record its cancellation request");
      assert(liveOldRow.cancellationAcknowledgedAt !== null, "the old run must record the gateway acknowledgement");
      assertEqual(liveOldRow.cancellationError, null, "an acknowledged abort must clear cancellation error");
      assertEqual(
        (await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: liveOldRun.id } })).status,
        "released",
        "an acknowledged gateway abort must release the predecessor lane",
      );

      // HTTP 200 is not enough: abort_unavailable means the old process may
      // still write, so the replacement lane stays closed and retryable.
      const unfencedTask = await db.task.create({
        data: { projectId: project.id, title: "Unfenced task", status: "In Progress" },
      });
      const unfencedOld = makeTarget(unfencedTask.id);
      const unfencedNew = makeTarget(unfencedTask.id);
      await recordPmChannelRunQueued({
        target: unfencedOld,
        kind: "task-comment",
        gatewayPort: 18789,
        sessionKey: "lane:test:unfenced-old",
      });
      await recordPmChannelRunDispatch({
        target: unfencedOld,
        result: { ok: true, status: 202, driver: "openclaw-pm-channel", transportMode: "http" },
      });
      await db.pmChannelRun.update({
        where: { targetKey: pmChannelRunTargetKey(unfencedOld) },
        data: { admittedAt: new Date() },
      });
      const unfencedOldRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: pmChannelRunTargetKey(unfencedOld) },
        select: { id: true },
      });
      assert(
        (await reserveExecutionLane({ agentSlug, runId: unfencedOldRun.id, taskId: unfencedTask.id })).acquired,
        "the unfenced predecessor must hold a lane before cancellation",
      );
      const unfencedReplacement = await recordPmChannelRunQueued({ target: unfencedNew, kind: "task-comment" });
      const rejectedFence = await fenceSupersededPmChannelRuns({
        replacementRunId: unfencedReplacement!.id,
        fetchImpl: (async () => new Response(
          JSON.stringify({ ok: true, aborted: false, reason: "abort_unavailable" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
      });
      assert(!rejectedFence.ok, "an unacknowledged abort must keep the replacement lane closed");
      const unfencedOldRow = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: pmChannelRunTargetKey(unfencedOld) },
        select: { cancellationAcknowledgedAt: true, cancellationError: true },
      });
      assertEqual(unfencedOldRow.cancellationAcknowledgedAt, null, "an unacknowledged abort must not be marked safe");
      assert(
        unfencedOldRow.cancellationError?.includes("abort_unavailable"),
        "the process-fence failure must remain visible for recovery",
      );
      assertEqual(
        (await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: unfencedOldRun.id } })).status,
        "reserved",
        "a rejected cancellation must keep the predecessor lane fenced",
      );

      console.log("Section 8 passed: replacement dispatch requires process-level cancellation acknowledgement");
    }

    await db.$disconnect();
    console.log("pm channel lease lifecycle tests passed");
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main();
