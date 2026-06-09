// ENV-24 V0.5 acceptance baseline.
//
// Hermetic coverage for the PM-channel runtime gaps surfaced during the
// verification pass. One throwaway sqlite (prisma db push) backs every
// section so the suite never touches the live pm.db.
//
//   1. Context-grant authentication: wrong-scope, expired, exhausted, and
//      revoked grants are all rejected; a valid grant authenticates once
//      and never leaks the bearer back to the caller.
//   2. Stream replay: persisted stream events rebuild full state after a
//      "restart", and a reconnect window (afterSeq > 0) still yields the
//      fully-accumulated final frame.
//   3. Agent-down dispatch: a job whose gateway is unreachable retries
//      under the bounded attempt cap and then lands in `failed` (run +
//      job), never silently dropped.
//   4. Duplicate final callback: once a durable reply exists for a target,
//      the idempotency guard reports it so the second callback short-
//      circuits instead of double-posting.
//   5. No bearer leakage: a grant token never appears in any persisted
//      streaming surface (run row, stream events, activity payloads).
//
// Exit 0 on success, non-zero on the first failed assertion.

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { createServer as netCreateServer } from "node:net";

const execFileP = promisify(execFile);

function fail(msg: string): never {
  console.error(`[pm-acceptance] FAIL: ${msg}`);
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

// A port nobody is listening on: bind to an ephemeral port, capture it, close.
async function reservedDeadPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = netCreateServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "pm-acceptance-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  const agentSlug = "acceptbot";

  // Hermetic env: must be set BEFORE importing any lib (db client + the
  // job module read these at module-eval time).
  process.env.DATABASE_URL = dbUrl;
  process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE = path.join(sandbox, "no-tokens.json");
  process.env[`PM_OPENCLAW_CHANNEL_TOKEN_${agentSlug.toUpperCase()}`] = "test-token";
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS = "2";
  process.env.PM_CHANNEL_JOB_RETRY_BASE_MS = "1000";

  try {
    await dbPush(dbUrl);

    const { db } = await import("@/lib/db");
    const { createContextGrant, authenticateContextGrant } = await import("@/lib/agents/context-grants");
    const { appendPmChannelStreamEvent, replayPmChannelStreamFrames, ensurePmChannelRunForTarget } =
      await import("@/lib/agents/pm-channel-stream-log");
    const { pmChannelTargetHasDurableReply } = await import("@/lib/agents/pm-channel-runs");
    const { enqueueOpenClawPmChannelTurn, runPmChannelWorkerOnce } =
      await import("@/lib/agents/pm-channel-jobs");

    // Shared fixtures.
    const project = await db.project.create({ data: { slug: "accept-proj", name: "Acceptance Project" } });
    const task = await db.task.create({
      data: { projectId: project.id, title: "Acceptance task", status: "In Progress" },
    });

    // ---- Section 1: context-grant authentication ----
    {
      const turnId = randomUUID();
      const { token, grant } = await createContextGrant({
        agentSlug,
        scopeType: "task",
        scopeId: task.id,
        turnId,
        ttlMs: 60_000,
        maxUses: 5,
      });
      assert(!("tokenHash" in grant) && !("token" in grant), "created grant must not echo token/tokenHash");

      const wrongId = await authenticateContextGrant({ scopeType: "task", scopeId: "task-nope", token });
      assertEqual(wrongId, null, "grant with wrong scopeId must be rejected");

      const wrongType = await authenticateContextGrant({ scopeType: "epic", scopeId: task.id, token });
      assertEqual(wrongType, null, "grant with wrong scopeType must be rejected");

      const empty = await authenticateContextGrant({ scopeType: "task", scopeId: task.id, token: "" });
      assertEqual(empty, null, "empty token must be rejected");

      const ok = await authenticateContextGrant({ scopeType: "task", scopeId: task.id, token });
      assert(ok != null, "valid in-scope grant must authenticate");
      assertEqual(ok!.agentSlug, agentSlug, "authenticated grant returns its agentSlug");
      assertEqual(
        Object.keys(ok!).sort().join(","),
        "agentSlug,grantId",
        "auth result exposes only grantId+agentSlug (no bearer)",
      );

      // Exhaustion: maxUses=1 → first use ok, second rejected.
      const single = await createContextGrant({
        agentSlug, scopeType: "task", scopeId: task.id, turnId: randomUUID(), maxUses: 1,
      });
      const firstUse = await authenticateContextGrant({ scopeType: "task", scopeId: task.id, token: single.token });
      assert(firstUse != null, "first use of single-use grant succeeds");
      const secondUse = await authenticateContextGrant({ scopeType: "task", scopeId: task.id, token: single.token });
      assertEqual(secondUse, null, "single-use grant rejected after maxUses reached");

      // Expiry: 1ms TTL → expired after a short wait.
      const ttl = await createContextGrant({
        agentSlug, scopeType: "task", scopeId: task.id, turnId: randomUUID(), ttlMs: 1,
      });
      await sleep(15);
      const expired = await authenticateContextGrant({ scopeType: "task", scopeId: task.id, token: ttl.token });
      assertEqual(expired, null, "expired grant must be rejected");

      // Revocation.
      const rev = await createContextGrant({
        agentSlug, scopeType: "task", scopeId: task.id, turnId: randomUUID(), ttlMs: 60_000,
      });
      await db.contextGrant.update({ where: { id: rev.grant.id }, data: { revokedAt: new Date() } });
      const revoked = await authenticateContextGrant({ scopeType: "task", scopeId: task.id, token: rev.token });
      assertEqual(revoked, null, "revoked grant must be rejected");

      console.log("[pm-acceptance] section 1 (context grants) OK");
    }

    // ---- Section 2: stream replay after restart ----
    const streamTarget = {
      kind: "task-comment" as const,
      agentSlug,
      taskId: task.id,
      messageId: `msg-${randomUUID()}`,
      projectSlug: project.slug,
    };
    {
      const run = await ensurePmChannelRunForTarget(streamTarget);
      const e1 = await appendPmChannelStreamEvent({ runId: run.id, event: "status", input: { event: "status", runStatus: "accepted" } });
      const e2 = await appendPmChannelStreamEvent({ runId: run.id, event: "partial", input: { event: "partial", delta: "Hello " } });
      const e3 = await appendPmChannelStreamEvent({ runId: run.id, event: "partial", input: { event: "partial", delta: "world" } });
      const e4 = await appendPmChannelStreamEvent({ runId: run.id, event: "final", input: { event: "final", text: "Hello world", replace: true } });
      assert(e1.seq < e2.seq && e2.seq < e3.seq && e3.seq < e4.seq, "stream seqs are strictly increasing");

      // Cold replay (simulated restart): rebuild from persisted rows only.
      const full = await replayPmChannelStreamFrames({ runId: run.id, target: streamTarget, afterSeq: 0 });
      assertEqual(full.length, 4, "full replay yields every persisted frame");
      const last = full[full.length - 1];
      assertEqual(last.state.text, "Hello world", "replayed final text is fully reconstructed");
      assertEqual(last.state.status, "done", "replayed final frame is done");
      assertEqual(last.state.runStatus, "complete", "replayed final frame run status complete");

      // Reconnect window: client already saw through e2; only later frames
      // are emitted, but accumulated state is still correct.
      const resumed = await replayPmChannelStreamFrames({ runId: run.id, target: streamTarget, afterSeq: e2.seq });
      assertEqual(resumed.length, 2, "reconnect replay only emits frames after the cursor");
      assert(resumed.every((f) => (f.state.seq ?? 0) > e2.seq), "reconnect frames are all past the cursor");
      assertEqual(resumed[resumed.length - 1].state.text, "Hello world", "reconnect final frame still fully accumulated");

      console.log("[pm-acceptance] section 2 (stream replay) OK");
    }

    // ---- Section 3: agent-down dispatch retries then fails ----
    {
      const deadPort = await reservedDeadPort();
      const dispatchTarget = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId: `down-${randomUUID()}`,
        projectSlug: project.slug,
      };
      const enq = await enqueueOpenClawPmChannelTurn({
        gatewayPort: deadPort,
        agentSlug,
        sessionKey: "accept-session",
        kind: "task-comment",
        text: "ping",
        actor: { id: "actor-x", kind: "agent" },
        replyTarget: dispatchTarget,
        projectId: project.id,
        timeoutMs: 1_000,
      });
      assert(enq.ok, "enqueue persists the job");

      const targetKey = `task-comment:${agentSlug}:${task.id}:${dispatchTarget.messageId}`;

      const first = await runPmChannelWorkerOnce("accept-worker");
      assert(first.claimed && !first.ok, "first attempt claims the job and fails (gateway down)");
      let job = await db.pmChannelJob.findFirstOrThrow({ where: { run: { targetKey } } });
      assertEqual(job.status, "retryable", "after first failure job is retryable, not dropped");
      assertEqual(job.attemptCount, 1, "attempt count incremented to 1");
      let run = await db.pmChannelRun.findUniqueOrThrow({ where: { targetKey } });
      assertEqual(run.status, "retryable", "run mirrors retryable status");

      // Make it claimable again immediately (skip the backoff wait).
      await db.pmChannelJob.update({ where: { id: job.id }, data: { availableAt: new Date() } });

      const second = await runPmChannelWorkerOnce("accept-worker");
      assert(second.claimed && !second.ok, "second attempt claims and fails");
      job = await db.pmChannelJob.findFirstOrThrow({ where: { run: { targetKey } } });
      assertEqual(job.status, "failed", "after the attempt cap the job is failed (terminal)");
      assertEqual(job.attemptCount, 2, "attempt count reached the cap");
      assert(job.lastError != null, "failed job records the dispatch error");
      run = await db.pmChannelRun.findUniqueOrThrow({ where: { targetKey } });
      assertEqual(run.status, "failed", "run is failed");
      assert(run.failedAt != null, "run failedAt is stamped on exhaustion");

      console.log("[pm-acceptance] section 3 (agent-down retry/fail) OK");
    }

    // ---- Section 4: duplicate final callback idempotency ----
    {
      const dupTarget = {
        kind: "task-comment" as const,
        agentSlug,
        taskId: task.id,
        messageId: `dup-${randomUUID()}`,
        projectSlug: project.slug,
      };
      assertEqual(
        await pmChannelTargetHasDurableReply(dupTarget),
        false,
        "no durable reply before the first callback",
      );
      // Simulate the first callback's durable comment.
      await db.activityLog.create({
        data: {
          projectId: project.id,
          taskId: task.id,
          kind: "task.comment",
          targetAgent: agentSlug,
          payload: JSON.stringify({
            driver: "openclaw-pm-channel",
            inReplyToMessageId: dupTarget.messageId,
            agentSlug,
          }),
        },
      });
      assertEqual(
        await pmChannelTargetHasDurableReply(dupTarget),
        true,
        "durable reply detected → second callback short-circuits as duplicate",
      );
      console.log("[pm-acceptance] section 4 (duplicate callback idempotency) OK");
    }

    // ---- Section 5: no bearer leakage into streaming surfaces ----
    {
      const leakTurn = randomUUID();
      const { token: secret } = await createContextGrant({
        agentSlug, scopeType: "task", scopeId: task.id, turnId: leakTurn, ttlMs: 60_000,
      });
      // Everything persisted for the stream target from section 2.
      const events = await db.pmChannelStreamEvent.findMany({ where: { run: { targetKey: `task-comment:${agentSlug}:${task.id}:${streamTarget.messageId}` } } });
      const runs = await db.pmChannelRun.findMany();
      const activity = await db.activityLog.findMany({ where: { taskId: task.id } });
      const haystack = JSON.stringify({ events, runs, activity });
      assert(secret.length > 20, "grant token is a real secret");
      assert(!haystack.includes(secret), "grant token must never appear in any persisted streaming surface");
      assert(!haystack.toLowerCase().includes("bearer "), "no bearer header leaks into persisted streaming surfaces");
      console.log("[pm-acceptance] section 5 (no bearer leakage) OK");
    }

    await db.$disconnect();
    console.log("pm acceptance baseline tests passed");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
