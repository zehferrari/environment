import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { TaskWorkflowCommand } from "@/lib/tasks/orchestrator/types";

async function main() {
  const root = await mkdtemp(`${tmpdir()}/reviewer-permission-`);
  process.env.DATABASE_URL = `file:${root}/test.db`;
  process.env.PM_ASYNC_DISPATCH = "1";
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  process.env.AUTH_SECRET = "isolated-permission-test";
  await promisify(execFile)("pnpm", ["prisma", "migrate", "deploy"], { env: process.env });
  const { db } = await import("@/lib/db");
  try {
    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");
    const { openTaskWorkflowCycle } = await import("@/lib/tasks/workflow-cycle");
    const { readTaskPermissionState, readTaskBlockerState } = await import("@/lib/tasks/permission-state");
    const { isReviewerCheckpointAuthorization } = await import("@/lib/tasks/reviewer-checkpoint-authorization");
    const { normalizePublicAction } = await import("@/lib/tasks/orchestrator/normalize");
    const { validateCheckpointAuthorizationText } = await import("@/lib/deploy/checkpoint-authorization");
    const { taskToolActions } = await import("@/lib/agents/pm-channel/task-runtime");
    const owner = await db.user.create({ data: { username: "owner", email: "owner@test.invalid", kind: "human", isOwner: true } });
    const actors = [];
    for (const slug of ["worker", "reviewer", "outsider"]) {
      const agent = await db.agent.create({ data: { slug, name: slug, role: "coding" } });
      actors.push(await db.user.create({ data: { username: slug, email: `${slug}@test.invalid`, kind: "agent", agentId: agent.id } }));
    }
    const [worker, reviewer, outsider] = actors;
    const project = await db.project.create({ data: { slug: "permissions", name: "Permissions", workMode: "code", repositoryPath: "/tmp/permission-repo", deploymentProductionBranch: "main" } });
    let seq = 0;
    const routine = { environment: "development", target: "dev.example.test / task branch", changesScope: false, destructive: false, securitySensitive: false };
    async function fixture(permissionKind: string | null = "publish_checkpoint", permissionContext: unknown = routine) {
      const task = await db.task.create({ data: { projectId: project.id, title: "Preview verification", workItemKey: `PER-${++seq}`, branchName: `test-${seq}`, status: "In Progress", approvedOn: new Date(), assigneeId: worker.id, actingManagerId: reviewer.id, reporterId: owner.id } });
      const plan = await db.actionPlan.create({ data: { taskId: task.id, summary: "Verify on Dev", status: "approved", approvedOn: new Date(), contentHash: "hash", steps: { create: { stepId: "verify", title: "Verify on Dev", acceptanceCriteria: '["Use the reviewed dev preview"]' } } } });
      const cycle = await db.$transaction(tx => openTaskWorkflowCycle(tx, { taskId: task.id, openedWorkflowVersion: 0 }));
      assert.ok(cycle);
      await db.taskRepositoryRun.create({ data: { taskId: task.id, workflowCycleId: cycle.id, repositoryPath: "/tmp/permission-repo", worktreePath: `/tmp/permission-repo.worktrees/test-${seq}`, branchName: task.branchName!, phase: "active", baseSha: "a".repeat(40) } });
      const command = async (intent: string, payload: unknown, user = reviewer, key = `${intent}-${++seq}`) => submitWorkflowCommand({ taskId: task.id, intent, actor: { id: user.id, kind: "agent", username: user.username, codingCapability: true, role: user.id === worker.id ? "assignee" : "reviewer" }, source: "operator", expectedWorkflowVersion: (await db.task.findUniqueOrThrow({ where: { id: task.id } })).workflowVersion, workflowCycleId: cycle.id, idempotencyKey: key, payload } as TaskWorkflowCommand);
      const raised = await command("raise_blocker", { permissionKind, permissionContext, permissionScope: "Publish the current branch for Dev verification", blockerReport: { blockedOn: permissionKind ? "permission" : "decision", requestedActor: "reviewer", requestedAction: "Approve Dev verification", evidence: "Preview is missing latest code", diagnosticsAttempted: ["Compared deployed SHA"], resumeCondition: "A scoped permission grant is recorded", reporterCanResolve: true } }, worker);
      assert.equal(raised.status, "accepted", JSON.stringify(raised));
      const active = await readTaskBlockerState(task.id);
      assert.ok(active);
      const review = { blockerCommentId: active.commentId, decision: "approve", rationale: "This exact Dev preview publication is necessary for the approved verify step, has no production effects and changes no scope.", actionPlanId: plan.id, actionPlanVersion: plan.version, planStepIds: ["verify"] };
      return { task, plan, cycle, command, review };
    }
    const f = await fixture();
    assert.equal((await f.command("review_permission", f.review, worker)).status, "forbidden", "self approval refused");
    assert.equal((await f.command("review_permission", f.review, outsider)).status, "forbidden", "outsider refused");
    assert.equal((await f.command("review_permission", { ...f.review, actionPlanVersion: 99 })).status, "stale");
    assert.equal((await f.command("review_permission", { ...f.review, planStepIds: ["invented"] })).status, "forbidden");
    const result = await f.command("review_permission", f.review, reviewer, "approve-once");
    assert.equal(result.status, "accepted", JSON.stringify(result));
    assert.equal((await f.command("review_permission", f.review, reviewer, "approve-once")).status, "replayed");
    assert.notEqual((await f.command("review_permission", f.review)).status, "accepted");
    const permission = await readTaskPermissionState(f.task.id);
    const authId = permission?.grant?.authorizationCommentId;
    assert.ok(authId);
    assert.equal(await isReviewerCheckpointAuthorization(db, f.task.id, authId), true);
    const comment = await db.comment.findUniqueOrThrow({ where: { id: authId } });
    assert.equal(validateCheckpointAuthorizationText({ body: comment.body, taskKey: f.task.workItemKey, taskBranch: f.task.branchName!, epicBranch: null }).ok, true);
    const pub = await f.command("publish_checkpoint", { authorizationCommentId: authId }, worker);
    assert.equal(pub.status, "accepted", JSON.stringify(pub));
    assert.notEqual((await f.command("publish_checkpoint", { authorizationCommentId: authId }, worker)).status, "accepted", "single use remains enforced");
    await db.task.update({ where: { id: f.task.id }, data: { actingManagerId: outsider.id } });
    assert.equal(await isReviewerCheckpointAuthorization(db, f.task.id, authId), false, "reviewer reassignment revokes runner authority");
    await db.task.update({ where: { id: f.task.id }, data: { actingManagerId: reviewer.id } });
    await db.actionPlan.update({ where: { id: f.plan.id }, data: { version: 2 } });
    assert.equal(await isReviewerCheckpointAuthorization(db, f.task.id, authId), false, "plan revision revokes runner authority");
    for (const context of [null, { ...routine, environment: "production" }, { ...routine, changesScope: true }, { ...routine, destructive: true }, { ...routine, securitySensitive: true }]) {
      const unsafe = await fixture("publish_checkpoint", context);
      assert.equal((await unsafe.command("review_permission", unsafe.review)).status, "forbidden");
      assert.equal((await unsafe.command("review_permission", { ...unsafe.review, decision: "escalate", rationale: "Owner decision required for this boundary" })).status, "accepted");
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: unsafe.task.id } })).alertReporter, true);
      assert.equal((await readTaskPermissionState(unsafe.task.id))?.grant, null);
    }
    const generic = await fixture("reporter_approval");
    assert.equal((await generic.command("review_permission", generic.review)).status, "accepted");
    assert.equal(await readTaskPermissionState(generic.task.id), null, "generic approval clears the exact round");
    const declined = await fixture();
    assert.equal((await declined.command("review_permission", { ...declined.review, decision: "decline", rationale: "Use existing preview; this publication is unnecessary" })).status, "accepted");
    assert.equal(await readTaskPermissionState(declined.task.id), null);
    assert.equal(await db.activityLog.count({ where: { taskId: declined.task.id, kind: "task.blocker.permission.granted" } }), 0);
    const outbox = await db.workflowOutbox.findMany({ where: { taskId: f.task.id, effectType: "task_notification" } });
    assert.ok(outbox.some(row => row.payload.includes(f.review.blockerCommentId!)), "round-scoped notification persists");
    const actions = taskToolActions({ status: "In Progress", approved: true, reviewer: true, assignee: false, unassigned: false, canApprove: false, canFinish: false, epicChild: false, coding: true });
    assert.ok(actions.includes("review_permission"));
    const normalized = normalizePublicAction("review_permission", f.review, { taskId: f.task.id, actorId: reviewer.id, actorKind: "agent", actorUsername: "reviewer", expectedWorkflowVersion: 0, workflowCycleId: f.cycle.id, idempotencyKey: "normalize", messageId: null, source: "agent" });
    assert.equal(normalized.ok, true);
    const acceptance = await fixture(null, null);
    const step = await db.actionPlanStep.findFirstOrThrow({ where: { actionPlanId: acceptance.plan.id } });
    const item = await db.subTask.create({ data: { taskId: acceptance.task.id, actionPlanStepId: step.id, text: "Owner post-deployment check; excluded from implementation", kind: "implementation" } });
    const defer = { blockerCommentId: acceptance.review.blockerCommentId, subtaskId: item.id, actionPlanId: acceptance.plan.id, actionPlanVersion: acceptance.plan.version, rationale: "The approved criteria separate owner rollout acceptance from implementation. Keep it pending in Review." };
    assert.equal((await acceptance.command("defer_acceptance_check", defer, worker)).status, "forbidden");
    assert.equal((await acceptance.command("defer_acceptance_check", { ...defer, actionPlanVersion: 99 })).status, "stale");
    const deferred = await acceptance.command("defer_acceptance_check", defer);
    assert.equal(deferred.status, "accepted", JSON.stringify(deferred));
    const retained = await db.subTask.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(retained.kind, "review"); assert.equal(retained.completedAt, null);
    assert.equal(retained.actionPlanStepId, step.id);
    assert.equal(await readTaskBlockerState(acceptance.task.id), null);
    const { loadTaskAggregate } = await import("@/lib/tasks/orchestrator/state");
    const { guardAcceptReviewChecklist } = await import("@/lib/tasks/orchestrator/guards");
    const state = await loadTaskAggregate(acceptance.task.id);
    assert.ok(state); assert.equal(state.openChecklist.count, 0);
    assert.equal(guardAcceptReviewChecklist(state).ok, false, "deferred acceptance continues to block Done");
    console.log("Reviewer permission integration: scope, roles, escalation, decline, replay, publication and revocation passed");
  } finally { await db.$disconnect(); await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
