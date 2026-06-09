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
  runPmChannelWorkerDrain,
  runPmChannelWorkerOnce,
  sendOrQueueOpenClawPmChannelTurn,
} from "@/lib/agents/pm-channel-jobs";
import { extractActionPlanSteps } from "@/lib/tasks/action-plan-subtasks";

process.env.PM_ASYNC_DISPATCH = "1";
process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS = "2";

async function main() {
  assert.deepEqual(
    extractActionPlanSteps([
      "## Action Plan",
      "### Inputs",
      "- Client type",
      "- Geography",
      "### Rule logic",
      "- Hard override rules",
      "### Deliverables",
      "- Migration for risk tables.",
      "- Engine service with rating tests.",
      "- All commits prefixed greenID.",
    ].join("\n")),
    [
      "Migration for risk tables",
      "Engine service with rating tests",
    ],
  );
  assert.deepEqual(
    extractActionPlanSteps([
      "## Action Plan",
      "- Read files",
      "- Patch code",
      "- Test",
    ].join("\n")),
    [],
  );

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

  const immediateDrain = await runPmChannelWorkerDrain(`test-drain-immediate:${nonce}`);
  assert.equal(immediateDrain.claimed, 0, "retryable job should not drain before availableAt");

  await db.pmChannelJob.update({
    where: { runId: run.id },
    data: { availableAt: new Date(Date.now() - 1000) },
  });
  const delayedDrain = await runPmChannelWorkerDrain(`test-drain-ready:${nonce}`, 5);
  assert.equal(delayedDrain.claimed, 1, "drain should process a retryable job after availableAt");
  assert.equal(delayedDrain.retryableOrFailed, 1);

  const retried = await db.pmChannelJob.findUniqueOrThrow({
    where: { runId: run.id },
    select: { status: true, attemptCount: true },
  });
  assert.equal(retried.status, "retryable");
  assert.equal(retried.attemptCount, 2);

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

  // An expired grant must not authenticate even with unused capacity remaining.
  const expiring = await createContextGrant({
    agentSlug: "asdrubal",
    scopeType: "task",
    scopeId: `task-${nonce}`,
    turnId: nonce,
    maxUses: 5,
  });
  await db.contextGrant.update({
    where: { id: expiring.grant.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  const expiredUse = await authenticateContextGrant({
    scopeType: "task",
    scopeId: `task-${nonce}`,
    token: expiring.token,
  });
  assert.equal(expiredUse, null, "expired grant must not authenticate");

  // A revoked grant must not authenticate even before its TTL elapses.
  const revoking = await createContextGrant({
    agentSlug: "asdrubal",
    scopeType: "task",
    scopeId: `task-${nonce}`,
    turnId: nonce,
    maxUses: 5,
  });
  await db.contextGrant.update({
    where: { id: revoking.grant.id },
    data: { revokedAt: new Date() },
  });
  const revokedUse = await authenticateContextGrant({
    scopeType: "task",
    scopeId: `task-${nonce}`,
    token: revoking.token,
  });
  assert.equal(revokedUse, null, "revoked grant must not authenticate");

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
