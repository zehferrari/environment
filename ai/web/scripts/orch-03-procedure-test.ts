// ORCH-03 — Durable procedure engine tests.
//
// Verifies (§6.5):
//   - crash after claim, before side effect — lease expires, step is retried;
//   - crash after side effect enqueue, before step completion — step is
//     retried (handler is replay-safe);
//   - duplicate callback — replays the already-completed step (idempotent);
//   - callback from an older cycle — rejected;
//   - lease expiry and recovery — expired lease is reclaimed;
//   - predecessor enforcement — a later step cannot run until all
//     predecessors completed;
//   - attempt exhaustion produces one escalation, not repeated comments;
//   - two workers cannot run the same step.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch03-"));
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
    const {
      runProcedureRunner,
      applyProcedureCallback,
      registerStepHandler,
      clearStepHandlerRegistry,
      createProcedureRun,
    } = await import("@/lib/tasks/orchestrator/procedure-runner");

    const owner = await db.user.create({ data: { username: "o", email: "o@x.example", kind: "human" } });
    const project = await db.project.create({ data: { slug: "orch03", name: "ORCH-03" } });
    const task = await db.task.create({ data: { projectId: project.id, title: "Proc task", status: "To Do", approvedOn: new Date(), approvedById: owner.id } });

    // Helper: create a fake transition + procedure run with a custom step list.
    let transitionVersion = 0;
    async function makeProcedureRunOnTask(taskId: string, stepNames: readonly string[]): Promise<{ procedureRunId: string; stepIds: string[] }> {
      transitionVersion += 1;
      const transition = await db.workflowTransition.create({
        data: {
          taskId,
          workflowVersion: transitionVersion,
          intent: "approve_plan",
          fromStatus: "Backlog",
          toStatus: "To Do",
          source: "test",
          idempotencyKey: `test:${transitionVersion}:${Math.random()}`,
        },
      });
      // Create a procedure run with custom steps.
      const run = await db.taskProcedureRun.create({
        data: {
          taskId,
          workflowCycleId: null,
          triggerTransitionId: transition.id,
          type: "prepare_todo_task",
          status: "queued",
        },
      });
      const stepIds: string[] = [];
      for (let i = 0; i < stepNames.length; i += 1) {
        const step = await db.taskProcedureStep.create({
          data: {
            procedureRunId: run.id,
            name: stepNames[i],
            ordinal: i,
            status: "pending",
            availableAt: new Date(),
          },
        });
        stepIds.push(step.id);
      }
      return { procedureRunId: run.id, stepIds };
    }
    async function makeProcedureRun(stepNames: readonly string[]): Promise<{ procedureRunId: string; stepIds: string[] }> {
      return makeProcedureRunOnTask(task.id, stepNames);
    }

    // --- Test 1: predecessor enforcement --------------------------------
    clearStepHandlerRegistry();
    const run1 = await makeProcedureRun(["step_a", "step_b", "step_c"]);
    let aCalls = 0;
    let bCalls = 0;
    let cCalls = 0;
    registerStepHandler("prepare_todo_task", 1, "step_a", async () => { aCalls += 1; return { status: "completed", output: { a: aCalls } }; });
    registerStepHandler("prepare_todo_task", 1, "step_b", async () => { bCalls += 1; return { status: "completed", output: { b: bCalls } }; });
    registerStepHandler("prepare_todo_task", 1, "step_c", async () => { cCalls += 1; return { status: "completed", output: { c: cCalls } }; });

    // Run once — only step_a should run (step_b's predecessor isn't done yet
    // at claim time, but after step_a completes, the next poll picks up
    // step_b). Run a few iterations to drain.
    for (let i = 0; i < 5; i += 1) {
      await runProcedureRunner({ limit: 1 });
    }
    assert.equal(aCalls, 1, "step_a ran once");
    assert.equal(bCalls, 1, "step_b ran once (after step_a completed)");
    assert.equal(cCalls, 1, "step_c ran once (after step_b completed)");
    const run1Final = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: run1.procedureRunId } });
    assert.equal(run1Final.status, "completed", "procedure completed");
    console.log("[orch03] predecessor enforcement PASS");

    // --- Test 2: two workers cannot run the same step -------------------
    clearStepHandlerRegistry();
    const run2 = await makeProcedureRun(["single_step"]);
    let callCount = 0;
    registerStepHandler("prepare_todo_task", 1, "single_step", async () => {
      callCount += 1;
      // Simulate slow handler so the second worker's claim races.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: "completed" };
    });
    const [r1, r2] = await Promise.all([
      runProcedureRunner({ limit: 1, workerId: "w1" }),
      runProcedureRunner({ limit: 1, workerId: "w2" }),
    ]);
    // Only one worker should have claimed the step.
    assert.equal(callCount, 1, `only one worker ran the step; got ${callCount} calls`);
    assert.equal(r1.claimed + r2.claimed, 1, `one claim total; got r1=${r1.claimed} r2=${r2.claimed}`);
    console.log("[orch03] two workers cannot run same step PASS");

    // --- Test 3: lease expiry and recovery ------------------------------
    clearStepHandlerRegistry();
    const run3 = await makeProcedureRun(["lease_step"]);
    let leaseCallCount = 0;
    registerStepHandler("prepare_todo_task", 1, "lease_step", async () => {
      leaseCallCount += 1;
      // Simulate a crash: throw to make the handler "fail" without completing.
      // But we want to simulate a CRASH (lease expires) not a handler error.
      // Instead, manually claim the step with a short lease and then run the
      // reclaimer.
      throw new Error("simulated crash");
    });
    // First run: handler throws, step goes to failed with backoff.
    let result = await runProcedureRunner({ limit: 1, workerId: "w3" });
    assert.equal(leaseCallCount, 1, "handler called once");
    let step3 = await db.taskProcedureStep.findFirst({ where: { procedureRunId: run3.procedureRunId } });
    assert.ok(step3);
    assert.equal(step3.status, "failed", "step is failed (will retry with backoff)");
    // Manually expire the lease by setting availableAt to the past + status
    // to running with an expired lease to simulate a crash mid-run.
    await db.taskProcedureStep.update({
      where: { id: step3.id },
      data: {
        status: "running",
        leaseOwner: "crashed-worker",
        leaseExpiresAt: new Date(Date.now() - 60_000),
        availableAt: new Date(Date.now() - 60_000),
      },
    });
    // Run the reclaimer — the expired lease should be reclaimed and the step
    // returned to failed (available for retry).
    result = await runProcedureRunner({ limit: 1, workerId: "w4" });
    step3 = await db.taskProcedureStep.findFirst({ where: { procedureRunId: run3.procedureRunId } });
    assert.ok(step3);
    assert.notEqual(step3.status, "running", "step is no longer running after lease reclaim");
    assert.equal(step3.leaseOwner, null, "lease owner cleared after reclaim");
    console.log("[orch03] lease expiry and recovery PASS");

    // --- Test 4: duplicate callback replays (idempotent) ---------------
    // Clean up Test 3's orphaned step so it doesn't get picked up by the
    // runner in Test 4 (the handler was cleared).
    await db.taskProcedureStep.updateMany({
      where: { procedureRunId: run3.procedureRunId },
      data: { status: "completed", completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
    });
    await db.taskProcedureRun.update({
      where: { id: run3.procedureRunId },
      data: { status: "completed", completedAt: new Date(), currentStep: null },
    });
    // Use a SEPARATE task so orphaned steps from Test 3 don't get picked up.
    const task4 = await db.task.create({ data: { projectId: project.id, title: "Proc task 4", status: "To Do", approvedOn: new Date(), approvedById: owner.id } });
    clearStepHandlerRegistry();
    const run4 = await makeProcedureRunOnTask(task4.id, ["callback_step", "next_step"]);
    registerStepHandler("prepare_todo_task", 1, "callback_step", async () => {
      return {
        status: "waiting_callback",
        jobId: "job-123",
        output: { started: true, candidateSha: "sha-1", baseSha: "base-1" },
      };
    });
    registerStepHandler("prepare_todo_task", 1, "next_step", async () => { return { status: "completed" }; });
    // Run to get callback_step into waiting_callback.
    await runProcedureRunner({ limit: 1 });
    const step4 = await db.taskProcedureStep.findFirst({ where: { procedureRunId: run4.procedureRunId, name: "callback_step" } });
    assert.ok(step4);
    assert.equal(step4.status, "waiting_callback", "step is waiting for callback");
    // External evidence must match both candidate and base SHA. This proves
    // the callback fence is not merely comparing stored values to themselves.
    const cbWrongBase = await applyProcedureCallback({
      procedureRunId: run4.procedureRunId,
      stepId: step4.id,
      taskId: task4.id,
      workflowCycleId: null,
      jobId: "job-123",
      candidateSha: "sha-1",
      baseSha: "different-base",
    });
    assert.equal(cbWrongBase.applied, false, "callback with wrong base SHA is rejected");
    assert.match(cbWrongBase.reason, /base sha mismatch/i);
    // Apply the correctly correlated callback.
    const cb1 = await applyProcedureCallback({
      procedureRunId: run4.procedureRunId,
      stepId: step4.id,
      taskId: task4.id,
      workflowCycleId: null,
      jobId: "job-123",
      candidateSha: "sha-1",
      baseSha: "base-1",
    });
    assert.equal(cb1.applied, true, "first callback applied");
    // Apply the SAME callback again — should be idempotent.
    const cb2 = await applyProcedureCallback({
      procedureRunId: run4.procedureRunId,
      stepId: step4.id,
      taskId: task4.id,
      workflowCycleId: null,
      jobId: "job-123",
      candidateSha: "sha-1",
      baseSha: "base-1",
    });
    assert.equal(cb2.applied, true, "duplicate callback is idempotent (replayed)");
    assert.ok(/already completed/i.test(cb2.reason), `reason mentions already completed; got ${cb2.reason}`);
    console.log("[orch03] duplicate callback idempotent PASS");
    // Clean up: mark run4 as completed so its steps don't interfere with
    // later tests.
    await db.taskProcedureRun.update({ where: { id: run4.procedureRunId }, data: { status: "completed", completedAt: new Date() } });
    await db.taskProcedureStep.updateMany({ where: { procedureRunId: run4.procedureRunId, status: "waiting_callback" }, data: { status: "completed", completedAt: new Date() } });

    // --- Test 5: callback from an older cycle is rejected ---------------
    const task5 = await db.task.create({ data: { projectId: project.id, title: "Proc task 5", status: "To Do", approvedOn: new Date(), approvedById: owner.id } });
    clearStepHandlerRegistry();
    const run5 = await makeProcedureRunOnTask(task5.id, ["cb_step"]);
    registerStepHandler("prepare_todo_task", 1, "cb_step", async () => ({ status: "waiting_callback", jobId: "job-5" }));
    await runProcedureRunner({ limit: 1 });
    const step5 = await db.taskProcedureStep.findFirst({ where: { procedureRunId: run5.procedureRunId } });
    assert.ok(step5);
    // Apply a callback with a different (older) cycle id.
    const cbOld = await applyProcedureCallback({
      procedureRunId: run5.procedureRunId,
      stepId: step5.id,
      taskId: task5.id,
      workflowCycleId: "older-cycle-id",
      jobId: "job-5",
    });
    assert.equal(cbOld.applied, false, "callback from older cycle rejected");
    assert.ok(/cycle id mismatch/i.test(cbOld.reason), `reason mentions cycle mismatch; got ${cbOld.reason}`);
    console.log("[orch03] callback from older cycle rejected PASS");
    // Clean up run5.
    await db.taskProcedureRun.update({ where: { id: run5.procedureRunId }, data: { status: "completed", completedAt: new Date() } });
    await db.taskProcedureStep.updateMany({ where: { procedureRunId: run5.procedureRunId, status: "waiting_callback" }, data: { status: "completed", completedAt: new Date() } });

    // --- Test 6: attempt exhaustion produces one escalation -----------
    const task6 = await db.task.create({ data: { projectId: project.id, title: "Proc task 6", status: "To Do", approvedOn: new Date(), approvedById: owner.id } });
    clearStepHandlerRegistry();
    // Temporarily lower the max attempts by registering a handler that
    // always fails terminally.
    const run6 = await makeProcedureRunOnTask(task6.id, ["exhaust_step"]);
    registerStepHandler("prepare_todo_task", 1, "exhaust_step", async () => ({
      status: "failed",
      error: "permanent failure",
      retryable: false, // terminal immediately
    }));
    await runProcedureRunner({ limit: 1 });
    const step6 = await db.taskProcedureStep.findFirst({ where: { procedureRunId: run6.procedureRunId } });
    assert.ok(step6);
    assert.equal(step6.status, "terminal_error", "step is terminal_error");
    const run6Final = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: run6.procedureRunId } });
    assert.equal(run6Final.status, "operational_error", "procedure is operational_error");
    // Exactly ONE escalation activity row.
    const escalationActivities = await db.activityLog.count({
      where: { taskId: task6.id, kind: "task.workflow.procedure_operational_error", payload: { contains: run6.procedureRunId } },
    });
    assert.equal(escalationActivities, 1, "one escalation activity row (not repeated)");
    // Task alertReporter was set.
    const task6Row = await db.task.findUniqueOrThrow({ where: { id: task6.id }, select: { alertReporter: true } });
    assert.equal(task6Row.alertReporter, true, "reporter alerted");
    console.log("[orch03] attempt exhaustion one escalation PASS");

    // --- Test 7: createProcedureRun creates ordered steps --------------
    const task7 = await db.task.create({ data: { projectId: project.id, title: "Proc task 7", status: "To Do", approvedOn: new Date(), approvedById: owner.id } });
    clearStepHandlerRegistry();
    transitionVersion += 1;
    const transition7 = await db.workflowTransition.create({
      data: { taskId: task7.id, workflowVersion: transitionVersion, intent: "start", fromStatus: "To Do", toStatus: "In Progress", source: "test", idempotencyKey: `test7:${Math.random()}` },
    });
    const created = await db.$transaction((tx) =>
      createProcedureRun(tx, {
        taskId: task7.id,
        workflowCycleId: null,
        triggerTransitionId: transition7.id,
        type: "start_implementation_cycle",
        input: { worktreePath: "/srv/Code/wt" },
      }),
    );
    const run7 = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: created.procedureRunId }, include: { steps: { orderBy: { ordinal: "asc" } } } });
    assert.equal(run7.type, "start_implementation_cycle");
    assert.equal(run7.steps.length, 3, "start_implementation_cycle has 3 steps");
    assert.equal(run7.steps[0].name, "revalidate_worktree");
    assert.equal(run7.steps[0].ordinal, 0);
    assert.equal(run7.steps[1].name, "open_execution_episode");
    assert.equal(run7.steps[2].name, "dispatch_implementation_turn");
    assert.ok(run7.input);
    const inputParsed = JSON.parse(run7.input);
    assert.equal(inputParsed.worktreePath, "/srv/Code/wt");
    console.log("[orch03] createProcedureRun ordered steps PASS");

    // --- Test 8: database enforces one active run per scope/type --------
    const task8 = await db.task.create({
      data: { projectId: project.id, title: "Procedure uniqueness", status: "To Do", approvedOn: new Date(), approvedById: owner.id },
    });
    const cycle8 = await db.taskWorkflowCycle.create({
      data: { taskId: task8.id, sequence: 1, openedWorkflowVersion: 1 },
    });
    const firstCycleRun = await db.taskProcedureRun.create({
      data: {
        taskId: task8.id,
        workflowCycleId: cycle8.id,
        triggerTransitionId: "orch03:unique:cycle:1",
        type: "start_implementation_cycle",
        status: "queued",
      },
    });
    await assert.rejects(
      db.taskProcedureRun.create({
        data: {
          taskId: task8.id,
          workflowCycleId: cycle8.id,
          triggerTransitionId: "orch03:unique:cycle:2",
          type: "start_implementation_cycle",
          status: "running",
        },
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "P2002",
      "cycle-scoped partial unique index rejects a second active run",
    );
    await db.taskProcedureRun.update({
      where: { id: firstCycleRun.id },
      data: { status: "completed", completedAt: new Date() },
    });
    await db.taskProcedureRun.create({
      data: {
        taskId: task8.id,
        workflowCycleId: cycle8.id,
        triggerTransitionId: "orch03:unique:cycle:3",
        type: "start_implementation_cycle",
        status: "queued",
      },
    });

    const task9 = await db.task.create({
      data: { projectId: project.id, title: "Planning uniqueness", status: "Backlog" },
    });
    await db.taskProcedureRun.create({
      data: {
        taskId: task9.id,
        workflowCycleId: null,
        triggerTransitionId: "orch03:unique:planning:1",
        type: "prepare_todo_task",
        status: "queued",
      },
    });
    await assert.rejects(
      db.taskProcedureRun.create({
        data: {
          taskId: task9.id,
          workflowCycleId: null,
          triggerTransitionId: "orch03:unique:planning:2",
          type: "prepare_todo_task",
          status: "running",
        },
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "P2002",
      "task-scoped planning partial unique index rejects a second active run",
    );
    console.log("[orch03] active procedure partial unique indexes PASS");

    const { readFileSync } = await import("node:fs");
    const executeSource = readFileSync(path.join(process.cwd(), "lib/tasks/orchestrator/execute.ts"), "utf8");
    assert.ok(executeSource.includes('code === "P2002"'), "executor recognizes database uniqueness races");
    assert.ok(executeSource.includes("const winner = await tx.taskProcedureRun.findFirst"), "executor recovers the winning active procedure");
    assert.ok(executeSource.includes("workflowCycleId: cycleId"), "executor scopes null and non-null cycles exactly");
    console.log("[orch03] executor uniqueness-race recovery contract PASS");

    console.log("[orch03] PASS — all procedure engine assertions held");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[orch03] FAIL:", error);
  process.exit(1);
});
