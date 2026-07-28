// PH-124 run-lifecycle tests (scratch DB):
//   A — settled-run completion anomaly: a late error on a settled run keeps
//       the settle but records completionAnomaly + an ActivityLog row; a
//       plain done after a durable reply stays anomaly-free; the
//       stream-callback durable-reply conversion carries the error through.
//   C (web side) — the driver's distinct abort strings survive into
//       PmChannelRun.error on unsettled runs.
//   D — turn-failure retry policy: notification-class no-reply/abort failures
//       re-enter the job ladder (backoff, shared MAX_ATTEMPTS); conversation
//       turns and exhausted retries fail terminally WITH the incremental
//       binding rollback; retried dispatches carry the idempotency preamble
//       on the dispatched copy only.
import { execFile } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const NO_REPLY_ERROR = "Agent finished without posting a reply.";

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main() {
  const sandbox = await mkdtemp(join(tmpdir(), "pm-channel-lifecycle-db-"));
  const dropDir = await mkdtemp(join(tmpdir(), "pm-channel-lifecycle-bus-"));
  const dbUrl = `file:${join(sandbox, "test.db")}`;

  process.env.DATABASE_URL = dbUrl;
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.PM_CHANNEL_BUS_DROP_DIR = dropDir;
  delete process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS;
  delete process.env.PM_CHANNEL_JOB_RETRY_BASE_MS;
  delete process.env.PM_OPENCLAW_CHANNEL_HTTP_FALLBACK;

  await dbPush(dbUrl);

  const { db } = await import("@/lib/db");
  const {
    recordPmChannelRunEvent,
    recordPmChannelRunWorkflowAction,
  } = await import("@/lib/agents/pm-channel/runs");
  const {
    enqueueOpenClawPmChannelTurn,
    retryOrFailPmChannelJobForTurnFailure,
    runPmChannelWorkerOnce,
  } = await import("@/lib/agents/pm-channel/jobs");
  const { applyPmChannelStreamCallback } = await import("@/lib/agents/pm-channel/stream-callback");

  const agentSlug = "lifecycle-agent";

  try {
    const owner = await db.user.create({
      data: {
        username: "lifecycle-owner",
        email: "lifecycle-owner@example.test",
        kind: "human",
        isOwner: true,
        mustRotatePassword: false,
      },
    });
    const project = await db.project.create({
      data: { slug: "lifecycle", name: "Lifecycle" },
    });
    const task = await db.task.create({
      data: { projectId: project.id, title: "Lifecycle task", status: "In Progress" },
    });

    const grantMessage = (id: string) => db.agentChatMessage.create({
      data: {
        id,
        projectId: project.id,
        taskId: task.id,
        agentSlug,
        senderUserId: owner.id,
        body: "lifecycle turn",
        originChannel: "comment",
      },
    });
    const chatTarget = (messageId: string) => ({
      kind: "task-chat" as const,
      agentSlug,
      taskId: task.id,
      messageId,
      projectSlug: project.slug,
    });
    const commentTarget = (messageId: string) => ({
      kind: "task-comment" as const,
      agentSlug,
      taskId: task.id,
      messageId,
      projectSlug: project.slug,
    });
    const enqueue = (args: {
      target: ReturnType<typeof chatTarget> | ReturnType<typeof commentTarget>;
      text: string;
      turnClass?: "notification" | "conversation";
      gatewayPort?: number | null;
    }) => enqueueOpenClawPmChannelTurn({
      gatewayPort: args.gatewayPort ?? null,
      agentSlug,
      sessionKey: `lifecycle:${args.target.kind}:${args.target.messageId}`,
      kind: args.target.kind,
      text: args.text,
      projectId: project.id,
      actor: { id: owner.id, kind: "human" },
      replyTarget: args.target,
      ...(args.turnClass ? { turnClass: args.turnClass } : {}),
    });
    const runRow = (targetKey: string) => db.pmChannelRun.findUniqueOrThrow({
      where: { targetKey },
      select: {
        id: true,
        status: true,
        error: true,
        failedAt: true,
        completionAnomaly: true,
        completionAnomalyAt: true,
        jobs: { select: { status: true, attemptCount: true, availableAt: true, lastError: true, payload: true } },
      },
    });
    const durableReply = (messageId: string) => db.activityLog.create({
      data: {
        kind: "task.chat.reply",
        taskId: task.id,
        projectId: project.id,
        targetAgent: agentSlug,
        payload: JSON.stringify({ agentSlug, inReplyToMessageId: messageId }),
      },
    });
    const anomalyLog = (messageId: string) => db.activityLog.findFirst({
      where: { kind: "pm.channel.completion_anomaly", payload: { contains: messageId } },
      select: { payload: true },
    });

    // ---- A1: workflow action settles the run; a late error becomes an
    // anomaly instead of being discarded or flipping the settle. ----
    const mA = "lifecycle-a1";
    await grantMessage(mA);
    await enqueue({ target: commentTarget(mA), text: "turn A1 comment" });
    await enqueue({ target: chatTarget(mA), text: "turn A1 chat" });
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug,
      messageId: mA,
      action: "start",
    });
    const settledComment = await runRow(`task-comment:${agentSlug}:${task.id}:${mA}`);
    const settledChat = await runRow(`task-chat:${agentSlug}:${task.id}:${mA}`);
    assert.equal(settledComment.status, "complete", "workflow action settles the task-comment run");
    assert.equal(settledChat.status, "complete", "workflow action settles the task-chat run");
    assert.deepEqual(
      [...settledComment.jobs, ...settledChat.jobs].map((job) => job.status),
      ["complete", "complete"],
      "workflow action settles both jobs",
    );

    await recordPmChannelRunEvent({
      target: commentTarget(mA),
      event: "error",
      error: "gateway aborted turn (cancel endpoint)",
    });
    const anomalous = await runRow(`task-comment:${agentSlug}:${task.id}:${mA}`);
    assert.equal(anomalous.status, "complete", "late error must not flip the settled status");
    assert.equal(anomalous.error, null, "late error must not land in the run error field");
    assert.equal(
      anomalous.completionAnomaly,
      "gateway aborted turn (cancel endpoint)",
      "late error must be recorded as completionAnomaly",
    );
    assert.ok(anomalous.completionAnomalyAt, "completionAnomalyAt must be stamped");
    assert.deepEqual(anomalous.jobs.map((job) => job.status), ["complete"], "settled job stays complete");
    const a1Log = await anomalyLog(mA);
    assert.ok(a1Log, "pm.channel.completion_anomaly ActivityLog row must exist");
    const a1Payload = JSON.parse(a1Log!.payload!) as Record<string, unknown>;
    assert.equal(a1Payload.settledStatus, "complete", "anomaly payload records the settled status");
    assert.equal(a1Payload.hadDurableReply, false, "anomaly payload records durable-reply state");
    assert.equal(a1Payload.event, "error");

    // ---- A2: plain done after a durable reply is the legitimate settle —
    // no anomaly. ----
    const mB = "lifecycle-a2";
    await grantMessage(mB);
    await enqueue({ target: chatTarget(mB), text: "turn A2" });
    await db.pmChannelRun.update({
      where: { targetKey: `task-chat:${agentSlug}:${task.id}:${mB}` },
      data: { status: "streaming" },
    });
    await durableReply(mB);
    await recordPmChannelRunEvent({ target: chatTarget(mB), event: "done" });
    const cleanDone = await runRow(`task-chat:${agentSlug}:${task.id}:${mB}`);
    assert.equal(cleanDone.status, "complete", "done after durable reply settles complete");
    assert.equal(cleanDone.completionAnomaly, null, "plain done must stay anomaly-free");
    assert.equal(await anomalyLog(mB), null, "no anomaly ActivityLog for a clean settle");

    // ---- A3: the stream-callback durable-reply conversion passes the error
    // through — anomaly recorded with hadDurableReply true. ----
    const mC = "lifecycle-a3";
    await grantMessage(mC);
    await enqueue({ target: chatTarget(mC), text: "turn A3" });
    await db.pmChannelRun.update({
      where: { targetKey: `task-chat:${agentSlug}:${task.id}:${mC}` },
      data: { status: "streaming" },
    });
    await durableReply(mC);
    const callbackResult = await applyPmChannelStreamCallback({
      payload: {
        target: chatTarget(mC),
        event: "error",
        error: "gateway aborted turn: post-action abort",
      },
      rateLimit: false,
    });
    assert.equal(callbackResult.status, 200, "durable-reply error callback is accepted");
    const converted = await runRow(`task-chat:${agentSlug}:${task.id}:${mC}`);
    assert.equal(converted.status, "complete", "durable reply still settles the run complete");
    assert.equal(
      converted.completionAnomaly,
      "gateway aborted turn: post-action abort",
      "the masked error must survive the done-conversion as an anomaly",
    );
    const a3Log = await anomalyLog(mC);
    assert.ok(a3Log, "anomaly ActivityLog for the converted error must exist");
    const a3Payload = JSON.parse(a3Log!.payload!) as Record<string, unknown>;
    assert.equal(a3Payload.hadDurableReply, true, "conversion anomaly records hadDurableReply: true");

    // ---- D1: notification-class no-reply failure re-enters the ladder. ----
    const mD = "lifecycle-d1";
    await grantMessage(mD);
    await enqueue({ target: chatTarget(mD), text: "notify D1", turnClass: "notification" });
    const d1Key = `task-chat:${agentSlug}:${task.id}:${mD}`;
    const d1Seed = await runRow(d1Key);
    await db.pmChannelJob.updateMany({
      where: { runId: d1Seed.id },
      data: { status: "accepted", attemptCount: 1, acceptedAt: new Date() },
    });
    await db.pmChannelRun.update({ where: { id: d1Seed.id }, data: { status: "streaming" } });
    await db.agentSessionBinding.create({
      data: {
        scopeType: "task",
        scopeId: task.id,
        agentSlug,
        openclawSessionKey: `lifecycle:binding:${task.id}:${agentSlug}`,
        lastDispatchedMessageId: mD,
        lastDispatchedAt: new Date(),
      },
    });
    const beforeRetry = Date.now();
    await recordPmChannelRunEvent({ target: chatTarget(mD), event: "done" });
    const retried = await runRow(d1Key);
    assert.equal(retried.status, "retryable", "notification no-reply run goes retryable");
    assert.equal(retried.error, NO_REPLY_ERROR, "retryable run keeps the no-reply error");
    assert.equal(retried.failedAt, null, "retryable run clears failedAt");
    assert.equal(retried.jobs[0]!.status, "retryable", "job re-enters the ladder");
    assert.equal(retried.jobs[0]!.lastError, NO_REPLY_ERROR);
    const delayMs = retried.jobs[0]!.availableAt.getTime() - beforeRetry;
    assert.ok(
      delayMs >= 14_000 && delayMs <= 20_000,
      `retry backoff must be ~retryDelayMs(1)=15s (got ${delayMs}ms)`,
    );
    const bindingAfterRetry = await db.agentSessionBinding.findFirstOrThrow({
      where: { scopeType: "task", scopeId: task.id, agentSlug },
      select: { lastDispatchedMessageId: true },
    });
    assert.equal(
      bindingAfterRetry.lastDispatchedMessageId,
      mD,
      "a mid-ladder retry must NOT roll back the incremental binding",
    );

    // ---- D2: exhausted attempts fail terminally WITH the binding rollback
    // (the pre-existing gap: no-reply failures skipped the rollback). ----
    await db.pmChannelJob.updateMany({
      where: { runId: d1Seed.id },
      data: { attemptCount: 3 },
    });
    await recordPmChannelRunEvent({ target: chatTarget(mD), event: "done" });
    const exhausted = await runRow(d1Key);
    assert.equal(exhausted.status, "failed", "exhausted retries fail terminally");
    assert.ok(exhausted.failedAt, "terminal failure stamps failedAt");
    assert.equal(exhausted.jobs[0]!.status, "failed", "exhausted job is terminal");
    const bindingAfterExhaust = await db.agentSessionBinding.findFirstOrThrow({
      where: { scopeType: "task", scopeId: task.id, agentSlug },
      select: { lastDispatchedMessageId: true },
    });
    assert.equal(
      bindingAfterExhaust.lastDispatchedMessageId,
      null,
      "terminal turn failure must roll back the incremental binding",
    );

    // ---- D3: conversation-class turn fails terminally at once, keeping the
    // driver's distinct abort string (item C web side) + binding rollback. ----
    const mE = "lifecycle-d3";
    await grantMessage(mE);
    await enqueue({ target: chatTarget(mE), text: "please refactor the module" });
    const d3Key = `task-chat:${agentSlug}:${task.id}:${mE}`;
    const d3Seed = await runRow(d3Key);
    await db.pmChannelJob.updateMany({
      where: { runId: d3Seed.id },
      data: { status: "accepted", attemptCount: 1, acceptedAt: new Date() },
    });
    await db.pmChannelRun.update({ where: { id: d3Seed.id }, data: { status: "streaming" } });
    await db.agentSessionBinding.update({
      where: { openclawSessionKey: `lifecycle:binding:${task.id}:${agentSlug}` },
      data: { lastDispatchedMessageId: mE, lastDispatchedAt: new Date() },
    });
    await recordPmChannelRunEvent({
      target: chatTarget(mE),
      event: "error",
      error: "gateway aborted turn: session killed",
    });
    const conversationFailed = await runRow(d3Key);
    assert.equal(conversationFailed.status, "failed", "conversation turn failure is terminal");
    assert.equal(
      conversationFailed.error,
      "gateway aborted turn: session killed",
      "the driver's distinct abort string must land on the run",
    );
    assert.equal(conversationFailed.jobs[0]!.status, "failed");
    const bindingAfterConversation = await db.agentSessionBinding.findFirstOrThrow({
      where: { scopeType: "task", scopeId: task.id, agentSlug },
      select: { lastDispatchedMessageId: true },
    });
    assert.equal(bindingAfterConversation.lastDispatchedMessageId, null, "conversation failure rolls the binding back");

    // ---- D4: legacy job without turnClass but with the notification body
    // prefix is classified notification by the fallback heuristic. ----
    const mF = "lifecycle-d4";
    await grantMessage(mF);
    await enqueue({
      target: chatTarget(mF),
      text: `PM workflow notification for @${agentSlug}:\n\nPlease act on the task.`,
      gatewayPort: 45678,
    });
    const d4Key = `task-chat:${agentSlug}:${task.id}:${mF}`;
    const d4Seed = await runRow(d4Key);
    await db.pmChannelJob.updateMany({
      where: { runId: d4Seed.id },
      data: { status: "accepted", attemptCount: 1, acceptedAt: new Date() },
    });
    await db.pmChannelRun.update({ where: { id: d4Seed.id }, data: { status: "streaming" } });
    await recordPmChannelRunEvent({ target: chatTarget(mF), event: "done" });
    const heuristicRetried = await runRow(d4Key);
    assert.equal(
      heuristicRetried.status,
      "retryable",
      "prefix heuristic must classify legacy notification jobs as retryable",
    );

    // ---- D5: the retried dispatch carries the idempotency preamble on the
    // dispatched copy only; the stored payload stays pristine. ----
    await db.pmChannelJob.updateMany({
      where: { runId: d4Seed.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    const workerOutcome = await runPmChannelWorkerOnce("lifecycle-worker");
    assert.equal(workerOutcome.claimed, true, "worker claims the retryable job");
    if (workerOutcome.claimed) assert.equal(workerOutcome.ok, true, "bus drop dispatch succeeds");
    const envelopes = await readdir(dropDir);
    assert.equal(envelopes.length, 1, "exactly one bus envelope is written");
    const envelope = JSON.parse(await readFile(join(dropDir, envelopes[0]!), "utf8")) as {
      payload: { text: string };
    };
    assert.ok(
      envelope.payload.text.startsWith("NOTE: a previous attempt of this turn aborted mid-run"),
      "retried dispatch must carry the idempotency preamble",
    );
    assert.ok(
      envelope.payload.text.includes(`PM workflow notification for @${agentSlug}:`),
      "the original notification body must follow the preamble",
    );
    const storedJob = await db.pmChannelJob.findFirstOrThrow({
      where: { runId: d4Seed.id },
      select: { payload: true, status: true },
    });
    const storedPayload = JSON.parse(storedJob.payload) as { text: string };
    assert.ok(
      !storedPayload.text.includes("NOTE: a previous attempt"),
      "the stored job payload must never contain the preamble",
    );
    assert.equal(storedJob.status, "accepted", "successful retry dispatch marks the job accepted");

    // ---- D6: canceled runs are never retried. ----
    const mG = "lifecycle-d6";
    await db.pmChannelRun.create({
      data: {
        targetKey: `task-chat:${agentSlug}:${task.id}:${mG}`,
        kind: "task-chat",
        agentSlug,
        messageId: mG,
        taskId: task.id,
        projectId: project.id,
        status: "canceled",
      },
    });
    const canceledOutcome = await retryOrFailPmChannelJobForTurnFailure({
      targetKey: `task-chat:${agentSlug}:${task.id}:${mG}`,
      error: NO_REPLY_ERROR,
    });
    assert.equal(canceledOutcome, "no_job", "canceled runs fall back to the caller's terminal path");
  } finally {
    delete process.env.PM_CHANNEL_BUS_DROP_DIR;
    const { db } = await import("@/lib/db");
    await db.$disconnect();
    await rm(dropDir, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    console.log("pm-channel lifecycle tests passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
