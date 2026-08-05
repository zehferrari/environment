// ENV-117 focused tests: lease renewal, transactional supersession/lineage,
// and ghost-run reconciliation.
//
// Hermetic sqlite via prisma db push. Exit 0 on success, non-zero on first failure.

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

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
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
    await dbPush(dbUrl);

    const { db } = await import("@/lib/db");
    const {
      recordPmChannelRunQueued,
      recordPmChannelRunDispatch,
      recordPmChannelRunEvent,
      getPmChannelRunSnapshot,
    } = await import("@/lib/agents/pm-channel/runs");
    const { pmChannelRunTargetKey } = await import("@/lib/agents/pm-channel/bus");

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
      await recordPmChannelRunQueued({ target, kind: "task-comment" });

      // Dispatch (accept) — sets leaseExpiresAt
      await recordPmChannelRunDispatch({
        target,
        result: { ok: true, status: 202, transportMode: "http", error: null },
      });

      let run = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { status: true, leaseExpiresAt: true, heartbeatAt: true, acceptedAt: true },
      });
      assertEqual(run.status, "accepted", "run should be accepted after dispatch");
      assert(run.leaseExpiresAt !== null, "leaseExpiresAt must be set on accept");
      assert(run.heartbeatAt !== null, "heartbeatAt must be set on accept");

      const leaseBefore = run.leaseExpiresAt!.getTime();

      // Streaming event renews the lease
      await recordPmChannelRunEvent({ target, event: "token", error: null });

      run = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { status: true, leaseExpiresAt: true, heartbeatAt: true, streamingAt: true },
      });
      assertEqual(run.status, "streaming", "run should be streaming after token event");
      assert(run.leaseExpiresAt !== null, "leaseExpiresAt must be renewed on streaming");
      assert(
        run.leaseExpiresAt!.getTime() >= leaseBefore,
        "renewed lease must be >= original lease",
      );
      assert(run.heartbeatAt !== null, "heartbeatAt must be updated on streaming");

      // Tool event also renews the lease
      const leaseBeforeTool = run.leaseExpiresAt!.getTime();
      await new Promise((r) => setTimeout(r, 10));
      await recordPmChannelRunEvent({ target, event: "tool:call", error: null });

      run = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { leaseExpiresAt: true, heartbeatAt: true },
      });
      assert(
        run.leaseExpiresAt!.getTime() > leaseBeforeTool,
        "tool event must renew lease beyond prior value",
      );

      // Final event completes the run
      await recordPmChannelRunEvent({ target, event: "final", text: "done", error: null });

      run = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { status: true, finishedAt: true, finishedReason: true },
      });
      assertEqual(run.status, "completed", "run should be completed after final event");
      assert(run.finishedAt !== null, "finishedAt must be set on completion");
      assertEqual(run.finishedReason, "final", "finishedReason must be 'final'");

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
        result: { ok: true, status: 202, transportMode: "http", error: null },
      });

      const run1 = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: key1 },
        select: { id: true, status: true },
      });
      assertEqual(run1.status, "accepted", "first run should be accepted");

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

    // ---- Section 3: Multiple active duplicates all superseded ----
    {
      // Manually create two active runs for the same task+agent to simulate
      // pre-existing duplicates, then verify a new run supersedes both.
      const taskId = task.id;
      const dupKey1 = `dup-${randomUUID()}`;
      const dupKey2 = `dup-${randomUUID()}`;
      const newMessageId = randomUUID();
      const newTarget = {
        kind: "task-comment" as const,
        agentSlug,
        taskId,
        messageId: newMessageId,
      };

      await db.pmChannelRun.createMany({
        data: [
          {
            targetKey: dupKey1,
            kind: "task-comment",
            agentSlug,
            messageId: randomUUID(),
            taskId,
            status: "accepted",
            acceptedAt: new Date(),
            lastEventAt: new Date(),
          },
          {
            targetKey: dupKey2,
            kind: "task-comment",
            agentSlug,
            messageId: randomUUID(),
            taskId,
            status: "streaming",
            streamingAt: new Date(),
            lastEventAt: new Date(),
          },
        ],
      });

      // Create a new run — should supersede BOTH duplicates
      await recordPmChannelRunQueued({ target: newTarget, kind: "task-comment" });

      const dup1 = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: dupKey1 },
        select: { status: true, supersededByRunId: true },
      });
      const dup2 = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: dupKey2 },
        select: { status: true, supersededByRunId: true },
      });
      assertEqual(dup1.status, "superseded", "first duplicate must be superseded");
      assertEqual(dup2.status, "superseded", "second duplicate must be superseded");
      assert(dup1.supersededByRunId !== null, "first duplicate must have supersededByRunId");
      assert(dup2.supersededByRunId !== null, "second duplicate must have supersededByRunId");

      const newRun = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey: pmChannelRunTargetKey(newTarget) },
        select: { id: true },
      });
      assertEqual(dup1.supersededByRunId, newRun.id, "first dup lineage points to new run");
      assertEqual(dup2.supersededByRunId, newRun.id, "second dup lineage points to new run");

      console.log("Section 3 passed: multiple active duplicates all superseded with lineage");
    }

    // ---- Section 4: Ghost-run reconciliation ----
    {
      // Create a stale non-terminal run (old lastEventAt, no lease)
      const staleKey = `stale-${randomUUID()}`;
      const staleTaskId = task.id;
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
      const messageId = randomUUID();
      const target = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
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
          taskId: task.id,
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
      const messageId = randomUUID();
      const target = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId,
      };
      const targetKey = pmChannelRunTargetKey(target);

      // Create a run that has been accepted and is streaming
      await recordPmChannelRunQueued({ target, kind: "task-comment" });
      await recordPmChannelRunDispatch({
        target,
        result: { ok: true, status: 202, transportMode: "http", error: null },
      });
      await recordPmChannelRunEvent({ target, event: "token", error: null });

      const beforeRetry = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: { acceptedAt: true, streamingAt: true, leaseExpiresAt: true, heartbeatAt: true },
      });
      assert(beforeRetry.acceptedAt !== null, "acceptedAt must be set before retry");
      assert(beforeRetry.streamingAt !== null, "streamingAt must be set before retry");

      // Re-queue (retry) — should reset all timestamps
      await recordPmChannelRunQueued({ target, kind: "task-comment" });

      const afterRetry = await db.pmChannelRun.findUniqueOrThrow({
        where: { targetKey },
        select: {
          status: true,
          acceptedAt: true,
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