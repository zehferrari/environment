import "./lib/next-als-polyfill";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";

async function main() {
  const dir = await mkdtemp("/tmp/pm-acceptance-");
  process.env.DATABASE_URL = `file:${dir}/test.db`;
  process.env.AUTH_SECRET = "acceptance-isolated-test";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");
    const { setSubTaskCompletion, deleteSubTaskItem } = await import("@/lib/tasks/subtasks");
    const { assertEpicReleaseChecksComplete } = await import("@/lib/tasks/acceptance");
    const { resumeReviewAfterOwnerAcceptance } = await import("@/lib/tasks/orchestrator/intents/owner-acceptance");
    const { loadTaskAggregate } = await import("@/lib/tasks/orchestrator/state");
    const { guardSubmitForReviewChecklist, guardAcceptReviewChecklist } = await import("@/lib/tasks/orchestrator/guards");
    const owner = await db.user.create({ data: { username: "owner", email: "owner@acceptance.invalid", kind: "human", isOwner: true } });
    const outsider = await db.user.create({ data: { username: "outsider", email: "outsider@acceptance.invalid", kind: "human" } });
    const users = [];
    for (const slug of ["worker", "reviewer"]) {
      const agent = await db.agent.create({ data: { slug, name: slug, role: "coding" } });
      users.push(await db.user.create({ data: { username: slug, email: `${slug}@acceptance.invalid`, kind: "agent", agentId: agent.id } }));
    }
    const [worker, reviewer] = users;
    const project = await db.project.create({ data: { slug: "acceptance", name: "Acceptance", workMode: "general" } });
    const epic = await db.epic.create({ data: { projectId: project.id, title: "Release", status: "In Progress" } });
    let seq = 0;
    async function fixture(gate = "task", code = false) {
      const task = await db.task.create({ data: { projectId: project.id, epicId: gate === "epic_release" ? epic.id : null,
        title: `Acceptance ${++seq}`, status: "Review", workflowVersion: 1, approvedOn: new Date(),
        assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
      await db.actionPlan.create({ data: { taskId: task.id, summary: "Approved", status: "approved", version: 1, contentHash: "approved-plan", approvedOn: new Date() } });
      const cycle = await db.$transaction(tx => openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 1 }));
      const review = await db.reviewRun.create({ data: { taskId: task.id, workflowCycleId: cycle!.id,
        candidateSha: "a".repeat(40), repoTouched: code, validationOutcome: "valid" } });
      if (code) await db.taskRepositoryRun.create({ data: { taskId: task.id, workflowCycleId: cycle!.id,
        candidateSha: review.candidateSha, baseSha: "b".repeat(40), repoTouched: true, phase: "awaiting_review" } });
      const check = await db.subTask.create({ data: { taskId: task.id, text: "Owner device observation",
        kind: "review", responsibleActor: "owner", acceptanceGate: gate, verificationEnvironment: "physical device" } });
      await db.subTask.create({ data: { taskId: task.id, text: "Superseded criterion", kind: "superseded" } });
      return { task, cycle: cycle!, review, check };
    }
    async function accept(f: Awaited<ReturnType<typeof fixture>>) {
      const result = await submitWorkflowCommand({ taskId: f.task.id, intent: "accept_review", actor: { id: reviewer.id, kind: "agent", username: reviewer.username },
        expectedWorkflowVersion: 1, workflowCycleId: f.cycle.id, idempotencyKey: `accept:${f.task.id}`, source: "agent",
        payload: { reviewRunId: f.review.id, candidateSha: f.review.candidateSha } });
      assert.equal(result.status, "accepted", JSON.stringify(result));
      return result;
    }
    const f = await fixture();
    const aggregate = (await loadTaskAggregate(f.task.id))!;
    assert.equal(guardSubmitForReviewChecklist(aggregate, "submit_for_review").ok, true);
    assert.equal(guardAcceptReviewChecklist(aggregate).ok, true);
    assert.equal(aggregate.openOwnerAcceptance?.count, 1);
    await accept(f);
    assert.equal((await db.reviewRun.findUniqueOrThrow({ where: { id: f.review.id } })).status, "accepted_pending_owner");
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: f.task.id } }), 0);
    const { taskRecoveryWaitReason } = await import("@/lib/tasks/recovery-permission");
    assert.equal(await taskRecoveryWaitReason(f.task.id, "reviewer"), "accepted_review_awaits_owner_evidence");
    assert.equal(await db.workflowOutbox.count({ where: { taskId: f.task.id, effectType: "task_notification" } }), 1);
    for (const actor of [worker, reviewer, outsider]) await assert.rejects(setSubTaskCompletion({ subTaskId: f.check.id, completed: true, actorUserId: actor.id, completionEvidence: "Claimed evidence" }), /human owner/);
    await assert.rejects(deleteSubTaskItem({ subTaskId: f.check.id, actorUserId: owner.id }), /cannot be deleted/);
    await Promise.all([undefined, ""].map(completionEvidence => setSubTaskCompletion({ subTaskId: f.check.id, completed: true, actorUserId: owner.id, completionEvidence })));
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: f.task.id, type: "finalize_accepted_review" } }), 1);
    const accepted = await db.reviewRun.findUniqueOrThrow({ where: { id: f.review.id } });
    assert.equal(accepted.status, "accepted"); assert.equal(accepted.reviewerId, reviewer.id);
    await assert.rejects(setSubTaskCompletion({ subTaskId: f.check.id, completed: false, actorUserId: owner.id }), /accepted verdict/);
    const item = await db.subTask.findUniqueOrThrow({ where: { id: f.check.id } });
    assert.equal(item.completedById, owner.id); assert.ok(item.completedAt);
    assert.equal(item.completionEvidence, null, "owner click records acceptance without inventing verification evidence");
    assert.equal(await db.activityLog.count({ where: { taskId: f.task.id, kind: "task.subtask.complete", userId: owner.id } }), 1,
      "duplicate owner clicks retain a single acceptance audit");
    const audit = await db.activityLog.findFirstOrThrow({ where: { taskId: f.task.id, kind: "task.review.owner_acceptance_completed" } });
    assert.equal(audit.userId, owner.id); assert.equal(JSON.parse(audit.payload!).reviewerId, reviewer.id);
    await import("@/lib/tasks/orchestrator/handlers");
    const { runProcedureRunner } = await import("@/lib/tasks/orchestrator/procedure-runner");
    await runProcedureRunner({ limit: 3, workerId: "acceptance-test" });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).status, "Done", "non-repository conditional acceptance finalizes without a new reviewer turn");

    for (const mutation of ["plan", "checklist", "candidate"]) {
      const stale = await fixture("task", true); await accept(stale);
      if (mutation === "plan") await db.actionPlan.update({ where: { taskId: stale.task.id }, data: { version: 2, contentHash: "changed" } });
      if (mutation === "checklist") await db.subTask.update({ where: { id: stale.check.id }, data: { text: "Changed owner requirement" } });
      if (mutation === "candidate") await db.taskRepositoryRun.update({ where: { taskId: stale.task.id }, data: { candidateSha: "c".repeat(40) } });
      await setSubTaskCompletion({ subTaskId: stale.check.id, completed: true, actorUserId: owner.id, completionEvidence: "Observation recorded; verdict requires revalidation." });
      assert.equal(await db.taskProcedureRun.count({ where: { taskId: stale.task.id } }), 0, mutation);
      assert.equal((await db.reviewRun.findUniqueOrThrow({ where: { id: stale.review.id } })).status, "accepted_pending_owner");
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: stale.task.id } })).alertReporter, true);
      assert.equal(await db.activityLog.count({ where: { taskId: stale.task.id, kind: "task.review.acceptance_stale" } }), 1);
    }
    const release = await fixture("epic_release");
    await accept(release);
    assert.equal((await db.reviewRun.findUniqueOrThrow({ where: { id: release.review.id } })).status, "accepted", "explicit release gate allows child integration");
    await assert.rejects(assertEpicReleaseChecksComplete(db, epic.id), /owner_acceptance_pending/);
    await setSubTaskCompletion({ subTaskId: release.check.id, completed: true, actorUserId: owner.id, completionEvidence: "Owner verified combined release." });
    await assertEpicReleaseChecksComplete(db, epic.id);
    await db.$transaction(tx => resumeReviewAfterOwnerAcceptance(tx, { taskId: release.task.id, actorUserId: owner.id }));
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: release.task.id } }), 1);
    console.log("PASS conditional acceptance, owner checkbox acceptance without required evidence, concurrent completion, unchanged verdict, non-code finalization, stale plan/criteria/candidate and Epic release gate");
  } finally {
    await db.$disconnect();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
