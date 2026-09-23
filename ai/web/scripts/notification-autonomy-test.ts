import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";

async function main() {
  const dir = await mkdtemp("/tmp/pm-notification-autonomy-");
  process.env.DATABASE_URL = `file:${dir}/test.db`;
  process.env.AUTH_SECRET = "isolated-notification-autonomy-test";
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.PM_TASK_RUNTIME_V2 = "0";
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { sendTaskCommentNotifications } = await import("@/lib/agents/workflow/notifications/task");
    const { continueActionableTaskAfterReply } = await import("@/lib/agents/workflow/execution-continuation");
    const { drainPmChannelContinuations } = await import("@/lib/agents/pm-channel/continuation-drain");
    const { channelDispatchAdmission, claimDispatchProbe, isPmTransportFailure } = await import("@/lib/agents/pm-channel/dispatch-breaker");
    const { queueTaskExecutionContinuation } = await import("@/lib/agents/pm-channel/continuations");
    const { recoveryPermissionWaitReason, readRecoveryBlocker } = await import("@/lib/tasks/recovery-permission");
    const { queueRecoveryContinuation } = await import("@/lib/agents/watchdog/repairs");
    const owner = await db.user.create({ data: { username: "owner", email: "owner@autonomy.invalid", kind: "human", isOwner: true } });
    const project = await db.project.create({ data: { slug: "autonomy", name: "Autonomy", workMode: "general" } });
    async function worker(slug: string) {
      const agent = await db.agent.create({ data: { slug, name: slug, role: "coding" } });
      return db.user.create({ data: { username: slug, email: `${slug}@autonomy.invalid`, kind: "agent", agentId: agent.id } });
    }
    const assignee = await worker("implementer");
    const reviewer = await worker("reviewer");
    const task = await db.task.create({ data: { title: "Directed owner instruction", projectId: project.id,
      status: "In Progress", assigneeId: assignee.id, actingManagerId: reviewer.id, reporterId: owner.id, approvedOn: new Date(0) } });
    const episode = await db.taskExecutionEpisode.create({ data: { taskId: task.id, agentSlug: "implementer",
      episodeNo: 1, status: "open", cycleBudget: 8, sessionKey: "pm:task:current-episode", messageId: "existing" } });
    const active = await db.pmChannelRun.create({ data: { targetKey: "existing", messageId: "existing", kind: "task-comment",
      taskId: task.id, agentSlug: "implementer", status: "streaming", sessionKey: episode.sessionKey } });
    const comment = await db.comment.create({ data: { taskId: task.id, userId: owner.id, body: "@implementer Please use the updated requirement." } });
    const notify = () => sendTaskCommentNotifications({ taskId: task.id, commentId: comment.id, body: comment.body,
      actor: { id: owner.id, kind: "human", username: "owner" } });
    await notify();
    await notify();
    assert.equal(await db.agentChatMessage.count({ where: { taskId: task.id, agentSlug: "reviewer" } }), 0, "unmentioned reviewer gets no turn");
    assert.equal(await db.agentChatMessage.count({ where: { originCommentId: comment.id } }), 1, "comment retry has one durable message");
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: active.id } })).status, "streaming", "owner instruction does not supersede active execution");
    const instruction = await db.pmChannelJob.findFirstOrThrow({ where: { agentSlug: "implementer" } });
    const instructionPayload = JSON.parse(instruction.payload);
    assert.equal(instructionPayload.sessionKey, episode.sessionKey, "instruction uses current execution episode");
    assert.equal(instructionPayload.preserveActiveRuns, true);
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: instruction.runId } })).status, "waiting_capacity");
    assert.equal(await db.pmChannelJob.count({ where: { agentSlug: "implementer" } }), 1);
    await queueTaskExecutionContinuation({ taskId: task.id, agentSlug: "implementer", action: "checkpoint_published" });
    await queueTaskExecutionContinuation({ taskId: task.id, agentSlug: "implementer", action: "checkpoint_published" });
    assert.equal(await db.pmChannelContinuation.count({ where: { taskId: task.id, action: "checkpoint_published", status: "armed" } }), 1);

    const autoTask = await db.task.create({ data: { title: "Reply race", projectId: project.id,
      status: "In Progress", assigneeId: assignee.id, reporterId: owner.id } });
    const source = await db.agentChatMessage.create({ data: { taskId: autoTask.id, projectId: project.id,
      agentSlug: "implementer", senderUserId: assignee.id, body: "Progress", originChannel: "comment" } });
    const run = await db.pmChannelRun.create({ data: { targetKey: "auto-source", kind: "task-comment", agentSlug: "implementer",
      taskId: autoTask.id, projectId: project.id, messageId: source.id, status: "completed" } });
    await db.activityLog.create({ data: { taskId: autoTask.id, kind: "task.workflow.notify",
      payload: JSON.stringify({ messageId: source.id, reason: "monitor_recovery" }) } });
    const target = { kind: "task-comment" as const, taskId: autoTask.id, agentSlug: "implementer", messageId: source.id, projectSlug: project.slug };
    await Promise.all(Array.from({ length: 3 }, () => continueActionableTaskAfterReply({ target, replyId: null })));
    assert.equal(await db.pmChannelContinuation.count({ where: { runId: run.id } }), 1, "racing callbacks create one obligation");
    assert.equal(await db.activityLog.count({ where: { taskId: autoTask.id, kind: "task.workflow.auto_continue" } }), 1);
    const continuation = await db.pmChannelContinuation.findFirstOrThrow({ where: { runId: run.id } });
    await db.pmChannelContinuation.update({ where: { id: continuation.id }, data: { status: "dispatched" } });
    await continueActionableTaskAfterReply({ target, replyId: null });
    assert.equal((await db.pmChannelContinuation.findUniqueOrThrow({ where: { id: continuation.id } })).status, "dispatched", "late callback cannot rearm");
    await db.pmChannelContinuation.update({ where: { id: continuation.id }, data: { status: "queued" } });

    const now = new Date();
    for (let i = 0; i < 5; i++) await db.pmChannelRun.create({ data: { targetKey: `transport-${i}`, messageId: `transport-${i}`,
      kind: "direct", agentSlug: "implementer", status: "failed", error: "fetch failed", updatedAt: now } });
    assert.equal(isPmTransportFailure({ status: "failed", error: "Agent finished without posting a reply.", finishedReason: "turn_failure_exhausted" }), false);
    assert.equal((await channelDispatchAdmission({ agentSlug: "implementer", now })).open, true);
    const probes = await Promise.all(Array.from({ length: 3 }, () => channelDispatchAdmission({ agentSlug: "implementer", workflowReason: "review_requested", now })));
    assert.equal(probes.filter(result => !result.open).length, 1, "critical wakes share one atomic probe");
    assert.equal(await claimDispatchProbe({ agentSlug: "implementer", now: new Date(now.getTime() + 1) }), false);
    await drainPmChannelContinuations({ limit: 1 });
    const retried = await db.pmChannelContinuation.findUniqueOrThrow({ where: { id: continuation.id } });
    assert.equal(retried.status, "queued", "suppressed transport retains its durable obligation");
    assert.equal(retried.attempts, 0, "breaker suppression must not consume a delivery retry before probes reopen");
    await db.pmChannelRun.create({ data: { targetKey: "healthy", messageId: "healthy", kind: "direct", agentSlug: "implementer", status: "completed" } });
    await db.pmChannelContinuation.update({ where: { id: continuation.id }, data: { availableAt: new Date(0) } });
    await drainPmChannelContinuations({ limit: 1 });
    assert.equal((await db.pmChannelContinuation.findUniqueOrThrow({ where: { id: continuation.id } })).status, "dispatched", "transport recovery dispatches the same obligation");

    const permissionTask = await db.task.create({ data: { title: "Consumed permission", workItemKey: "AUTO-3", branchName: "auto-3", projectId: project.id,
      status: "In Progress", assigneeId: assignee.id, approvedOn: new Date(0) } });
    const authorization = await db.comment.create({ data: { taskId: permissionTask.id, userId: owner.id,
      body: "I hereby authorize PM to publish the checkpoint for AUTO-3 on auto-3." } });
    await db.activityLog.create({ data: { taskId: permissionTask.id, kind: "task.blocker", payload: JSON.stringify({ commentId: "blocker",
      permissionRequest: { kind: "publish_checkpoint", scope: "auto-3", taskBranch: "auto-3" } }) } });
    await db.activityLog.create({ data: { taskId: permissionTask.id, kind: "task.blocker.permission.granted",
      payload: JSON.stringify({ blockerCommentId: "blocker", authorizationCommentId: authorization.id }) } });
    const blocker = await readRecoveryBlocker(permissionTask.id);
    assert.equal(await recoveryPermissionWaitReason(permissionTask.id, blocker), null);
    await db.activityLog.create({ data: { taskId: permissionTask.id, kind: "task.repository.checkpoint.requested",
      payload: JSON.stringify({ authorizationCommentId: authorization.id }) } });
    assert.equal(await recoveryPermissionWaitReason(permissionTask.id, blocker), "checkpoint_attempt_pending_settlement");
    const { taskRecoveryWaitReason } = await import("@/lib/tasks/recovery-permission");
    assert.equal(await taskRecoveryWaitReason(permissionTask.id, "implementer"), "checkpoint_attempt_pending_settlement");
    assert.equal((await queueRecoveryContinuation({ taskId: permissionTask.id, agentSlug: "implementer", now })).outcome, "noop");
    await db.comment.update({ where: { id: authorization.id }, data: { deletedAt: new Date() } });
    assert.equal(await recoveryPermissionWaitReason(permissionTask.id, blocker), "permission_no_longer_valid");
    console.log("PASS owner routing, episode queue, callback race, retry, bounded probe, grant-aware recovery");
  } catch (error) { console.error("AUTONOMY TEST FAILED", error); throw error; }
  finally { await db.$disconnect(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
