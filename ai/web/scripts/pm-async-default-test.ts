import { strict as assert } from "node:assert";
import { db } from "@/lib/db";
import {
  pmAsyncDispatchEnabled,
  runPmChannelWorkerOnce,
  sendOrQueueOpenClawPmChannelTurn,
} from "@/lib/agents/pm-channel-jobs";

// ZL-002 acceptance: async dispatch must be the default send path. With no
// PM_ASYNC_DISPATCH env var set, sendOrQueue must persist + enqueue and return
// 202 after DB commit (no synchronous gateway dispatch), and the run must be
// idempotent on the server messageId.
delete process.env.PM_ASYNC_DISPATCH;
process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS = "2";

async function main() {
  // Default (unset) is async.
  assert.equal(pmAsyncDispatchEnabled(), true, "async dispatch should be the default");

  // Explicit opt-out re-enables the legacy synchronous path.
  for (const off of ["0", "false", "no", "off"]) {
    process.env.PM_ASYNC_DISPATCH = off;
    assert.equal(pmAsyncDispatchEnabled(), false, `PM_ASYNC_DISPATCH=${off} should opt out of async`);
  }
  delete process.env.PM_ASYNC_DISPATCH;

  const nonce = `async-default-${Date.now()}`;
  const target = {
    kind: "direct" as const,
    agentSlug: "asdrubal",
    messageId: nonce,
  };
  const targetKey = `direct:asdrubal:${nonce}`;

  await db.pmChannelRun.deleteMany({ where: { targetKey } });

  const args = {
    gatewayPort: null,
    agentSlug: "asdrubal",
    sessionKey: `test:${nonce}`,
    kind: "direct" as const,
    text: "hello",
    actor: { id: "human-test", kind: "human" as const },
    replyTarget: target,
  };

  // Async default: returns 202 after persistence, run is queued, dispatch
  // has NOT happened yet (no gateway attempt awaited inline).
  const queued = await sendOrQueueOpenClawPmChannelTurn(args);
  assert.equal(queued.ok, true);
  assert.equal(queued.status, 202);

  const run = await db.pmChannelRun.findUniqueOrThrow({
    where: { targetKey },
    select: { id: true, status: true },
  });
  assert.equal(run.status, "queued", "run should be queued, not yet dispatched");

  const job = await db.pmChannelJob.findUniqueOrThrow({
    where: { runId: run.id },
    select: { status: true, attemptCount: true },
  });
  assert.equal(job.status, "queued");
  assert.equal(job.attemptCount, 0, "no dispatch attempt should run inline on the send path");

  // Idempotency: re-sending the same server messageId reuses the same run
  // row (targetKey upsert) instead of creating a duplicate.
  const requeued = await sendOrQueueOpenClawPmChannelTurn(args);
  assert.equal(requeued.status, 202);
  const runCount = await db.pmChannelRun.count({ where: { targetKey } });
  assert.equal(runCount, 1, "duplicate send must not create a second run for the same messageId");

  // The job is dispatched off-request by the worker, preserving retry on failure.
  const outcome = await runPmChannelWorkerOnce(`test:${nonce}`);
  assert.equal(outcome.claimed, true);
  if (outcome.claimed) assert.equal(outcome.ok, false, "no gateway port -> dispatch fails and retries");

  const afterDispatch = await db.pmChannelJob.findUniqueOrThrow({
    where: { runId: run.id },
    select: { status: true, attemptCount: true },
  });
  assert.equal(afterDispatch.status, "retryable");
  assert.equal(afterDispatch.attemptCount, 1);

  await db.pmChannelRun.deleteMany({ where: { targetKey } });
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log("pm async-default tests passed");
  })
  .catch(async (err) => {
    await db.$disconnect();
    console.error(err);
    process.exit(1);
  });
