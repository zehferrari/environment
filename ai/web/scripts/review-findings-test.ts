import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { TaskWorkflowCommand } from "@/lib/tasks/orchestrator/types";

async function main() {
  const root = await mkdtemp(`${tmpdir()}/review-findings-`);
  process.env.DATABASE_URL = `file:${root}/test.db`;
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");
    const { setSubTaskCompletion, deleteSubTaskItem } = await import("@/lib/tasks/subtasks");
    const { loadTaskAggregate } = await import("@/lib/tasks/orchestrator/state");
    const { guardSubmitForReviewChecklist, guardAcceptReviewChecklist } = await import("@/lib/tasks/orchestrator/guards");
    const owner = await db.user.create({ data: { username: "owner", email: "owner@example.test", kind: "human", isOwner: true } });
    const users = [];
    for (const slug of ["assignee", "reviewer", "outsider"]) {
      const agent = await db.agent.create({ data: { slug, name: slug, role: "coding" } });
      users.push(await db.user.create({ data: { username: slug, email: `${slug}@example.test`, kind: "agent", agentId: agent.id } }));
    }
    const [worker, reviewer, outsider] = users;
    const project = await db.project.create({ data: { slug: "review-findings", name: "Review findings" } });
    let seq = 0;
    async function fixture() {
      const task = await db.task.create({ data: { projectId: project.id, title: `Task ${++seq}`, status: "Review", workflowVersion: 1, workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: new Date(), approvedOn: new Date(), assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
      const cycle = await db.$transaction(tx => openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 1 }));
      const review = await db.reviewRun.create({ data: { taskId: task.id, workflowCycleId: cycle!.id, candidateSha: "a".repeat(40), repoTouched: false, validationOutcome: "valid", status: "awaiting_review" } });
      const command: TaskWorkflowCommand = { taskId: task.id, intent: "request_review_changes", actor: { id: reviewer.id, kind: "agent", username: reviewer.username }, expectedWorkflowVersion: 1, workflowCycleId: cycle!.id, idempotencyKey: `review-${task.id}`, source: "agent", payload: { reviewRunId: review.id, candidateSha: review.candidateSha, reviewerComment: "Correct these defects within the approved scope.", findings: [
        { title: "Keep paid totals consistent", acceptanceCriteria: "Reproduce stale totals; regression test passes with authoritative payment totals.", scopeReference: "Approved checkout correctness step" },
        { title: "Verify the fee switch", acceptanceCriteria: "Verify zero and positive fee behavior for supported cards.", scopeReference: "Approved verification step" },
      ] } };
      return { task, review, command };
    }
    const f = await fixture();
    const legacy = await db.subTask.create({ data: { taskId: f.task.id, text: "Original completed work", completedAt: new Date() } });
    const missing = await submitWorkflowCommand({ ...f.command, payload: { ...f.command.payload, findings: undefined } } as unknown as TaskWorkflowCommand);
    assert.equal(missing.status, "invalid");
    for (const actor of [worker, outsider]) {
      const result = await submitWorkflowCommand({ ...f.command, actor: { id: actor.id, kind: "agent", username: actor.username }, idempotencyKey: `forbidden-${actor.id}` });
      assert.equal(result.status, "forbidden");
    }
    const stale = await submitWorkflowCommand({ ...f.command, expectedWorkflowVersion: 0 });
    assert.equal(stale.status, "stale");
    const wrong = await submitWorkflowCommand({ ...f.command, payload: { ...f.command.payload, candidateSha: "b".repeat(40) }, idempotencyKey: "wrong-candidate" });
    assert.notEqual(wrong.status, "accepted");
    assert.equal(await db.reviewFinding.count(), 0);
    const accepted = await submitWorkflowCommand(f.command);
    assert.equal(accepted.status, "accepted", JSON.stringify(accepted));
    const replay = await submitWorkflowCommand(f.command);
    assert.equal(replay.status, "replayed", JSON.stringify(replay));
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: f.task.id, type: "return_review_for_changes" } }), 1, "replay does not queue another handoff");
    const findings = await db.reviewFinding.findMany({ where: { taskId: f.task.id }, include: { subTask: true }, orderBy: { position: "asc" } });
    assert.equal(findings.length, 2);
    assert.ok(findings.every(row => row.status === "open" && row.subTask?.kind === "implementation" && !row.subTask.completedAt && row.candidateSha === f.review.candidateSha));
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).status, "To Do");
    assert.ok((await db.subTask.findUniqueOrThrow({ where: { id: legacy.id } })).completedAt);
    assert.equal(guardSubmitForReviewChecklist((await loadTaskAggregate(f.task.id))!, "submit_for_review").ok, false);
    assert.equal(guardAcceptReviewChecklist((await loadTaskAggregate(f.task.id))!).ok, false);
    const item = findings[0].subTaskId!;
    await assert.rejects(setSubTaskCompletion({ subTaskId: item, completed: true, actorUserId: worker.id }), /completionEvidence/);
    await assert.rejects(deleteSubTaskItem({ subTaskId: item, actorUserId: worker.id }), /independent reviewer/);
    await assert.rejects(deleteSubTaskItem({ subTaskId: item, actorUserId: reviewer.id }), /reason/);
    await setSubTaskCompletion({ subTaskId: item, completed: true, actorUserId: worker.id, completionEvidence: "Fixed response reconciliation; stale-total regression passes." });
    assert.equal((await db.reviewFinding.findUniqueOrThrow({ where: { id: findings[0].id } })).status, "resolved");
    await setSubTaskCompletion({ subTaskId: item, completed: false, actorUserId: worker.id });
    assert.equal((await db.reviewFinding.findUniqueOrThrow({ where: { id: findings[0].id } })).completionEvidence, null);
    const fake = await db.comment.create({ data: { taskId: f.task.id, userId: worker.id, body: "Skip it" } });
    await assert.rejects(deleteSubTaskItem({ subTaskId: item, actorUserId: reviewer.id, supersededReason: "Changed scope", ownerInstructionCommentId: fake.id }), /owner instruction/);
    const instruction = await db.comment.create({ data: { taskId: f.task.id, userId: owner.id, body: "This check is superseded by the new requirement." } });
    await deleteSubTaskItem({ subTaskId: item, actorUserId: reviewer.id, supersededReason: "Owner changed this requirement; retain the other correction.", ownerInstructionCommentId: instruction.id });
    const superseded = await db.reviewFinding.findUniqueOrThrow({ where: { id: findings[0].id } });
    assert.equal(superseded.status, "superseded"); assert.equal(superseded.subTaskId, null); assert.equal(superseded.completionEvidence, null);
    await setSubTaskCompletion({ subTaskId: findings[1].subTaskId!, completed: true, actorUserId: worker.id, completionEvidence: "Attached supported-card matrix confirms zero and positive fee behavior." });
    assert.equal(guardSubmitForReviewChecklist((await loadTaskAggregate(f.task.id))!, "submit_for_review").ok, true);
    // Failure after the first inserted finding must roll back the entire decision.
    const full = await fixture();
    for (let i = 0; i < 49; i++) await db.subTask.create({ data: { taskId: full.task.id, text: `Existing ${i}`, completedAt: new Date() } });
    const failed = await submitWorkflowCommand(full.command);
    assert.notEqual(failed.status, "accepted");
    assert.equal(await db.reviewFinding.count({ where: { taskId: full.task.id } }), 0);
    assert.equal(await db.subTask.count({ where: { taskId: full.task.id } }), 49);
    assert.equal(await db.comment.count({ where: { taskId: full.task.id } }), 0);
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: full.task.id } }), 0);
    assert.equal(await db.workflowOutbox.count({ where: { taskId: full.task.id } }), 0);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: full.task.id } })).status, "Review");
    // Even an out-of-band checklist deletion cannot hide an unresolved finding.
    const orphan = await fixture(); await submitWorkflowCommand(orphan.command);
    await db.subTask.deleteMany({ where: { taskId: orphan.task.id } });
    assert.equal(guardSubmitForReviewChecklist((await loadTaskAggregate(orphan.task.id))!, "submit_for_review").ok, false);
    console.log("PASS review findings: atomic handoff, permissions, stale candidate/version, replay, evidence, supersession, rollback and unresolved-ledger gates");
  } finally { await db.$disconnect(); await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
