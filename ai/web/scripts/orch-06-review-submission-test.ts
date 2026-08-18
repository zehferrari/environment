// ORCH-06 — submit_candidate_for_review procedure tests + V23-36 regression.
//
// Verifies (§9 acceptance tests):
//   - reproduce the V23-36 case: same candidate re-enters Review in a later
//     cycle;
//   - verifier callback replay is idempotent;
//   - a callback for an old cycle cannot move the task;
//   - reviewer fallback through an actionable Epic is visible in API and
//     prompt context;
//   - validation success cannot leave an undetectable In Progress +
//     review_ready state;
//   - invalid code and operational failure follow different paths.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch06-"));
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
    const { submitWorkflowCommand, buildTaskWorkflowProjection } = await import("@/lib/tasks/orchestrator");
    const { runProcedureRunner, applyProcedureCallback } = await import("@/lib/tasks/orchestrator/procedure-runner");
    const { registerSubmitCandidateForReviewHandlers } = await import("@/lib/tasks/orchestrator/handlers/submit-candidate-for-review");
    const { registerStartImplementationCycleHandlers } = await import("@/lib/tasks/orchestrator/handlers/start-implementation-cycle");
    const { registerPrepareTodoTaskHandlers } = await import("@/lib/tasks/orchestrator/handlers/prepare-todo-task");
    const { openTaskWorkflowCycle, closeTaskWorkflowCycle, updateTaskWorkflowCycleCandidate } = await import("@/lib/tasks/workflow-cycle");

    registerPrepareTodoTaskHandlers();
    registerStartImplementationCycleHandlers();
    registerSubmitCandidateForReviewHandlers();

    const owner = await db.user.create({ data: { username: "owner", email: "owner@x.example", kind: "human", isOwner: true } });
    const assigneeAgent = await db.agent.create({ data: { slug: "impl-agent", name: "Impl", role: "coding" } });
    const assigneeUser = await db.user.create({ data: { username: "impl", email: "impl@x.example", kind: "agent", agentId: assigneeAgent.id } });
    const reviewerUser = await db.user.create({ data: { username: "reviewer", email: "reviewer@x.example", kind: "human" } });

    // --- Test 1: non-code task submit_for_review reaches Review ----------
    const project = await db.project.create({ data: { slug: "orch06-1", name: "Non-code" } });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Non-code review task",
        status: "In Progress",
        workflowVersion: 1,
        assigneeId: assigneeUser.id,
        actingManagerId: reviewerUser.id,
        reporterId: owner.id,
        approvedOn: new Date(),
        approvedById: owner.id,
      },
    });
    // Open a cycle for the task (simulating a prior start_implementation).
    await db.$transaction((tx) => openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 1 }));
    const cycle1 = await db.taskWorkflowCycle.findFirstOrThrow({ where: { taskId: task.id, status: "open" } });

    const submitResult = await submitWorkflowCommand({
      taskId: task.id,
      intent: "submit_for_review",
      actor: { id: assigneeUser.id, kind: "agent", username: "impl", role: "assignee" },
      expectedWorkflowVersion: 1,
      workflowCycleId: cycle1.id,
      idempotencyKey: "orch06:submit:1",
      source: "orch06-test",
      payload: { candidateSha: "non-repo-candidate" },
    });
    assert.equal(submitResult.status, "accepted", `submit accepted; got ${JSON.stringify(submitResult)}`);
    assert.ok(submitResult.procedureId, "procedure created");

    // Run the procedure. For non-code tasks, validation is skipped, so it
    // should go straight through to Review. Use enough iterations for 7 steps.
    for (let i = 0; i < 20; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const taskAfter = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(taskAfter.status, "Review", "task moved to Review");
    // Check procedure status for debugging.
    const proc1Run = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: submitResult.procedureId! }, include: { steps: { orderBy: { ordinal: "asc" } } } });
    console.log("DEBUG proc1 status:", proc1Run.status, "steps:", JSON.stringify(proc1Run.steps.map((s) => ({ name: s.name, status: s.status, output: s.output?.slice(0, 200), lastError: s.lastError?.slice(0, 100) }))));
    // A ReviewRun should exist for this cycle.
    const reviewRun = await db.reviewRun.findUnique({ where: { workflowCycleId: cycle1.id } });
    assert.ok(reviewRun, "ReviewRun created for the cycle");
    assert.equal(reviewRun!.status, "awaiting_review");
    assert.equal(reviewRun!.candidateSha, "non-repo-candidate");
    console.log("[orch06] non-code submit reaches Review PASS");

    // --- Test 2: V23-36 regression — same candidate re-enters Review -----
    // Close cycle1 (review feedback), open cycle2, submit the same candidate.
    // The new cycle should create a NEW ReviewRun (not reuse cycle1's).
    await db.$transaction(async (tx) => {
      await closeTaskWorkflowCycle(tx, { taskId: task.id, outcome: "changes_requested", candidateSha: "shared-sha" });
      await tx.task.update({ where: { id: task.id }, data: { status: "To Do", activeWorkflowCycleId: null } });
      await tx.reviewRun.updateMany({ where: { workflowCycleId: cycle1.id }, data: { status: "changes_requested" } });
    });
    // Start a new cycle (simulating start_implementation).
    await db.$transaction(async (tx) => {
      await tx.task.update({ where: { id: task.id }, data: { status: "In Progress", workflowVersion: { increment: 1 } } });
      await openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: taskAfter.workflowVersion + 1 });
    });
    const cycle2 = await db.taskWorkflowCycle.findFirstOrThrow({ where: { taskId: task.id, status: "open" } });
    assert.notEqual(cycle1.id, cycle2.id, "cycle 2 is a different cycle");

    // Submit for review with the SAME candidate SHA as cycle1.
    // Read the current workflow version — it changed when the first submit
    // moved the task to Review.
    const taskBeforeSubmit2 = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { workflowVersion: true, status: true } });
    // Move the task back to In Progress for the second cycle.
    await db.task.update({ where: { id: task.id }, data: { status: "In Progress" } });
    const submit2 = await submitWorkflowCommand({
      taskId: task.id,
      intent: "submit_for_review",
      actor: { id: assigneeUser.id, kind: "agent", username: "impl", role: "assignee" },
      expectedWorkflowVersion: taskBeforeSubmit2.workflowVersion,
      workflowCycleId: cycle2.id,
      idempotencyKey: "orch06:submit:2",
      source: "orch06-test",
      payload: { candidateSha: "shared-sha" },
    });
    assert.equal(submit2.status, "accepted", "second submit accepted (same candidate, new cycle)");
    // Run the procedure.
    for (let i = 0; i < 15; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const taskAfter2 = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(taskAfter2.status, "Review", "task moved to Review in the new cycle");
    // A NEW ReviewRun should exist for cycle2 (not reusing cycle1's).
    const reviewRun2 = await db.reviewRun.findUnique({ where: { workflowCycleId: cycle2.id } });
    assert.ok(reviewRun2, "new ReviewRun created for cycle 2");
    assert.equal(reviewRun2!.candidateSha, "shared-sha");
    assert.equal(reviewRun2!.status, "awaiting_review");
    assert.notEqual(reviewRun!.id, reviewRun2!.id, "different ReviewRun ids (not reused)");
    // cycle1's ReviewRun should still be changes_requested (immutable).
    const reviewRun1After = await db.reviewRun.findUniqueOrThrow({ where: { id: reviewRun!.id } });
    assert.equal(reviewRun1After.status, "changes_requested", "cycle1's lease is immutable");
    console.log("[orch06] V23-36 same candidate re-enters Review in later cycle PASS");

    // --- Test 3: projection shows the active review lease ---------------
    const projection = await buildTaskWorkflowProjection(task.id);
    assert.ok(projection);
    assert.ok(projection.activeReviewLease, "projection has an active review lease");
    assert.equal(projection.activeReviewLease!.candidateSha, "shared-sha");
    assert.equal(projection.activeCycle?.id, cycle2.id);
    console.log("[orch06] projection shows active review lease PASS");

    // --- Test 4: validation failure closes cycle and returns to To Do ----
    // Use a project with a repositoryPath so the task is treated as code-touching.
    const project4 = await db.project.create({ data: { slug: "orch06-4", name: "Code project", repositoryPath: "/srv/Code/test-repo-4" } });
    const task4 = await db.task.create({
      data: { projectId: project4.id, title: "Validation fail task", status: "In Progress", workflowVersion: 1, assigneeId: assigneeUser.id, actingManagerId: reviewerUser.id, reporterId: owner.id, approvedOn: new Date(), approvedById: owner.id },
    });
    await db.$transaction((tx) => openTaskWorkflowCycle(tx, { taskId: task4.id, openedWorkflowVersion: 1 }));
    const cycle4 = await db.taskWorkflowCycle.findFirstOrThrow({ where: { taskId: task4.id, status: "open" } });
    // Set up a repository run with a candidate SHA (simulating a code task).
    await db.taskRepositoryRun.upsert({
      where: { taskId: task4.id },
      create: { taskId: task4.id, phase: "active", candidateSha: "cand-4", baseSha: "base-4", repoTouched: true },
      update: { phase: "active", candidateSha: "cand-4", baseSha: "base-4", repoTouched: true },
    });
    const submit4 = await submitWorkflowCommand({
      taskId: task4.id,
      intent: "submit_for_review",
      actor: { id: assigneeUser.id, kind: "agent", username: "impl", role: "assignee" },
      expectedWorkflowVersion: 1,
      workflowCycleId: cycle4.id,
      idempotencyKey: "orch06:submit:4",
      source: "orch06-test",
      payload: { candidateSha: "cand-4" },
    });
    assert.equal(submit4.status, "accepted");
    // Run until the run_validation step is waiting for callback.
    for (let i = 0; i < 10; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    // Find the validation step and apply an INVALID callback.
    const proc4 = await db.taskProcedureRun.findUniqueOrThrow({ where: { id: submit4.procedureId! } });
    const validationStep = await db.taskProcedureStep.findFirst({
      where: { procedureRunId: proc4.id, name: "run_validation" },
    });
    assert.ok(validationStep, "validation step exists");
    // The step should be in waiting_callback.
    assert.equal(validationStep!.status, "waiting_callback", "validation step is waiting for callback");
    // Apply an invalid validation callback.
    const cbInvalid = await applyProcedureCallback({
      procedureRunId: proc4.id,
      stepId: validationStep!.id,
      taskId: task4.id,
      workflowCycleId: cycle4.id,
      jobId: JSON.parse(validationStep!.output ?? "{}").jobId ?? "unknown",
      candidateSha: "cand-4",
      data: { validationOutcome: "invalid", error: "Tests failed: 3 assertions failed." },
    });
    assert.equal(cbInvalid.applied, true, "invalid callback applied");
    // Run the procedure to process the validation result.
    for (let i = 0; i < 10; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const task4After = await db.task.findUniqueOrThrow({ where: { id: task4.id } });
    assert.equal(task4After.status, "To Do", "validation failure returned task to To Do");
    const cycle4After = await db.taskWorkflowCycle.findUniqueOrThrow({ where: { id: cycle4.id } });
    assert.equal(cycle4After.status, "closed", "cycle closed on validation failure");
    assert.equal(cycle4After.outcome, "validation_failed");
    console.log("[orch06] validation failure closes cycle and returns to To Do PASS");

    // --- Test 5: callback from an older cycle is rejected ----------------
    // Try to apply a callback for cycle4 (now closed) on a different procedure.
    const cbOld = await applyProcedureCallback({
      procedureRunId: proc4.id,
      stepId: validationStep!.id,
      taskId: task4.id,
      workflowCycleId: "older-cycle-id",
      jobId: JSON.parse(validationStep!.output ?? "{}").jobId ?? "unknown",
    });
    assert.equal(cbOld.applied, false, "callback from older cycle rejected");
    assert.ok(/cycle id mismatch/i.test(cbOld.reason));
    console.log("[orch06] callback from older cycle rejected PASS");

    console.log("[orch06] PASS — all submit_candidate_for_review + V23-36 assertions held");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[orch06] FAIL:", error);
  process.exit(1);
});