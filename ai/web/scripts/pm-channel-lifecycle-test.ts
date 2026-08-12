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
  process.env.PM_CHANNEL_JOB_ACCEPTED_TIMEOUT_MS = "1800000";
  delete process.env.PM_CHANNEL_JOB_MAX_ATTEMPTS;
  delete process.env.PM_CHANNEL_JOB_RETRY_BASE_MS;
  delete process.env.PM_OPENCLAW_CHANNEL_HTTP_FALLBACK;

  await dbPush(dbUrl);

  const { db } = await import("@/lib/db");
  const {
    cancelPmChannelRunForTarget,
    getPmChannelRunSnapshot,
    recordPmChannelRunEvent,
    recordPmChannelRunWorkflowAction,
  } = await import("@/lib/agents/pm-channel/runs");
  const { runWorkflowActionAtomically } = await import(
    "@/lib/agents/workflow/transactional-action"
  );
  // ENV-118: continuation-required actions only reach the recorder through the
  // atomic primitive now (see workflow-action-effect-test B8/B9).
  const recordContinuationAction = async (args: {
    taskId: string;
    agentSlug: string;
    messageId: string;
    action: string;
  }) => (await runWorkflowActionAtomically(args, async () => {})).result;
  const {
    enqueueOpenClawPmChannelTurn,
    isRetryablePmChannelTurnFailure,
    retryOrFailPmChannelJobForTurnFailure,
    requeueStaleClaimedPmChannelJobs,
    runPmChannelWorkerOnce,
  } = await import("@/lib/agents/pm-channel/jobs");
  const { applyPmChannelStreamCallback } = await import("@/lib/agents/pm-channel/stream-callback");
  const { getOrCreateAgentSessionBinding } = await import("@/lib/agents/auth/session-bindings");
  const { openTaskExecutionEpisode, EPISODE_CLOSE_REASON } = await import(
    "@/lib/agents/episodes/lifecycle"
  );
  const { CONTEXT_PRESSURE_RECOVERY_ACTION } = await import(
    "@/lib/agents/pm-channel/continuations"
  );

  const agentSlug = "lifecycle-agent";

  for (const error of [
    "maximum context length exceeded",
    "context window is too large",
    "prompt is too long",
    "Context overflow: prompt too large for the model",
  ]) {
    assert.equal(isRetryablePmChannelTurnFailure(error), true, `provider context failure must be retryable: ${error}`);
  }

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
      sessionKey?: string;
    }) => enqueueOpenClawPmChannelTurn({
      gatewayPort: args.gatewayPort ?? null,
      agentSlug,
      sessionKey: args.sessionKey ?? `lifecycle:${args.target.kind}:${args.target.messageId}`,
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
        completedAt: true,
        completionAnomaly: true,
        completionAnomalyAt: true,
        finishedReason: true,
        disposition: true,
        settledByAction: true,
        sessionKey: true,
        jobs: { select: { id: true, status: true, attemptCount: true, availableAt: true, lastError: true, payload: true } },
      },
    });

    // ---- Lease split: accepted work gets an execution lease, not the
    // two-minute dispatch-claim lease. A tool-heavy live turn must not be
    // duplicated or failed while it is still legitimately running. ----
    const leaseMessage = "lifecycle-accepted-lease";
    await grantMessage(leaseMessage);
    await enqueue({
      target: commentTarget(leaseMessage),
      text: `PM workflow notification for @${agentSlug}:\n\nRun a tool-heavy verification.`,
      turnClass: "notification",
    });
    const leaseKey = `task-comment:${agentSlug}:${task.id}:${leaseMessage}`;
    const leaseSeed = await runRow(leaseKey);
    const leaseJobId = leaseSeed.jobs[0]!.id;
    const leaseNow = new Date();
    await db.$transaction([
      db.pmChannelJob.update({
        where: { id: leaseJobId },
        data: {
          status: "accepted",
          attemptCount: 1,
          acceptedAt: new Date(leaseNow.getTime() - 5 * 60_000),
        },
      }),
      db.pmChannelRun.update({
        where: { id: leaseSeed.id },
        data: {
          status: "accepted",
          acceptedAt: new Date(leaseNow.getTime() - 5 * 60_000),
          lastEventAt: new Date(leaseNow.getTime() - 5 * 60_000),
        },
      }),
    ]);
    await requeueStaleClaimedPmChannelJobs(leaseNow);
    assert.equal(
      (await runRow(leaseKey)).jobs[0]!.status,
      "accepted",
      "a five-minute accepted live turn must survive the two-minute claim lease",
    );
    assert.equal(
      (await getPmChannelRunSnapshot(commentTarget(leaseMessage)))?.status,
      "accepted",
      "the run snapshot must use the same accepted execution lease as the job worker",
    );
    await db.pmChannelJob.update({
      where: { id: leaseJobId },
      data: { acceptedAt: new Date(leaseNow.getTime() - 31 * 60_000) },
    });
    await requeueStaleClaimedPmChannelJobs(leaseNow);
    assert.equal(
      (await runRow(leaseKey)).jobs[0]!.status,
      "retryable",
      "an accepted turn beyond the dedicated execution lease must recover",
    );
    await db.$transaction([
      db.pmChannelJob.update({ where: { id: leaseJobId }, data: { status: "canceled" } }),
      db.pmChannelRun.update({ where: { id: leaseSeed.id }, data: { status: "canceled" } }),
    ]);
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

    // ---- A1: an EPISODE-TERMINAL workflow action settles the run; a late
    // error becomes an anomaly instead of being discarded or flipping the
    // settle. ENV-118 changed which actions settle: `start` is
    // continuation-required and deliberately leaves the run open, so this
    // case uses ready_for_review. A0 below covers the continuation half. ----
    const mA = "lifecycle-a1";
    await grantMessage(mA);
    await enqueue({ target: commentTarget(mA), text: "turn A1 comment" });
    await enqueue({ target: chatTarget(mA), text: "turn A1 chat" });
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug,
      messageId: mA,
      action: "ready_for_review",
    });
    const settledComment = await runRow(`task-comment:${agentSlug}:${task.id}:${mA}`);
    const settledChat = await runRow(`task-chat:${agentSlug}:${task.id}:${mA}`);
    // ENV-117 allows at most one ACTIVE run per (taskId, agentSlug), so
    // enqueueing the chat surface supersedes the comment surface of the same
    // turn. The live run is the one an episode-terminal action settles.
    assert.equal(settledChat.status, "completed", "workflow action settles the live run");
    assert.equal(settledComment.status, "superseded", "the earlier surface was superseded on enqueue");
    assert.equal(
      settledComment.disposition,
      "continue",
      "a superseded run did not finish its episode (WFI-005)",
    );
    assert.equal(
      settledChat.disposition,
      "ready_for_review",
      "an episode-terminal action records its disposition (WFI-005)",
    );
    assert.equal(
      settledChat.settledByAction,
      "ready_for_review",
      "settledByAction names the action that actually settled the run",
    );
    assert.deepEqual(
      settledChat.jobs.map((job) => job.status),
      ["complete"],
      "workflow action settles the live run's job",
    );

    // ---- A0 (ENV-118): a continuation-required action must NOT settle the
    // run or its job. Reporting the job complete on `start` is exactly the
    // "workflow succeeded before any work happened" bug. ----
    const mA0 = "lifecycle-a0";
    await grantMessage(mA0);
    await enqueue({ target: commentTarget(mA0), text: "turn A0 comment" });
    const startResult = await recordContinuationAction({
      taskId: task.id,
      agentSlug,
      messageId: mA0,
      action: "start",
    });
    assert.equal(startResult.actionEffect, "continue", "start is a continuation-required action");
    assert.equal(startResult.turnComplete, false, "start does not complete the turn");
    assert.equal(startResult.nextAction, "ready_for_review", "start names the terminal next action");
    const startedRun = await runRow(`task-comment:${agentSlug}:${task.id}:${mA0}`);
    assert.equal(startedRun.status, "queued", "start leaves the run active");
    assert.equal(startedRun.completedAt, null, "start records no completion time");
    assert.equal(startedRun.disposition, "continue", "start records the continue disposition");
    assert.equal(startedRun.settledByAction, null, "start settles nothing, so it names no settling action");
    assert.deepEqual(
      startedRun.jobs.map((job) => job.status),
      ["queued"],
      "start leaves the PM job unsettled",
    );
    assert.equal(
      await db.pmChannelContinuation.count({ where: { runId: startedRun.id, status: "armed" } }),
      1,
      "start arms exactly one continuation",
    );

    await recordPmChannelRunEvent({
      target: chatTarget(mA),
      event: "error",
      error: "gateway aborted turn (cancel endpoint)",
    });
    const anomalous = await runRow(`task-chat:${agentSlug}:${task.id}:${mA}`);
    assert.equal(anomalous.status, "completed", "late error must not flip the settled status");
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
    assert.equal(a1Payload.settledStatus, "completed", "anomaly payload records the settled status");
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
    assert.equal(cleanDone.status, "completed", "done after durable reply settles complete");
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
    assert.equal(converted.status, "completed", "durable reply still settles the run complete");
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
    // ENV-117 removed `retryable` from the RUN status vocabulary — it is a job
    // status now. A retrying turn leaves the run `failed` with failedAt null
    // (the distinction from an exhausted failure) while the job re-enters the
    // ladder. This expectation was stale on pm-workflow and failed there too.
    assert.equal(retried.status, "queued", "notification no-reply run remains non-terminal while retry is pending");
    assert.equal(retried.error, NO_REPLY_ERROR, "the retrying run keeps the no-reply error");
    assert.equal(retried.failedAt, null, "a retrying run clears failedAt; only an exhausted one stamps it");
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
      data: { status: "accepted", attemptCount: 3 },
    });
    await db.pmChannelRun.update({ where: { id: d1Seed.id }, data: { status: "streaming" } });
    await retryOrFailPmChannelJobForTurnFailure({ targetKey: d1Key, error: NO_REPLY_ERROR });
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
    // Same ENV-117 vocabulary change as D1: the retry lands on the job, and the
    // run records a non-terminal `failed` attempt.
    assert.equal(
      heuristicRetried.status,
      "queued",
      "prefix heuristic must keep legacy notification jobs retryable",
    );
    assert.equal(
      heuristicRetried.jobs[0]!.status,
      "retryable",
      "the legacy-notification job re-enters the retry ladder",
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

    // ---- D6: terminal context failure rotates the poisoned session before
    // retrying. The newer OpenClaw wording must be classified too. ----
    // Earlier lifecycle cases record workflow actions directly and therefore
    // may leave a synthetic execution episode open. D6 is specifically the
    // non-execution notification fallback; close that fixture residue first.
    await db.taskExecutionEpisode.updateMany({
      where: { taskId: task.id, agentSlug, status: "open" },
      data: { status: "closed", closedAt: new Date(), closeReason: "test_fixture_cleanup" },
    });
    const oldSessionKey = `lifecycle:binding:${task.id}:${agentSlug}`;
    const mH = "lifecycle-d6-context-rotation";
    await grantMessage(mH);
    await db.agentSessionBinding.update({
      where: { openclawSessionKey: oldSessionKey },
      data: { lastDispatchedMessageId: mH, lastDispatchedAt: new Date() },
    });
    await enqueue({
      target: chatTarget(mH),
      text: `PM workflow notification for @${agentSlug}:\n\nContinue the long task.`,
      turnClass: "notification",
      sessionKey: oldSessionKey,
    });
    const d6Key = `task-chat:${agentSlug}:${task.id}:${mH}`;
    const d6Seed = await runRow(d6Key);
    await db.pmChannelJob.updateMany({
      where: { runId: d6Seed.id },
      data: { status: "accepted", attemptCount: 1, acceptedAt: new Date() },
    });
    await db.pmChannelRun.update({ where: { id: d6Seed.id }, data: { status: "streaming" } });
    const contextFailure = "⚠️ Context is too large and auto-compaction could not recover this turn. Try again.";
    await recordPmChannelRunEvent({ target: chatTarget(mH), event: "error", error: contextFailure });
    const contextRetried = await runRow(d6Key);
    assert.equal(
      contextRetried.status,
      "queued",
      "a retrying run returns to queued so no terminal-looking failed run owns the live lane",
    );
    assert.equal(
      contextRetried.jobs[0]!.status,
      "retryable",
      "terminal context failure remains on the bounded retry ladder",
    );
    assert.notEqual(contextRetried.sessionKey, oldSessionKey, "the retry run must point at a fresh OpenClaw session");
    const rotatedBinding = await db.agentSessionBinding.findFirstOrThrow({
      where: { scopeType: "task", scopeId: task.id, agentSlug },
      select: { openclawSessionKey: true, lastDispatchedMessageId: true },
    });
    assert.equal(rotatedBinding.openclawSessionKey, contextRetried.sessionKey);
    assert.match(rotatedBinding.openclawSessionKey, /:recovery:failure-/);
    assert.equal(rotatedBinding.lastDispatchedMessageId, null, "fresh session retries rebuild their incremental baseline");
    const rotatedPayload = JSON.parse(contextRetried.jobs[0]!.payload) as { sessionKey?: string };
    assert.equal(rotatedPayload.sessionKey, rotatedBinding.openclawSessionKey, "the durable retry payload must use the rotated key");

    const rotationLog = await db.activityLog.findFirst({
      where: { taskId: task.id, kind: "pm.session.rotated", targetAgent: agentSlug },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    assert.ok(rotationLog, "session rotation must be auditable");
    assert.equal((JSON.parse(rotationLog!.payload ?? "{}") as { reason?: unknown }).reason, "context_failure");

    // ---- D6b: an assignee execution episode must NOT retry the poisoned job
    // under a cosmetically different key. Close it, preserve its checkpoint,
    // and queue a fresh successor episode instead. ----
    await db.taskExecutionEpisode.deleteMany({ where: { taskId: task.id, agentSlug } });
    const executionAgent = await db.agent.create({
      data: { slug: agentSlug, name: "Lifecycle Agent", role: "coding" },
    });
    const executionUser = await db.user.create({
      data: {
        username: agentSlug,
        email: `${agentSlug}@example.test`,
        kind: "agent",
        agentId: executionAgent.id,
      },
    });
    await db.task.update({ where: { id: task.id }, data: { assigneeId: executionUser.id } });
    const poisonedEpisode = await db.$transaction((tx) =>
      openTaskExecutionEpisode(tx, {
        taskId: task.id,
        projectId: project.id,
        agentSlug,
        sessionKey: "lifecycle:poisoned-episode",
        messageId: "lifecycle-d6b-context-episode",
        toolCycleBudget: 60,
      }),
    );
    await db.taskExecutionEpisode.update({
      where: { id: poisonedEpisode.id },
      data: {
        nextAction: "resume the browser verification",
        openChecklist: JSON.stringify(["finish the payment journey"]),
        checkpointAt: new Date(),
      },
    });
    const mI = "lifecycle-d6b-context-episode";
    await grantMessage(mI);
    await enqueue({
      target: chatTarget(mI),
      text: `PM workflow notification for @${agentSlug}:\n\nContinue the execution episode.`,
      turnClass: "notification",
      sessionKey: "lifecycle:poisoned-episode",
    });
    const d6bKey = `task-chat:${agentSlug}:${task.id}:${mI}`;
    const d6bSeed = await runRow(d6bKey);
    await db.pmChannelJob.updateMany({
      where: { runId: d6bSeed.id },
      data: { status: "accepted", attemptCount: 1, acceptedAt: new Date() },
    });
    await db.pmChannelRun.update({ where: { id: d6bSeed.id }, data: { status: "streaming" } });
    await recordPmChannelRunEvent({ target: chatTarget(mI), event: "error", error: contextFailure });

    const recoveredRun = await runRow(d6bKey);
    assert.equal(recoveredRun.status, "failed", "the poisoned transport turn is terminal");
    assert.equal(recoveredRun.disposition, "continue", "task execution continues in the successor episode");
    assert.equal(recoveredRun.finishedReason, "context_pressure_episode_recovered");
    assert.equal(recoveredRun.jobs[0]!.status, "failed", "the stale job itself is never replayed");
    const recoveredEpisodes = await db.taskExecutionEpisode.findMany({
      where: { taskId: task.id, agentSlug },
      orderBy: { episodeNo: "asc" },
      select: {
        episodeNo: true,
        status: true,
        sessionKey: true,
        closeReason: true,
        nextAction: true,
        toolCycleBudget: true,
      },
    });
    assert.equal(recoveredEpisodes.length, 2, "context recovery creates exactly one successor");
    assert.equal(recoveredEpisodes[0]!.closeReason, EPISODE_CLOSE_REASON.contextPressureRecovery);
    assert.equal(recoveredEpisodes[0]!.nextAction, "resume the browser verification");
    assert.equal(recoveredEpisodes[1]!.status, "open");
    assert.equal(recoveredEpisodes[1]!.sessionKey, null, "the successor has never used the poisoned session");
    assert.equal(recoveredEpisodes[1]!.toolCycleBudget, 18, "the successor uses the tightened default ceiling");
    const contextContinuation = await db.pmChannelContinuation.findFirstOrThrow({
      where: { runId: d6bSeed.id, action: CONTEXT_PRESSURE_RECOVERY_ACTION },
      select: { status: true },
    });
    assert.equal(contextContinuation.status, "queued", "the fresh checkpoint continuation is durable");
    await db.task.update({ where: { id: task.id }, data: { assigneeId: null } });

    // The same mechanism rotates proactively by a provider-neutral completed
    // turn budget, before any backend-specific overflow string is required.
    await db.pmChannelRun.create({
      data: {
        targetKey: `task-comment:${agentSlug}:${task.id}:proactive-budget`,
        kind: "task-comment",
        agentSlug,
        messageId: "proactive-budget",
        projectId: project.id,
        taskId: task.id,
        sessionKey: rotatedBinding.openclawSessionKey,
        status: "completed",
      },
    });
    process.env.PM_TASK_SESSION_MAX_COMPLETED_TURNS = "1";
    const proactivelyRotated = await getOrCreateAgentSessionBinding({
      scopeType: "task",
      scopeId: task.id,
      agentSlug,
    });
    delete process.env.PM_TASK_SESSION_MAX_COMPLETED_TURNS;
    assert.notEqual(proactivelyRotated.openclawSessionKey, rotatedBinding.openclawSessionKey);
    const proactiveLog = await db.activityLog.findFirstOrThrow({
      where: { taskId: task.id, kind: "pm.session.rotated", targetAgent: agentSlug },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    assert.equal((JSON.parse(proactiveLog.payload ?? "{}") as { reason?: unknown }).reason, "completed_turn_budget");

    // ---- D7: canceling a live task run also closes its execution episode;
    // a canceled process must never leave a phantom open lane behind. ----
    await db.taskExecutionEpisode.deleteMany({ where: { taskId: task.id, agentSlug } });
    const mCancel = "lifecycle-d7-cancel-live";
    await grantMessage(mCancel);
    const cancelRun = await db.pmChannelRun.create({
      data: {
        targetKey: `task-chat:${agentSlug}:${task.id}:${mCancel}`,
        kind: "task-chat",
        agentSlug,
        messageId: mCancel,
        taskId: task.id,
        projectId: project.id,
        status: "streaming",
      },
    });
    await db.$transaction((tx) =>
      openTaskExecutionEpisode(tx, {
        taskId: task.id,
        projectId: project.id,
        agentSlug,
        sessionKey: "lifecycle:cancel-live",
        messageId: mCancel,
        runId: cancelRun.id,
      }),
    );
    const cancelResult = await cancelPmChannelRunForTarget({
      target: chatTarget(mCancel),
      actorUserId: owner.id,
    });
    assert.equal(cancelResult.canceled, true);
    const canceledEpisode = await db.taskExecutionEpisode.findFirstOrThrow({
      where: { taskId: task.id, agentSlug, messageId: mCancel },
      select: { status: true, closeReason: true },
    });
    assert.equal(canceledEpisode.status, "closed");
    assert.equal(canceledEpisode.closeReason, EPISODE_CLOSE_REASON.canceled);

    // Canceled runs are never retried.
    const mG = "lifecycle-d7";
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
