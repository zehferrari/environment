import { strict as assert } from "node:assert";
import { db } from "@/lib/db";
import {
  createContextGrant,
  authenticateContextGrant,
} from "@/lib/agents/context-grants";
import {
  replayPmChannelStreamFrames,
} from "@/lib/agents/pm-channel-stream-log";
import {
  runPmChannelWorkerOnce,
  sendOrQueueOpenClawPmChannelTurn,
} from "@/lib/agents/pm-channel-jobs";

process.env.PM_ASYNC_DISPATCH = "1";
process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS = "2";

async function main() {
  const nonce = `p0-${Date.now()}`;
  const target = {
    kind: "direct" as const,
    agentSlug: "asdrubal",
    messageId: nonce,
  };
  const targetKey = `direct:asdrubal:${nonce}`;

  await db.pmChannelRun.deleteMany({ where: { targetKey } });
  await db.contextGrant.deleteMany({ where: { turnId: nonce } });

  const queued = await sendOrQueueOpenClawPmChannelTurn({
    gatewayPort: null,
    agentSlug: "asdrubal",
    sessionKey: `test:${nonce}`,
    kind: "direct",
    text: "hello",
    actor: { id: "human-test", kind: "human" },
    replyTarget: target,
  });
  assert.equal(queued.ok, true);
  assert.equal(queued.status, 202);

  const run = await db.pmChannelRun.findUniqueOrThrow({
    where: { targetKey },
    select: { id: true, status: true },
  });
  assert.equal(run.status, "queued");

  const job = await db.pmChannelJob.findUniqueOrThrow({
    where: { runId: run.id },
    select: { status: true, attemptCount: true },
  });
  assert.equal(job.status, "queued");
  assert.equal(job.attemptCount, 0);

  const replay = await replayPmChannelStreamFrames({ runId: run.id, target, afterSeq: 0 });
  assert.equal(replay.length, 1);
  assert.equal(replay[0]?.event, "status");
  assert.equal(replay[0]?.state.runStatus, "queued");

  const outcome = await runPmChannelWorkerOnce(`test:${nonce}`);
  assert.equal(outcome.claimed, true);
  if (outcome.claimed) assert.equal(outcome.ok, false);

  const retryable = await db.pmChannelJob.findUniqueOrThrow({
    where: { runId: run.id },
    select: { status: true, attemptCount: true, lastError: true },
  });
  assert.equal(retryable.status, "retryable");
  assert.equal(retryable.attemptCount, 1);
  assert.match(retryable.lastError ?? "", /no gateway port/);

  const wrongScope = await createContextGrant({
    agentSlug: "asdrubal",
    scopeType: "task",
    scopeId: `task-${nonce}`,
    turnId: nonce,
    maxUses: 1,
  });
  assert.equal(
    await authenticateContextGrant({
      scopeType: "project",
      scopeId: `task-${nonce}`,
      token: wrongScope.token,
    }),
    null,
  );

  const grant = await createContextGrant({
    agentSlug: "asdrubal",
    scopeType: "task",
    scopeId: `task-${nonce}`,
    turnId: nonce,
    maxUses: 1,
  });
  const firstUse = await authenticateContextGrant({
    scopeType: "task",
    scopeId: `task-${nonce}`,
    token: grant.token,
  });
  assert.equal(firstUse?.agentSlug, "asdrubal");
  const secondUse = await authenticateContextGrant({
    scopeType: "task",
    scopeId: `task-${nonce}`,
    token: grant.token,
  });
  assert.equal(secondUse, null);

  await db.pmChannelRun.deleteMany({ where: { targetKey } });
  await db.contextGrant.deleteMany({ where: { turnId: nonce } });
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log("p0 kernel tests passed");
  })
  .catch(async (err) => {
    await db.$disconnect();
    console.error(err);
    process.exit(1);
  });
