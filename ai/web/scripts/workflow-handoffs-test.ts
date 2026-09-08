// V23-38: revised plans must wake the reviewer, and start must preserve its turn.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

async function main() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "workflow-handoffs-"));
  process.env.DATABASE_URL = `file:${path.join(sandbox, "test.db")}`;
  process.env.PM_EPISODE_MAX_CYCLES = "6";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { runProcedureRunner } = await import("@/lib/tasks/orchestrator/procedure-runner");
    const { registerStartImplementationCycleHandlers } = await import("@/lib/tasks/orchestrator/handlers/start-implementation-cycle");
    const { registerPrepareTodoTaskHandlers } = await import("@/lib/tasks/orchestrator/handlers/prepare-todo-task");
    const { pmChannelRunTargetKey } = await import("@/lib/agents/pm-channel/runs");
    registerPrepareTodoTaskHandlers();
    registerStartImplementationCycleHandlers();
    const reviewer = await db.user.create({ data: { username: "reviewer", email: "reviewer@handoffs.invalid", kind: "human", isOwner: true } });
    const agent = await db.agent.create({ data: { slug: "worker", name: "Worker", role: "coding" } });
    const worker = await db.user.create({ data: { username: "worker", email: "worker@handoffs.invalid", kind: "agent", agentId: agent.id } });
    const project = await db.project.create({ data: { slug: "handoffs", name: "Handoffs" } });
    const task = await db.task.create({ data: {
      title: "Revised plan", projectId: project.id, assigneeId: worker.id,
      actingManagerId: reviewer.id, reporterId: reviewer.id,
    } });
    const actor = { id: worker.id, kind: "agent" as const, username: agent.slug, role: "assignee" as const, codingCapability: true };
    const submissions = [];
    for (let version = 1; version <= 2; version++) {
      const command = {
        taskId: task.id, intent: "submit_plan" as const, actor, source: "agent" as const,
        expectedWorkflowVersion: 0, idempotencyKey: `plan:${version}`,
        payload: { actionPlan: { summary: `Plan revision ${version}`, steps: [
          { id: "fix", title: `Implement revision ${version}`, acceptanceCriteria: ["Regression passes"], kind: "sequential" as const },
        ] } },
      };
      const result = await submitWorkflowCommand(command);
      assert.equal(result.status, "accepted", JSON.stringify(result));
      submissions.push(command);
      // Delivery of revision 1 must not suppress revision 2 while still in Backlog.
      await db.workflowOutbox.updateMany({ where: { taskId: task.id }, data: { status: "completed", completedAt: new Date() } });
    }
    const reviewEffects = await db.workflowOutbox.findMany({ where: { taskId: task.id, effectType: "task_notification" } });
    assert.equal(reviewEffects.length, 2, "every plan revision gets its own reviewer wake");
    assert.equal(new Set(reviewEffects.map((row) => row.dedupeKey)).size, 2);
    const replay = await submitWorkflowCommand(submissions[1]);
    assert.ok(["accepted", "replayed"].includes(replay.status), JSON.stringify(replay));
    assert.equal(await db.actionPlanRevision.count({ where: { taskId: task.id } }), 2, "retry does not create a revision");
    assert.equal(await db.workflowOutbox.count({ where: { taskId: task.id, effectType: "task_notification" } }), 2, "retry does not duplicate wake");
    console.log("PASS revised plan handoff and replay");

    const plan = await db.actionPlan.findUniqueOrThrow({ where: { taskId: task.id } });
    const approved = await submitWorkflowCommand({
      taskId: task.id, intent: "approve_plan", actor: { id: reviewer.id, kind: "human", username: "reviewer", role: "reviewer" },
      source: "agent", expectedWorkflowVersion: 0, idempotencyKey: "approve",
      payload: { actionPlanId: plan.id, actionPlanVersion: plan.version },
    });
    assert.equal(approved.status, "accepted", JSON.stringify(approved));
    const startWakes = () => db.workflowOutbox.findMany({ where: { taskId: task.id, effectType: "task_notification", status: { not: "completed" } } });
    assert.equal((await startWakes()).length, 0, "approval must wait for preparation before waking implementation");
    async function drainProcedures() {
      for (let i = 0; i < 10; i++) {
        if ((await runProcedureRunner({ limit: 5 })).claimed === 0) return;
      }
      throw new Error("Procedure drain did not settle");
    }
    await drainProcedures();
    assert.equal((await startWakes()).length, 1, "preparation sends exactly one start wake");
    console.log("PASS approval waits for preparation");

    const messageId = "start-message";
    const target = { kind: "task-comment" as const, agentSlug: agent.slug, taskId: task.id, messageId };
    const run = await db.pmChannelRun.create({ data: {
      targetKey: pmChannelRunTargetKey(target), ...target, projectId: project.id,
      status: "admitted", admittedAt: new Date(),
    } });
    await db.pmChannelJob.create({ data: { runId: run.id, agentSlug: agent.slug, kind: target.kind, payload: "{}", status: "accepted" } });
    const start = await submitWorkflowCommand({
      taskId: task.id, intent: "start_implementation", actor, source: "agent", expectedWorkflowVersion: 1,
      idempotencyKey: "start", messageId, payload: {},
      executionContext: { agentSlug: agent.slug, pmChannelRunId: run.id, sourceMessageId: messageId, publicAction: "start", expectedEpisodeId: null },
    });
    assert.equal(start.status, "accepted", JSON.stringify(start));
    assert.equal(start.actionEffect, "continue");
    const episodesBefore = await db.taskExecutionEpisode.findMany({ where: { taskId: task.id } });
    assert.equal(episodesBefore.length, 1);
    await drainProcedures();
    const episodesAfter = await db.taskExecutionEpisode.findMany({ where: { taskId: task.id } });
    assert.deepEqual(episodesAfter.map((row) => row.id), episodesBefore.map((row) => row.id), "procedure preserves the command-owned episode");
    assert.equal(await db.workflowOutbox.count({ where: { taskId: task.id, dedupeKey: { contains: "start_implementation_cycle:dispatch" } } }), 0, "procedure must not dispatch a replacement for the continuing start turn");
    assert.equal((await db.pmChannelJob.findFirstOrThrow({ where: { runId: run.id } })).status, "accepted");
    console.log("PASS authenticated start preserves its episode and continuing turn");

    const { buildTaskContextJson } = await import("@/lib/agents/context/api/serialize");
    for (const historyMode of ["recent", "full"] as const) {
      const context = await buildTaskContextJson(task.id, { agentSlug: agent.slug, historyMode });
      assert.ok(context?.actionPlan, "fresh episodes can retrieve the structured plan");
      assert.equal(context.actionPlan.version, 2);
      assert.equal(context.actionPlan.status, "approved");
      assert.equal(context.actionPlan.approvedById, reviewer.id);
      assert.deepEqual(context.actionPlan.steps.map((step) => [step.stepId, step.title, step.acceptanceCriteria]),
        [["fix", "Implement revision 2", ["Regression passes"]]]);
    }
    await db.task.update({ where: { id: task.id }, data: { private: true } });
    assert.equal(await buildTaskContextJson(task.id, { agentSlug: agent.slug }), null, "plan respects private-task access");
    console.log("PASS canonical plan context and access fence");

  } finally {
    await db.$disconnect();
    await rm(sandbox, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
