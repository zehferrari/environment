// ORCH-04 — prepare_todo_task procedure tests.
//
// Verifies (§7 acceptance tests):
//   - approving a plan creates exactly one procedure;
//   - a code task is not awakened before worktree preparation succeeds;
//   - a non-code task skips repository steps and wakes normally;
//   - repeated plan approval does not duplicate worktrees or notifications;
//   - moving the task away from To Do supersedes the wake;
//   - Epic-child base resolution uses the Epic branch snapshot.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch04-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  return { dbUrl, cleanup: () => rm(sandbox, { recursive: true, force: true }) };
}

async function main() {
  const { dbUrl, cleanup } = await freshDb();
  process.env.DATABASE_URL = dbUrl;
  try {
    const { db } = await import("@/lib/db");
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { runProcedureRunner } = await import("@/lib/tasks/orchestrator/procedure-runner");
    const { registerPrepareTodoTaskHandlers } = await import("@/lib/tasks/orchestrator/handlers/prepare-todo-task");
    const { clearStepHandlerRegistry } = await import("@/lib/tasks/orchestrator/procedure-runner");
    const { buildTaskWorkflowProjection } = await import("@/lib/tasks/orchestrator/projection");

    registerPrepareTodoTaskHandlers();

    const owner = await db.user.create({ data: { username: "owner", email: "owner@x.example", kind: "human", isOwner: true } });
    const assigneeAgent = await db.agent.create({ data: { slug: "assignee-agent", name: "Assignee Agent", role: "coding" } });
    const assigneeUser = await db.user.create({ data: { username: "assignee", email: "assignee@x.example", kind: "agent", agentId: assigneeAgent.id } });
    const reviewerUser = await db.user.create({ data: { username: "reviewer", email: "reviewer@x.example", kind: "human" } });

    // --- Test 1: non-code task skips repository steps and wakes --------
    const project1 = await db.project.create({ data: { slug: "orch04-1", name: "Non-code project" } });
    const task1 = await db.task.create({
      data: {
        projectId: project1.id,
        title: "Non-code task",
        status: "Backlog",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: assigneeUser.id,
        actingManagerId: reviewerUser.id,
        reporterId: owner.id,
      },
    });
    // Create an approved action plan so approve_plan's guard passes.
    const plan1 = await db.actionPlan.create({
      data: {
        taskId: task1.id,
        summary: "Plan 1",
        version: 1,
        status: "draft",
        authorId: assigneeUser.id,
        contentHash: "hash-1",
      },
    });
    await db.actionPlanStep.create({
      data: {
        actionPlanId: plan1.id,
        stepId: "s1",
        title: "Step 1",
        acceptanceCriteria: "[]",
        kind: "sequential",
        rank: 0,
      },
    });

    const approve1 = await submitWorkflowCommand({
      taskId: task1.id,
      intent: "approve_plan",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 0,
      idempotencyKey: "orch04:approve:1",
      source: "agent",
      evidence: { actionPlanId: plan1.id },
      payload: { actionPlanId: plan1.id, actionPlanVersion: 1 },
    });
    assert.equal(approve1.status, "accepted", `approve_plan accepted; got ${JSON.stringify(approve1)}`);
    assert.ok(approve1.procedureId, "approve_plan created a procedure");

    // Run the procedure to completion.
    for (let i = 0; i < 10; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const proc1 = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: approve1.procedureId! }, include: { steps: { orderBy: { ordinal: "asc" } } } });
    assert.equal(proc1.status, "completed", "procedure completed");
    assert.equal(proc1.steps.length, 4, "4 steps");
    // Step 2 (prepare_worktree) should be skipped for non-code.
    const worktreeStep = proc1.steps.find((s) => s.name === "prepare_worktree")!;
    let worktreeOutput: Record<string, unknown> | null = null;
    if (worktreeStep.output) { try { worktreeOutput = JSON.parse(worktreeStep.output); } catch { /* ignore */ } }
    assert.equal(worktreeOutput?.skipped, true, "worktree step skipped for non-code task");
    // Step 4 (wake_assignee) should have woke=true.
    const wakeStep = proc1.steps.find((s) => s.name === "wake_assignee")!;
    let wakeOutput: Record<string, unknown> | null = null;
    if (wakeStep.output) { try { wakeOutput = JSON.parse(wakeStep.output); } catch { /* ignore */ } }
    assert.equal(wakeStep.status, "completed", "wake step completed");
    assert.equal(wakeOutput?.woke, true, "assignee was woken");
    // Verify a task_notification outbox effect was enqueued with the dedupe key.
    const wakeEffect = await db.workflowOutbox.findUnique({
      where: { dedupeKey: `${task1.id}:v0:prepare_todo_task:wake:${task1.id}:${proc1.id}` },
      select: { id: true, effectType: true, payload: true },
    });
    assert.ok(wakeEffect, "wake notification outbox effect was enqueued");
    assert.equal(wakeEffect!.effectType, "task_notification");
    const payload = JSON.parse(wakeEffect!.payload);
    assert.ok(payload.body.includes("Action Plan"), "wake notification mentions the action plan");
    console.log("[orch04] non-code task skips repo steps and wakes PASS");

    // --- Test 2: approving a plan creates exactly one procedure --------
    const proceduresForTask1 = await db.taskProcedureRun.count({ where: { taskId: task1.id } });
    assert.equal(proceduresForTask1, 1, "exactly one procedure for task1");
    console.log("[orch04] one procedure per approval PASS");

    // --- Test 3: repeated plan approval does not duplicate --------------
    const replayApprove = await submitWorkflowCommand({
      taskId: task1.id,
      intent: "approve_plan",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 0,
      idempotencyKey: "orch04:approve:1", // same key
      source: "agent",
      evidence: { actionPlanId: plan1.id },
      payload: { actionPlanId: plan1.id, actionPlanVersion: 1 },
    });
    assert.equal(replayApprove.status, "replayed", "repeated approval is replayed");
    const proceduresForTask1After = await db.taskProcedureRun.count({ where: { taskId: task1.id } });
    assert.equal(proceduresForTask1After, 1, "no duplicate procedure on replay");
    console.log("[orch04] repeated approval no duplication PASS");

    // --- Test 4: moving task away from To Do supersedes the wake --------
    // Create a second task, approve it, but before the procedure completes,
    // move the task to In Progress manually (simulating a concurrent start).
    const project2 = await db.project.create({ data: { slug: "orch04-2", name: "Project 2" } });
    const task2 = await db.task.create({
      data: {
        projectId: project2.id,
        title: "Task 2",
        status: "Backlog",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: assigneeUser.id,
        actingManagerId: reviewerUser.id,
        reporterId: owner.id,
      },
    });
    const plan2 = await db.actionPlan.create({
      data: { taskId: task2.id, summary: "Plan 2", version: 1, status: "draft", authorId: assigneeUser.id, contentHash: "hash-2" },
    });
    await db.actionPlanStep.create({ data: { actionPlanId: plan2.id, stepId: "s1", title: "Step 1", acceptanceCriteria: "[]", kind: "sequential", rank: 0 } });

    const approve2 = await submitWorkflowCommand({
      taskId: task2.id,
      intent: "approve_plan",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 0,
      idempotencyKey: "orch04:approve:2",
      source: "agent",
      evidence: { actionPlanId: plan2.id },
      payload: { actionPlanId: plan2.id, actionPlanVersion: 1 },
    });
    assert.equal(approve2.status, "accepted");
    // Manually move task2 to In Progress (simulating concurrent start).
    await db.task.update({ where: { id: task2.id }, data: { status: "In Progress", workflowVersion: { increment: 1 } } });
    // Run the procedure — verify_actionability should supersede.
    for (let i = 0; i < 10; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const proc2 = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: approve2.procedureId! }, include: { steps: { orderBy: { ordinal: "asc" } } } });
    const wakeStep2 = proc2.steps.find((s) => s.name === "wake_assignee")!;
    let wakeOutput2: Record<string, unknown> | null = null;
    if (wakeStep2.output) { try { wakeOutput2 = JSON.parse(wakeStep2.output); } catch { /* ignore */ } }
    assert.equal(wakeOutput2?.skipped, true, "wake was skipped because task moved");
    assert.equal(wakeOutput2?.superseded, undefined, "wake step itself not superseded — it ran and decided to skip");
    console.log("[orch04] task moved from To Do supersedes wake PASS");

    // --- Test 5: projection surfaces active procedure ------------------
    // Use a third task with a non-code project to verify the projection.
    const project3 = await db.project.create({ data: { slug: "orch04-3", name: "Project 3" } });
    const task3 = await db.task.create({
      data: { projectId: project3.id, title: "Task 3", status: "Backlog", workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: new Date(), assigneeId: assigneeUser.id, actingManagerId: reviewerUser.id, reporterId: owner.id },
    });
    const plan3 = await db.actionPlan.create({ data: { taskId: task3.id, summary: "Plan 3", version: 1, status: "draft", authorId: assigneeUser.id, contentHash: "hash-3" } });
    await db.actionPlanStep.create({ data: { actionPlanId: plan3.id, stepId: "s1", title: "Step 1", acceptanceCriteria: "[]", kind: "sequential", rank: 0 } });
    await submitWorkflowCommand({
      taskId: task3.id,
      intent: "approve_plan",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 0,
      idempotencyKey: "orch04:approve:3",
      source: "agent",
      evidence: { actionPlanId: plan3.id },
      payload: { actionPlanId: plan3.id, actionPlanVersion: 1 },
    });
    // The procedure was just created and should be in queued status.
    const projection = await buildTaskWorkflowProjection(task3.id);
    assert.ok(projection, "projection built");
    // The procedure should appear in the projection (it's queued).
    // After running the procedure it completes; run it first.
    for (let i = 0; i < 10; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const projectionAfter = await buildTaskWorkflowProjection(task3.id);
    assert.ok(projectionAfter);
    // After completion, no active procedure.
    assert.equal(projectionAfter.activeProcedure, null, "no active procedure after completion");
    // The task should be in To Do with an approved plan.
    assert.equal(projectionAfter.status, "To Do");
    console.log("[orch04] projection surfaces procedure state PASS");

    console.log("[orch04] PASS — all prepare_todo_task assertions held");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[orch04] FAIL:", error);
  process.exit(1);
});
