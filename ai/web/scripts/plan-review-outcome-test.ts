import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), "plan-review-outcome-"));
  Object.assign(process.env, { DATABASE_URL: `file:${dir}/test.db`, AUTH_SECRET: "outcome-test",
    PM_TASK_RUNTIME_V2: "1", PM_ASYNC_DISPATCH: "1", PM_ASYNC_DISPATCH_INLINE_NUDGE: "0",
    PM_AGENT_CONFIG_ROOT: `${dir}/agents` });
  mkdirSync(`${dir}/agents/reviewer`, { recursive: true });
  writeFileSync(`${dir}/agents/reviewer/openclaw.json`, JSON.stringify({ agents: { defaults: { model: { primary: "openai/test" } } } }));
  execFileSync("pnpm", ["prisma", "migrate", "deploy"], { env: process.env, stdio: "pipe" });
  const { db } = await import("@/lib/db");
  try {
    const { sendTaskWorkflowNotification } = await import("@/lib/agents/workflow/notifications/task");
    const { applyPmChannelStreamCallback } = await import("@/lib/agents/pm-channel/stream-callback");
    const { flagMissingTaskPlanOutcome } = await import("@/lib/agents/pm-channel/task-outcome");
    const { drainWorkflowOutbox } = await import("@/lib/tasks/workflow-outbox-drain");
    const owner = await db.user.create({ data: { username: "owner", email: "owner@outcome.test", kind: "human", isOwner: true } });
    const agent = await db.agent.create({ data: { slug: "reviewer", name: "Reviewer", role: "coding" } });
    const reviewer = await db.user.create({ data: { username: "reviewer", email: "reviewer@outcome.test", kind: "agent", agentId: agent.id } });
    const workerAgent = await db.agent.create({ data: { slug: "worker", name: "Worker", role: "coding" } });
    const worker = await db.user.create({ data: { username: "worker", email: "worker@outcome.test", kind: "agent", agentId: workerAgent.id } });
    const project = await db.project.create({ data: { slug: "outcome", name: "Outcome" } });
    let serial = 0;
    const fixture = async () => {
      const task = await db.task.create({ data: { title: "Review a submitted plan", projectId: project.id,
        assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
      const plan = await db.actionPlan.create({ data: { taskId: task.id, summary: "Make the focused fix", authorId: worker.id } });
      return { task, plan };
    };
    const notify = async (taskId: string) => {
      const key = `review-${++serial}`;
      await sendTaskWorkflowNotification({ taskId, targetUserId: reviewer.id,
        actor: { id: worker.id, kind: "agent" }, reason: "action_plan_review_requested",
        body: "A structured Action Plan is ready for review.", dedupeKey: key });
      const message = await db.agentChatMessage.findUniqueOrThrow({ where: { workflowDedupeKey: key } });
      const run = await db.pmChannelRun.findFirstOrThrow({ where: { messageId: message.id } });
      const job = await db.pmChannelJob.findUniqueOrThrow({ where: { runId: run.id } });
      return { run, payload: JSON.parse(job.payload), job };
    };
    const finish = async (turn: Awaited<ReturnType<typeof notify>>, text = "NO_REPLY") => {
      await db.pmChannelRun.update({ where: { id: turn.run.id }, data: { status: "admitted" } });
      for (const event of ["final", "turn:terminal", "done"]) {
        const response = await applyPmChannelStreamCallback({ payload: { target: turn.payload.replyTarget, event,
          ...(event === "final" ? { text } : {}) }, rateLimit: false });
        assert.equal(response.status, 200, JSON.stringify(response));
      }
    };
    const { task, plan } = await fixture();
    const first = await notify(task.id);
    assert.equal(first.payload.expectedWorkflowAction, "review_plan");
    assert.deepEqual(first.payload.expectedActionPlan, { id: plan.id, version: 1 });
    assert.match(first.payload.systemPrompt, /REQUIRED PLAN REVIEW/);
    await finish(first);
    assert.equal((await db.pmChannelRun.findUniqueOrThrow({ where: { id: first.run.id } })).disposition, "failed");
    assert.equal(await db.activityLog.count({ where: { taskId: task.id, kind: "task.workflow.outcome_missing" } }), 1);
    assert.equal(await db.workflowOutbox.count({ where: { taskId: task.id } }), 1);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).alertReporter, false);
    await drainWorkflowOutbox();
    const recovery = await db.pmChannelRun.findFirstOrThrow({ where: { taskId: task.id, id: { not: first.run.id } } });
    const job = await db.pmChannelJob.findUniqueOrThrow({ where: { runId: recovery.id } });
    await finish({ run: recovery, job, payload: JSON.parse(job.payload) });
    assert.equal(await db.workflowOutbox.count({ where: { taskId: task.id } }), 1, "no retry loop");
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: task.id } })).alertReporter, true);
    assert.equal((await db.actionPlan.findUniqueOrThrow({ where: { id: plan.id } })).version, 1, "recovery preserves the submitted plan");
    console.log("PASS silent review callbacks queue one durable retry, then alert without resetting the plan");

    for (const state of ["revision_required", "accepted", "approved", "reassigned", "revised", "settled", "ordinary"]) {
      const f = await fixture(); const turn = await notify(f.task.id);
      if (state === "revision_required") await db.actionPlan.update({ where: { id: f.plan.id }, data: { status: "revision_required" } });
      if (state === "accepted") {
        await db.project.update({ where: { id: project.id }, data: { onlyReportersCanApproveActionPlans: true } });
        await db.actionPlan.update({ where: { id: f.plan.id }, data: { reviewedAt: new Date(), reviewedById: reviewer.id } });
      }
      if (state === "approved") await db.task.update({ where: { id: f.task.id }, data: { approvedOn: new Date() } });
      if (state === "reassigned") await db.task.update({ where: { id: f.task.id }, data: { actingManagerId: owner.id } });
      if (state === "revised") await db.actionPlan.update({ where: { id: f.plan.id }, data: { version: 2 } });
      if (state === "settled") await db.pmChannelRun.update({ where: { id: turn.run.id }, data: { settledByAction: "request_plan_changes" } });
      if (state === "ordinary") {
        const payload = { ...turn.payload }; delete payload.expectedWorkflowAction; delete payload.workflowReason;
        await db.pmChannelJob.update({ where: { id: turn.job.id }, data: { payload: JSON.stringify(payload) } });
      }
      await finish(turn);
      assert.equal(await db.workflowOutbox.count({ where: { taskId: f.task.id } }), 0, state);
      await db.project.update({ where: { id: project.id }, data: { onlyReportersCanApproveActionPlans: false } });
    }
    console.log("PASS accepted, changed, stale, settled and context-only reviews never trigger recovery");
    const stale = await fixture(); const staleTurn = await notify(stale.task.id);
    await finish(staleTurn, "The plan looks good.");
    assert.equal(await db.workflowOutbox.count({ where: { taskId: stale.task.id } }), 1, "prose is not a decision");
    await db.actionPlan.update({ where: { id: stale.plan.id }, data: { version: 2 } });
    await drainWorkflowOutbox();
    assert.equal(await db.pmChannelRun.count({ where: { taskId: stale.task.id } }), 1, "stale queued recovery is fenced at delivery");
    const legacy = await fixture(); const legacyTurn = await notify(legacy.task.id);
    const legacyPayload = { ...legacyTurn.payload }; delete legacyPayload.expectedWorkflowAction; delete legacyPayload.expectedActionPlan;
    await db.pmChannelJob.update({ where: { id: legacyTurn.job.id }, data: { payload: JSON.stringify(legacyPayload) } });
    await finish(legacyTurn);
    assert.equal(await db.workflowOutbox.count({ where: { taskId: legacy.task.id } }), 1, "pre-fix dispatched reviews remain recoverable");
    const newer = await fixture(); const older = await notify(newer.task.id); await notify(newer.task.id);
    await db.pmChannelRun.update({ where: { id: older.run.id }, data: { status: "completed" } });
    assert.equal(await flagMissingTaskPlanOutcome(older.payload.replyTarget), false, "newer wake owns review");
    console.log("PASS prose-only review and delayed callbacks cannot bypass the decision or revision guards");
  } finally { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
