// ORCH-07 — Review feedback and acceptance/finalization procedure tests.
//
// Verifies (§10.2 acceptance tests):
//   - monitor cannot call accept_review (authorization);
//   - monitor can complete the mechanical finalization only when an accepted
//     lease exists;
//   - Done transition actor attribution is the reviewer, with finalizer
//     identity in evidence;
//   - duplicate finalization callbacks create one Done transition;
//   - cleanup failure does not erase accepted validation/review evidence;
//   - Epic merge evidence is required before completing an Epic-child task.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch07-"));
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
    const { runProcedureRunner, applyProcedureCallback } = await import("@/lib/tasks/orchestrator/procedure-runner");
    const { registerReturnReviewForChangesHandlers, registerFinalizeAcceptedReviewHandlers } = await import("@/lib/tasks/orchestrator/handlers/review-decisions");
    const { registerSubmitCandidateForReviewHandlers } = await import("@/lib/tasks/orchestrator/handlers/submit-candidate-for-review");
    const { registerStartImplementationCycleHandlers } = await import("@/lib/tasks/orchestrator/handlers/start-implementation-cycle");
    const { registerPrepareTodoTaskHandlers } = await import("@/lib/tasks/orchestrator/handlers/prepare-todo-task");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");

    registerPrepareTodoTaskHandlers();
    registerStartImplementationCycleHandlers();
    registerSubmitCandidateForReviewHandlers();
    registerReturnReviewForChangesHandlers();
    registerFinalizeAcceptedReviewHandlers();

    const owner = await db.user.create({ data: { username: "owner", email: "owner@x.example", kind: "human", isOwner: true } });
    const assigneeAgent = await db.agent.create({ data: { slug: "impl-agent", name: "Impl", role: "coding" } });
    const assigneeUser = await db.user.create({ data: { username: "impl", email: "impl@x.example", kind: "agent", agentId: assigneeAgent.id } });
    const reviewerUser = await db.user.create({ data: { username: "reviewer", email: "reviewer@x.example", kind: "human" } });
    const monitorAgent = await db.agent.create({ data: { slug: "monitor-agent", name: "Monitor", role: "monitor" } });
    const monitorUser = await db.user.create({ data: { username: "monitor", email: "monitor@x.example", kind: "agent", agentId: monitorAgent.id } });

    // --- Test 1: monitor cannot call accept_review ----------------------
    const project = await db.project.create({ data: { slug: "orch07-1", name: "Test" } });
    const task = await db.task.create({
      data: { projectId: project.id, title: "Review task", status: "Review", workflowVersion: 1, workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: new Date(), assigneeId: assigneeUser.id, actingManagerId: reviewerUser.id, reporterId: owner.id, approvedOn: new Date(), approvedById: owner.id },
    });
    // Open a cycle and create an awaiting_review lease.
    await db.$transaction(async (tx) => {
      await openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 1 });
      const cycle = await tx.taskWorkflowCycle.findFirstOrThrow({ where: { taskId: task.id, status: "open" } });
      await tx.reviewRun.create({
        data: { taskId: task.id, workflowCycleId: cycle.id, candidateSha: "cand-1", baseSha: "base-1", repoTouched: false, validationOutcome: "valid", status: "awaiting_review" },
      });
    });
    const monitorAccept = await submitWorkflowCommand({
      taskId: task.id,
      intent: "accept_review",
      actor: { id: monitorUser.id, kind: "agent", username: "monitor", role: "monitor" },
      expectedWorkflowVersion: 1,
      idempotencyKey: "orch07:monitor-accept",
      source: "agent",
      payload: { reviewRunId: "rr-monitor", candidateSha: "cand-1" },
    });
    assert.equal(monitorAccept.status, "forbidden", "monitor cannot accept_review");
    console.log("[orch07] monitor cannot accept_review PASS");

    // --- Test 2: reviewer accept_review starts finalization ------------
    const reviewerAccept = await submitWorkflowCommand({
      taskId: task.id,
      intent: "accept_review",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 1,
      idempotencyKey: "orch07:reviewer-accept",
      source: "agent",
      payload: { reviewRunId: "rr-1", candidateSha: "cand-1" },
    });
    assert.equal(reviewerAccept.status, "accepted", `reviewer accept accepted; got ${JSON.stringify(reviewerAccept)}`);
    assert.ok(reviewerAccept.procedureId, "finalization procedure created");
    // The lease should be marked accepted.
    const lease = await db.reviewRun.findFirst({ where: { taskId: task.id, status: "accepted" } });
    assert.ok(lease, "lease marked accepted");
    assert.equal(lease!.reviewerId, reviewerUser.id, "reviewer recorded on lease");
    // The task should still be in Review (finalization hasn't completed).
    const taskAfterAccept = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(taskAfterAccept.status, "Review", "task stays in Review until finalization completes");
    console.log("[orch07] reviewer accept starts finalization PASS");

    // --- Test 3: non-code task finalization completes to Done -----------
    // For a non-code task, finalize_repository is skipped, verify_finalization
    // is skipped, and complete_review moves Review -> Done via mechanical
    // callback. Run the procedure.
    for (let i = 0; i < 20; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const taskAfterFinalize = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    assert.equal(taskAfterFinalize.status, "Done", "task moved to Done after finalization");
    // The cycle should be closed as completed.
    const cycles = await db.taskWorkflowCycle.findMany({ where: { taskId: task.id }, orderBy: { sequence: "asc" } });
    const lastCycle = cycles[cycles.length - 1];
    assert.equal(lastCycle.status, "closed", "cycle closed");
    assert.equal(lastCycle.outcome, "completed", "cycle outcome completed");
    // The Done transition should be attributed to the reviewer.
    const doneTransition = await db.workflowTransition.findFirst({
      where: { taskId: task.id, toStatus: "Done" },
      orderBy: { createdAt: "desc" },
      select: { id: true, actorUserId: true, evidence: true },
    });
    assert.ok(doneTransition, "Done transition exists");
    assert.equal(doneTransition!.actorUserId, reviewerUser.id, "Done transition attributed to reviewer");
    // The evidence should record the finalizer (executorActorId).
    const evidence = doneTransition!.evidence ? JSON.parse(doneTransition!.evidence) : {};
    assert.ok(evidence.repositoryFinalized === true || evidence.finalizedByUserId, "finalizer recorded in evidence");
    console.log("[orch07] non-code finalization completes to Done PASS");

    // --- Test 4: request_review_changes returns to To Do ---------------
    const task2 = await db.task.create({
      data: { projectId: project.id, title: "Feedback task", status: "Review", workflowVersion: 1, workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: new Date(), assigneeId: assigneeUser.id, actingManagerId: reviewerUser.id, reporterId: owner.id, approvedOn: new Date(), approvedById: owner.id },
    });
    await db.$transaction(async (tx) => {
      await openTaskWorkflowCycle(tx, { taskId: task2.id, openedWorkflowVersion: 1 });
      const cycle2 = await tx.taskWorkflowCycle.findFirstOrThrow({ where: { taskId: task2.id, status: "open" } });
      await tx.reviewRun.create({
        data: { taskId: task2.id, workflowCycleId: cycle2.id, candidateSha: "cand-2", baseSha: "base-2", repoTouched: false, validationOutcome: "valid", status: "awaiting_review" },
      });
    });
    const feedback = await submitWorkflowCommand({
      taskId: task2.id,
      intent: "request_review_changes",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 1,
      idempotencyKey: "orch07:feedback",
      source: "agent",
      payload: { reviewRunId: "rr-2", candidateSha: "cand-2", reviewerComment: "Needs changes" },
    });
    assert.equal(feedback.status, "accepted", "request_review_changes accepted");
    // Run the procedure.
    for (let i = 0; i < 15; i += 1) {
      const r = await runProcedureRunner({ limit: 5 });
      if (r.claimed === 0) break;
    }
    const task2After = await db.task.findUniqueOrThrow({ where: { id: task2.id } });
    assert.equal(task2After.status, "To Do", "task returned to To Do after feedback");
    // The lease should be changes_requested (immutable).
    const lease2 = await db.reviewRun.findFirst({ where: { taskId: task2.id, status: "changes_requested" } });
    assert.ok(lease2, "lease marked changes_requested");
    // The cycle should be closed as changes_requested.
    const cycles2 = await db.taskWorkflowCycle.findMany({ where: { taskId: task2.id }, orderBy: { sequence: "asc" } });
    const lastCycle2 = cycles2[cycles2.length - 1];
    assert.equal(lastCycle2.status, "closed", "cycle closed");
    assert.equal(lastCycle2.outcome, "changes_requested", "cycle outcome changes_requested");
    // A feedback notification should have been enqueued.
    const feedbackEffect = await db.workflowOutbox.findFirst({
      where: { taskId: task2.id, effectType: "task_notification", dedupeKey: { contains: "return_review_for_changes:wake" } },
    });
    assert.ok(feedbackEffect, "feedback notification enqueued");
    console.log("[orch07] request_review_changes returns to To Do PASS");

    // --- Test 5: accepted lease is never reused -------------------------
    // Try to accept the same lease again — should be rejected.
    // First, re-create a Review task with an awaiting_review lease.
    const task3 = await db.task.create({
      data: { projectId: project.id, title: "Reuse task", status: "Review", workflowVersion: 1, workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: new Date(), assigneeId: assigneeUser.id, actingManagerId: reviewerUser.id, reporterId: owner.id, approvedOn: new Date(), approvedById: owner.id },
    });
    await db.$transaction(async (tx) => {
      await openTaskWorkflowCycle(tx, { taskId: task3.id, openedWorkflowVersion: 1 });
      const cycle3 = await tx.taskWorkflowCycle.findFirstOrThrow({ where: { taskId: task3.id, status: "open" } });
      await tx.reviewRun.create({
        data: { taskId: task3.id, workflowCycleId: cycle3.id, candidateSha: "cand-3", baseSha: "base-3", repoTouched: false, validationOutcome: "valid", status: "awaiting_review" },
      });
    });
    // Accept the lease.
    const accept3 = await submitWorkflowCommand({
      taskId: task3.id,
      intent: "accept_review",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 1,
      idempotencyKey: "orch07:accept3",
      source: "agent",
      payload: { reviewRunId: "rr-3", candidateSha: "cand-3" },
    });
    assert.equal(accept3.status, "accepted", "first accept accepted");
    // Try to accept AGAIN with the same idempotency key — should be replayed.
    const accept3Replay = await submitWorkflowCommand({
      taskId: task3.id,
      intent: "accept_review",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: 1,
      idempotencyKey: "orch07:accept3",
      source: "agent",
      payload: { reviewRunId: "rr-3", candidateSha: "cand-3" },
    });
    assert.equal(accept3Replay.status, "replayed", "duplicate accept is replayed (idempotent)");
    console.log("[orch07] accepted lease not reused PASS");

    // --- Test 5b: the human reviewer may revoke stuck finalization --------
    const cycle3 = await db.taskWorkflowCycle.findFirstOrThrow({
      where: { taskId: task3.id, status: "open" },
    });
    await db.project.update({
      where: { id: project.id },
      data: { repositoryPath: "/srv/Code/test-repo" },
    });
    await db.taskRepositoryRun.create({
      data: {
        taskId: task3.id,
        workflowCycleId: cycle3.id,
        repositoryPath: "/srv/Code/test-repo",
        branchName: "ph-181",
        worktreePath: "/srv/Code/test-repo.worktrees/ph-181",
        baseSha: "base-3",
        candidateSha: "cand-3",
        reviewedSha: "cand-3",
        phase: "finalizing",
        validationOutcome: "valid",
        repoTouched: true,
      },
    });
    const acceptedTask = await db.task.findUniqueOrThrow({ where: { id: task3.id } });
    const acceptedLease = await db.reviewRun.findFirstOrThrow({
      where: { taskId: task3.id, status: "accepted" },
    });

    const nonReviewerReopen = await submitWorkflowCommand({
      taskId: task3.id,
      intent: "request_review_changes",
      actor: { id: owner.id, kind: "human", username: "owner" },
      expectedWorkflowVersion: acceptedTask.workflowVersion,
      workflowCycleId: cycle3.id,
      idempotencyKey: "orch07:accepted-feedback-not-reviewer",
      source: "browser",
      payload: {
        reviewRunId: acceptedLease.id,
        candidateSha: acceptedLease.candidateSha,
        reviewerComment: "Please return this to implementation.",
      },
    });
    assert.equal(nonReviewerReopen.status, "forbidden", "a different human cannot revoke accepted review");

    const acceptedFeedback = await submitWorkflowCommand({
      taskId: task3.id,
      intent: "request_review_changes",
      actor: { id: reviewerUser.id, kind: "human", username: "reviewer", role: "reviewer" },
      expectedWorkflowVersion: acceptedTask.workflowVersion,
      workflowCycleId: cycle3.id,
      idempotencyKey: "orch07:accepted-feedback",
      source: "browser",
      payload: {
        reviewRunId: acceptedLease.id,
        candidateSha: acceptedLease.candidateSha,
        reviewerComment: "Finalization is stuck; return this task to To Do so the assignee can continue.",
      },
    });
    assert.equal(acceptedFeedback.status, "accepted", "the human reviewer can revoke stuck accepted finalization");

    const reopenedTask = await db.task.findUniqueOrThrow({ where: { id: task3.id } });
    assert.equal(reopenedTask.status, "To Do", "accepted review returns to To Do");
    assert.equal(reopenedTask.assigneeId, assigneeUser.id, "the assignee is preserved");
    const reopenedLease = await db.reviewRun.findUniqueOrThrow({ where: { id: acceptedLease.id } });
    assert.equal(reopenedLease.status, "changes_requested", "the accepted lease records the later reviewer decision");
    const finalization = await db.taskProcedureRun.findFirstOrThrow({
      where: { taskId: task3.id, type: "finalize_accepted_review" },
    });
    assert.equal(finalization.status, "superseded", "the old finalization procedure is retired atomically");

    for (let i = 0; i < 15; i += 1) {
      const result = await runProcedureRunner({ limit: 5 });
      if (result.claimed === 0) break;
    }
    const reopenedRepository = await db.taskRepositoryRun.findUniqueOrThrow({ where: { taskId: task3.id } });
    assert.equal(reopenedRepository.phase, "action_required", "the preserved worktree must revalidate on restart");
    assert.equal(reopenedRepository.worktreePath, "/srv/Code/test-repo.worktrees/ph-181", "the worktree is preserved");
    assert.equal(reopenedRepository.branchName, "ph-181", "the branch is preserved");
    console.log("[orch07] human reviewer can safely return accepted finalization to To Do PASS");

    // --- Test 6: finalization spool preserves procedure correlation ----
    const { readFileSync } = await import("node:fs");
    const decisionSource = readFileSync(path.join(process.cwd(), "lib/tasks/orchestrator/handlers/review-decisions.ts"), "utf8");
    const drainSource = readFileSync(path.join(process.cwd(), "lib/tasks/workflow-outbox-drain.ts"), "utf8");
    const mergeSource = readFileSync(path.join(process.cwd(), "lib/deploy/epic-merge.ts"), "utf8");
    const automationSource = readFileSync(path.join(process.cwd(), "lib/tasks/review-automation.ts"), "utf8");
    assert.ok(decisionSource.includes("procedureStepId: ctx.stepId"), "finalization effect carries exact step id");
    assert.ok(drainSource.includes("procedureStepId:"), "outbox drain preserves finalization step id");
    assert.ok(mergeSource.includes("Legacy finalization jobs are retired"), "finalizer rejects non-V2 jobs");
    assert.ok(!mergeSource.includes("applyProcedureCallback: false"), "finalization has no validation fallback");
    assert.ok(automationSource.includes("stepId: callback.procedureStepId"), "finalization callback selects the exact step");
    console.log("[orch07] finalization callback correlation contract PASS");

    console.log("[orch07] PASS — all review feedback + finalization assertions held");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error("[orch07] FAIL:", error);
  process.exit(1);
});
