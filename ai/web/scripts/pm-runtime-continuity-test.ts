import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";

async function main() {
  const dir = await mkdtemp("/tmp/pm-runtime-continuity-");
  process.env.DATABASE_URL = `file:${dir}/test.db`;
  await promisify(execFile)("pnpm", ["prisma", "db", "push", "--skip-generate"], { env: process.env });
  // Avoid racing fire-and-forget pragma initialization with fixture writes.
  global.__prismaPragmasApplied = true;
  const { db, ensureSqlitePragmas } = await import("@/lib/db");
  global.__prismaPragmasApplied = false;
  await ensureSqlitePragmas();
  const { applyAuthenticatedPmChannelWorkflowAction, recordPmChannelRunEvent, recordPmChannelRunDispatch, pmChannelRunTargetKey } = await import("@/lib/agents/pm-channel/runs");
  const { applyPmChannelStreamCallback } = await import("@/lib/agents/pm-channel/stream-callback");
  const { openTaskExecutionEpisode, recordTaskExecutionToolCycle, episodeToolCycleBudgetForModel } = await import("@/lib/agents/episodes/lifecycle");
  const { fenceTaskRunsForPlanRevision, fenceSupersededPmChannelRuns } = await import("@/lib/agents/pm-channel/supersession");
  const { appendPmChannelStreamEvent, replayPmChannelStreamFrames } = await import("@/lib/agents/pm-channel/stream-log");
  const { maintainPmRuntimeHistory } = await import("@/lib/agents/pm-channel/retention");
  const { runWorkflowReconciliation } = await import("@/lib/tasks/workflow-reconciler");
  const { releaseExecutionLane, reserveExecutionLane, reconcileAbandonedLeases } = await import("@/lib/agents/pm-channel/execution-lane");
  try {
    const owner = await db.user.create({ data: { username: "runtime-owner", email: "runtime-owner@example.test", kind: "human", isOwner: true } });
    const agent = await db.agent.create({ data: { slug: "runtime-worker", name: "Runtime Worker", role: "coding" } });
    const worker = await db.user.create({ data: { username: agent.slug, email: "runtime-worker@example.test", kind: "agent", agentId: agent.id } });
    const project = await db.project.create({ data: { slug: "runtime-test", name: "Runtime Test" } });
    async function fixture(name: string, toolCount = 0) {
      const task = await db.task.create({ data: { title: name, status: "In Progress", projectId: project.id, assigneeId: worker.id } });
      const message = await db.agentChatMessage.create({ data: { projectId: project.id, taskId: task.id, agentSlug: agent.slug, senderUserId: owner.id, body: name, originChannel: "comment" } });
      const target = { kind: "task-comment" as const, taskId: task.id, messageId: message.id, agentSlug: agent.slug, projectSlug: project.slug };
      const run = await db.pmChannelRun.create({ data: { targetKey: pmChannelRunTargetKey(target), agentSlug: agent.slug, messageId: message.id, taskId: task.id, projectId: project.id, kind: "task-comment", status: "streaming", sessionKey: `pm:${name}` } });
      const episode = await db.$transaction((tx) => openTaskExecutionEpisode(tx, { taskId: task.id, agentSlug: agent.slug, projectId: project.id, messageId: message.id, runId: run.id, toolCycleBudget: 24 }));
      if (toolCount) await db.taskExecutionEpisode.update({ where: { id: episode.id }, data: { toolCycleCount: toolCount } });
      return { task, message, target, run, episode };
    }

    const early = await fixture("cooperative", 16);
    const checkpoint = { completedWork: ["Started durable verification job verifier-123"], evidence: ["verifier-123; retrieve existing result, do not rerun"], nextAction: "Poll verifier-123 and inspect its result", risks: ["verification still running"] };
    const result = await db.$transaction((tx) => applyAuthenticatedPmChannelWorkflowAction(tx, {
      taskId: early.task.id, taskState: "In Progress", countsAgainstEpisodeBudget: false, checkpoint,
      executionContext: { agentSlug: agent.slug, pmChannelRunId: early.run.id, sourceMessageId: early.message.id, publicAction: "checkpoint", expectedEpisodeId: early.episode.id },
    }));
    assert.equal(result.turnComplete, true);
    assert.equal(result.episode?.rolledOver, true);
    assert.equal(result.successorScheduled, true);
    const saved = await db.taskExecutionEpisode.findUniqueOrThrow({ where: { id: early.episode.id } });
    assert.equal(saved.closeReason, "checkpoint_acknowledged");
    assert.equal(saved.nextAction, checkpoint.nextAction);
    assert.ok(saved.barrierReleasedAt, "acknowledgement and seal commit together");
    assert.equal(await db.pmChannelContinuation.count({ where: { runId: early.run.id, status: "armed", action: "episode_rollover" } }), 1, "successor waits for source turn to stop");
    await recordPmChannelRunEvent({ target: early.target, event: "final" });
    assert.equal(await db.pmChannelContinuation.count({ where: { runId: early.run.id, status: "queued" } }), 1);
    const before = await db.pmChannelRun.findUniqueOrThrow({ where: { id: early.run.id } });
    await recordPmChannelRunEvent({ target: early.target, event: "turn:terminal" });
    await recordPmChannelRunEvent({ target: early.target, event: "done" });
    const after = await db.pmChannelRun.findUniqueOrThrow({ where: { id: early.run.id } });
    assert.equal(after.completedAt?.getTime(), before.completedAt?.getTime());
    assert.equal(after.finishedReason, before.finishedReason);
    assert.equal(after.disposition, "continue");
    assert.equal(await db.taskExecutionEpisode.count({ where: { taskId: early.task.id } }), 2);

    const empty = await fixture("empty");
    await recordPmChannelRunEvent({ target: empty.target, event: "done" });
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: empty.run.id } })).status, "failed", "empty done is never a successful silent reply");

    const pressure = await fixture("pressure");
    const callback = (payload: Record<string, unknown>) => applyPmChannelStreamCallback({ payload: { target: pressure.target, ...payload }, rateLimit: false });
    const aggregate = { modelRunId: "aggregate", inputTokens: 900_000, cacheReadTokens: 900_000, totalTokens: 1_805_000, contextLimit: 100_000, contextSnapshot: { state: "unavailable" } };
    assert.equal((await callback({ event: "context:usage", usage: aggregate })).status, 200);
    assert.equal(await db.taskExecutionEpisode.count({ where: { taskId: pressure.task.id } }), 1, "billing totals cannot trigger pressure rollover");
    const sample = { ...aggregate, modelRunId: "latest-call", contextSnapshot: { state: "available", promptTokens: 75_000, limit: 100_000, source: "last_model_call" } };
    await callback({ event: "context:usage", usage: sample });
    await callback({ event: "context:usage", usage: sample });
    assert.equal(await db.taskExecutionEpisode.count({ where: { taskId: pressure.task.id } }), 2, "late duplicate cannot retire successor");
    assert.equal(await db.pmChannelContinuation.count({ where: { runId: pressure.run.id, action: "episode_rollover" } }), 1);
    assert.equal(await db.activityLog.count({ where: { taskId: pressure.task.id, kind: "pm.task.model_usage" } }), 2, "one durable usage row per correlated model run");

    const hard = await fixture("hard-limit");
    let last;
    for (let i = 0; i < 24; i++) last = await recordTaskExecutionToolCycle({ taskId: hard.task.id, agentSlug: agent.slug, messageId: hard.message.id, toolCycleBudget: 24 });
    assert.equal(last?.rolledOver, true, "ignoring checkpoint request still reaches the hard fence");
    assert.equal(await recordTaskExecutionToolCycle({ taskId: hard.task.id, agentSlug: agent.slug, messageId: hard.message.id, toolCycleBudget: 24 }), null, "late tool events do not charge successor");
    const heartbeat = await fixture("heartbeat");
    await applyPmChannelStreamCallback({ payload: { target: heartbeat.target, event: "tool:heartbeat" }, rateLimit: false });
    const live = await db.pmChannelRun.findUniqueOrThrow({ where: { id: heartbeat.run.id } });
    assert.ok(live.leaseExpiresAt && live.leaseExpiresAt > new Date());
    assert.equal(await db.pmChannelToolCall.count({ where: { runId: live.id } }), 0, "lease renewal is not a tool call");
    assert.equal(await db.pmChannelStreamEvent.count({ where: { runId: live.id } }), 0, "heartbeats do not flood activity history");
    assert.equal(episodeToolCycleBudgetForModel("anthropic", "large-model", 128_000), 18);
    assert.equal(episodeToolCycleBudgetForModel("anthropic", "large-model", 1_000_000), 30);
    process.env.PM_EPISODE_MAX_TOOL_CYCLES = "40";
    process.env.PM_EPISODE_TOOL_CYCLES_LARGE = "48";
    assert.equal(episodeToolCycleBudgetForModel("anthropic", "large-model", 1_000_000), 40, "configured global ceiling still clamps every context tier");

    const revision = await fixture("revision-cancellation");
    await db.pmChannelRun.update({ where: { id: revision.run.id }, data: { gatewayPort: 18789, gatewayDispatchId: "exact-generation", admittedAt: new Date() } });
    await db.agentExecutionLease.create({ data: { agentSlug: agent.slug, taskId: revision.task.id, runId: revision.run.id, status: "running" } });
    const caller = await db.pmChannelRun.create({ data: { targetKey: "revision-caller", kind: "task-comment", agentSlug: "reviewer", taskId: revision.task.id, messageId: "revision-caller", status: "streaming" } });
    const callerEpisode = await db.taskExecutionEpisode.create({ data: { taskId: revision.task.id, agentSlug: "reviewer", runId: caller.id, episodeNo: 1, cycleBudget: 6 } });
    await db.$transaction(tx => fenceTaskRunsForPlanRevision(tx, { taskId: revision.task.id, currentRunId: caller.id, expectedEpisodeId: callerEpisode.id }));
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: caller.id } })).status, "streaming", "authenticated revision caller survives until its terminal action");
    assert.equal((await db.taskExecutionEpisode.findUniqueOrThrow({ where: { id: callerEpisode.id } })).status, "open");
    assert.equal((await db.taskExecutionEpisode.findUniqueOrThrow({ where: { id: revision.episode.id } })).status, "closed");
    const cancelled = await db.pmChannelRun.findUniqueOrThrow({ where: { id: revision.run.id } });
    assert.equal(cancelled.status, "superseded");
    assert.equal(cancelled.supersededByRunId, null, "human/revision cancellation does not need replacement lineage");
    assert.ok(cancelled.cancellationRequestedAt);
    process.env.PM_OPENCLAW_CHANNEL_TOKEN_RUNTIME_WORKER = "isolated-test-token";
    const replacement = await db.pmChannelRun.create({ data: { targetKey: "revision-replacement", kind: "task-comment", agentSlug: agent.slug, taskId: revision.task.id, messageId: "replacement", status: "queued" } });
    const denied = await fenceSupersededPmChannelRuns({ replacementRunId: replacement.id, fetchImpl: async () => new Response(JSON.stringify({ reason: "abort_unavailable" })) });
    assert.equal(denied.ok, false, "replacement cannot bypass a task cancellation lacking lineage");
    assert.equal((await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: revision.run.id } })).status, "running", "failed abort retains the lane");
    await db.agentExecutionLease.update({ where: { runId: revision.run.id }, data: { expiresAt: new Date(0) } });
    assert.equal((await releaseExecutionLane({ runId: revision.run.id })).released, false, "late terminal callbacks cannot release an unfenced process");
    await reconcileAbandonedLeases();
    assert.equal((await reserveExecutionLane({ agentSlug: agent.slug, runId: replacement.id })).acquired, false, "expired leases remain held until pending cancellation is acknowledged");
    const acknowledged = await fenceSupersededPmChannelRuns({ replacementRunId: replacement.id, fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).gatewayDispatchId, "exact-generation");
      return new Response(JSON.stringify({ aborted: true }));
    } });
    assert.equal(acknowledged.ok, true);
    assert.equal((await db.agentExecutionLease.findUniqueOrThrow({ where: { runId: revision.run.id } })).status, "released");
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: revision.run.id } })).cancellationRequestedAt?.getTime(), cancelled.cancellationRequestedAt?.getTime(), "retry retains the original durable request timestamp");
    let lateAbort = false;
    await recordPmChannelRunDispatch({ target: revision.target, result: { ok: true, status: 202, driver: "openclaw-pm-channel", gatewayDispatchId: "late-http-generation" }, fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).gatewayDispatchId, "late-http-generation");
      lateAbort = true;
      return new Response(JSON.stringify({ aborted: true }));
    } });
    assert.ok(lateAbort, "late HTTP success invalidates earlier cancellation acknowledgement and fences its exact generation");
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: revision.run.id } })).status, "superseded", "late HTTP handoff cannot resurrect retired run");

    const interrupted = await fixture("retention-interrupted");
    for (const input of [{ event: "partial", delta: "Saved " }, { event: "partial", delta: "partial reply" }, { event: "reasoning", text: "Concise progress note" }, { event: "tool:call", toolName: "verify", toolCallId: "durable-job" }] as const) {
      await appendPmChannelStreamEvent({ runId: interrupted.run.id, event: input.event, input });
    }
    const aged = new Date(Date.now() - 40 * 86_400_000);
    await db.pmChannelRun.update({ where: { id: interrupted.run.id }, data: { status: "cancelled", updatedAt: aged, provider: "provider", model: "model" } });
    const oldJob = await db.pmChannelJob.create({ data: { runId: interrupted.run.id, agentSlug: agent.slug, kind: "task-comment", status: "canceled", payload: "large old prompt", updatedAt: aged } });
    const pendingJob = await db.pmChannelJob.create({ data: { runId: replacement.id, agentSlug: agent.slug, kind: "task-comment", status: "queued", payload: "pending dispatch prompt", updatedAt: aged } });
    const beforeRetention = await replayPmChannelStreamFrames({ runId: interrupted.run.id, target: interrupted.target, afterSeq: 0 });
    const retained = await maintainPmRuntimeHistory();
    assert.equal(retained.compactedRuns, 1);
    assert.equal(retained.trimmedJobs, 1);
    assert.equal(JSON.parse((await db.pmChannelJob.findUniqueOrThrow({ where: { id: oldJob.id } })).payload).retained, false);
    assert.equal((await db.pmChannelJob.findUniqueOrThrow({ where: { id: pendingJob.id } })).payload, "pending dispatch prompt", "retention never removes pending work");
    assert.equal(await db.pmChannelStreamEvent.count({ where: { runId: interrupted.run.id } }), 1);
    const afterRetention = await replayPmChannelStreamFrames({ runId: interrupted.run.id, target: interrupted.target, afterSeq: 0 });
    assert.equal(afterRetention[0].state.text, beforeRetention.at(-1)!.state.text);
    assert.equal(afterRetention[0].state.reasoning, "Concise progress note");
    assert.equal(afterRetention[0].state.toolCallId, "durable-job");
    assert.equal(afterRetention[0].state.runStatus, "cancelled");
    assert.equal(afterRetention[0].state.provider, "provider");
    assert.equal((await maintainPmRuntimeHistory()).compactedRuns, 0, "retention is idempotent");

    const fairProject = await db.project.create({ data: { slug: "fair-reconcile", name: "Fair reconciliation" } });
    for (let i = 0; i < 5; i++) await db.task.create({ data: { title: `Legacy done ${i}`, status: "Done", projectId: fairProject.id, workflowEngine: "legacy", updatedAt: aged } });
    const older = await db.task.create({ data: { title: "Older healthy candidate", projectId: fairProject.id, status: "To Do", updatedAt: aged } });
    const newer = await db.task.create({ data: { title: "New active missing cycle", projectId: fairProject.id, status: "In Progress" } });
    const firstPass = await runWorkflowReconciliation({ projectId: fairProject.id, limit: 1 });
    assert.equal(firstPass.inspectedTasks, 1);
    assert.equal(firstPass.findings.some(finding => finding.taskId === newer.id), false);
    const secondPass = await runWorkflowReconciliation({ projectId: fairProject.id, limit: 1 });
    assert.ok(secondPass.findings.some(finding => finding.taskId === newer.id && finding.kind === "in_progress_no_open_cycle"), "persistent cursor reaches newer task beyond unchanged first batch");
    assert.equal(await db.activityLog.count({ where: { taskId: older.id, kind: "task.workflow.reconciliation_required" } }), 0);
    console.log("PASS cooperative checkpoint persistence, durable verification references, exact successor, hard fallback, billing/context separation, heartbeat and idempotent completion");
    console.log("PASS revision cancellation retry and lane fencing, terminal stream snapshots and fair reconciliation");
  } finally {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
