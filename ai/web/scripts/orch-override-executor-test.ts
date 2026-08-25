// ENV-150 Step 13 — Human status override executor end-to-end test.
//
// Verifies the override_status intent executor against a disposable DB:
//   - successful human status updates never manufacture blockers;
//   - the aggregate and blocker guard remain clear after the update;
//   - an override to Done also creates no blocker;
//   - genuine agent-reported blockers retain their existing lifecycle.
//
// Pure contract functions are imported only after DATABASE_URL is set so no
// live DB is ever bound. Exit 0 on success, non-zero on first failed assertion.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "orch-override-"));
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
  let passed = 0;
  let failed = 0;
  const assertOk = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  try {
    const { db } = await import("@/lib/db");
    const {
      authorizeCommand,
      loadTaskStateSnapshot,
      runGuards,
      submitWorkflowCommand,
    } = await import("@/lib/tasks/orchestrator");
    const { guardNoUnresolvedBlocker } = await import("@/lib/tasks/orchestrator/guards");

    // --- Fixtures ---------------------------------------------------------
    const human = await db.user.create({ data: { username: "zeh", email: "zeh@x.example", kind: "human" } });
    const agent = await db.user.create({ data: { username: "agent", email: "agent@x.example", kind: "agent" } });
    const project = await db.project.create({
      data: { slug: "orch-override", name: "ORCH-Override", repositoryPath: "/srv/Code/test-repo" },
    });
    const task = await db.task.create({
      data: {
        projectId: project.id,
        title: "Override executor task",
        status: "To Do",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });

    const humanCmd = (payload: { targetStatus: "Backlog" | "To Do" | "In Progress" | "Review" | "Done"; reason?: string }, key: string, version: number) => ({
      taskId: task.id,
      intent: "override_status" as const,
      actor: { id: human.id, kind: "human" as const, username: "zeh" },
      payload,
      expectedWorkflowVersion: version,
      workflowCycleId: null,
      source: "operator",
      idempotencyKey: key,
    });

    // --- 1. A successful human status update creates no implicit blocker ---
    const res = await submitWorkflowCommand(humanCmd({ targetStatus: "In Progress", reason: "human confirmed" }, "ov-1", 0));
    assert.equal(res.status, "accepted", "human override to In Progress is accepted");
    passed++;

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    assert.equal(updatedTask!.status, "In Progress", "status transitioned to In Progress");
    assert.equal(updatedTask!.alertReporter, false, "status update does not alert the reporter as blocked");
    assert.equal(await db.activityLog.count({ where: { taskId: task.id, kind: "task.blocker" } }), 0);
    assert.equal(await db.comment.count({ where: { taskId: task.id, commentKind: "blocker_notice" } }), 0);
    passed += 4;

    // --- 2. Aggregate and guard remain unblocked --------------------------
    const state = await loadTaskStateSnapshot(task.id);
    assertOk(state, "aggregate loads");
    assert.equal(state!.activeBlocker, null, "aggregate has no active blocker");
    assert.equal(guardNoUnresolvedBlocker(state!, "submit_for_review").ok, true, "blocker guard remains clear");
    passed += 3;

    // --- 3. Override to Done creates no blocker ---------------------------
    const doneRes = await submitWorkflowCommand(humanCmd({ targetStatus: "Done", reason: "complete" }, "ov-2", state!.workflowVersion));
    assert.equal(doneRes.status, "accepted", "human override to Done is accepted");
    passed++;

    const doneBlockers = await db.activityLog.count({
      where: { taskId: task.id, kind: "task.blocker" },
    });
    assert.equal(doneBlockers, 0, "Done override also creates no task.blocker activity");
    const doneState = await loadTaskStateSnapshot(task.id);
    assert.equal(doneState!.status, "Done", "status transitioned to Done");
    assert.equal(doneState!.activeBlocker, null, "no active blocker after Done override");
    passed += 3;

    // --- 3b. Same-status Done repairs a stale cycle without inventing review evidence ---
    const staleDoneTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Stale Done cycle",
        status: "Done",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });
    const staleCycle = await db.taskWorkflowCycle.create({
      data: {
        taskId: staleDoneTask.id,
        sequence: 1,
        status: "open",
        workflowEngine: "orchestrator_v2",
        openedWorkflowVersion: staleDoneTask.workflowVersion,
      },
    });
    await db.task.update({
      where: { id: staleDoneTask.id },
      data: { activeWorkflowCycleId: staleCycle.id },
    });
    const repairedDone = await submitWorkflowCommand({
      taskId: staleDoneTask.id,
      intent: "override_status",
      actor: { id: human.id, kind: "human", username: "zeh" },
      payload: { targetStatus: "Done", reason: "repair stale manual completion" },
      expectedWorkflowVersion: staleDoneTask.workflowVersion,
      workflowCycleId: staleCycle.id,
      source: "operator",
      idempotencyKey: "ov-stale-done-repair",
    });
    assert.equal(repairedDone.status, "accepted", "same-status Done repair is accepted");
    const repairedTask = await db.task.findUniqueOrThrow({ where: { id: staleDoneTask.id } });
    const repairedCycle = await db.taskWorkflowCycle.findUniqueOrThrow({ where: { id: staleCycle.id } });
    assert.equal(repairedTask.activeWorkflowCycleId, null, "same-status repair clears the task cycle pointer");
    assert.equal(repairedCycle.status, "closed", "same-status repair closes the cycle");
    assert.equal(repairedCycle.outcome, "abandoned", "same-status repair records abandonment, not completion");
    assert.equal(
      await db.reviewRun.count({ where: { taskId: staleDoneTask.id } }),
      0,
      "repair does not fabricate review evidence",
    );
    passed += 5;

    // --- 6. Ordinary agent blocker retains raise/clear/proceed parity -------
    const ordinaryTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Ordinary operational blocker task",
        status: "In Progress",
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
        approvedOn: new Date(),
        approvedById: human.id,
      },
    });
    const ordinaryCycle = await db.taskWorkflowCycle.create({
      data: {
        taskId: ordinaryTask.id,
        sequence: 1,
        status: "open",
        workflowEngine: "orchestrator_v2",
        openedWorkflowVersion: 0,
      },
    });
    await db.task.update({
      where: { id: ordinaryTask.id },
      data: { activeWorkflowCycleId: ordinaryCycle.id },
    });

    const agentActor = {
      id: agent.id,
      kind: "agent" as const,
      username: "agent",
      role: "assignee" as const,
      codingCapability: true,
    };
    const ordinaryReport = {
      blockedOn: "decision" as const,
      requestedActor: "release manager",
      requestedAction: "Confirm whether the staged change may proceed.",
      evidence: ["The release window is awaiting an explicit go/no-go decision."],
      diagnosticsAttempted: ["Checked the approved release plan and found no recorded decision."],
      resumeCondition: "The release manager records a go/no-go decision for this task.",
      reporterCanResolve: true,
    };
    const raised = await submitWorkflowCommand({
      taskId: ordinaryTask.id,
      intent: "raise_blocker",
      actor: agentActor,
      payload: { blockerReport: ordinaryReport, comment: "Waiting for the release decision." },
      expectedWorkflowVersion: 0,
      workflowCycleId: ordinaryCycle.id,
      source: "agent",
      idempotencyKey: "ordinary-raise-1",
    });
    assert.equal(raised.status, "accepted", "agent can raise an ordinary operational blocker");

    const ordinaryBlockedState = await loadTaskStateSnapshot(ordinaryTask.id);
    assertOk(ordinaryBlockedState?.activeBlocker, "ordinary blocker is loaded");
    assert.equal(ordinaryBlockedState!.activeBlocker!.override, null, "ordinary blocker has no override marker");
    assert.equal(
      guardNoUnresolvedBlocker(ordinaryBlockedState!, "submit_for_review").ok,
      true,
      "ordinary blocker does not widen submit_for_review guard reach",
    );
    const ordinaryClearAuth = authorizeCommand(ordinaryBlockedState!, {
      intent: "clear_blocker",
      actor: agentActor,
    });
    assert.equal(ordinaryClearAuth.allowed, true, "assignee remains authorized to clear its ordinary blocker");

    const ordinaryBlockerComment = await db.comment.findFirst({
      where: { taskId: ordinaryTask.id, commentKind: "blocker_notice" },
      orderBy: { createdAt: "desc" },
    });
    assertOk(ordinaryBlockerComment, "ordinary blocker notice exists");
    const cleared = await submitWorkflowCommand({
      taskId: ordinaryTask.id,
      intent: "clear_blocker",
      actor: agentActor,
      payload: {
        blockerId: ordinaryBlockerComment!.id,
        resolution: "Release manager confirmed the task may proceed.",
      },
      expectedWorkflowVersion: ordinaryBlockedState!.workflowVersion,
      workflowCycleId: ordinaryCycle.id,
      source: "agent",
      idempotencyKey: "ordinary-clear-1",
    });
    assert.equal(cleared.status, "accepted", "assignee can clear its ordinary blocker");
    const ordinaryClearedState = await loadTaskStateSnapshot(ordinaryTask.id);
    assert.equal(ordinaryClearedState!.activeBlocker, null, "ordinary blocker is cleared");
    const proceed = runGuards(ordinaryClearedState!, {
      intent: "submit_for_review",
      expectedWorkflowVersion: ordinaryClearedState!.workflowVersion,
      workflowCycleId: ordinaryCycle.id,
    });
    assert.equal(proceed.ok, true, "assignee can proceed to submit_for_review after clearing");
    passed += 9;

    // --- 7. Granted permission round is loaded and no longer unresolved ----
    const permissionCommentId = "permission-comment-1";
    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: ordinaryTask.id,
        userId: agent.id,
        kind: "task.blocker",
        payload: JSON.stringify({
          commentId: permissionCommentId,
          permissionRequest: { kind: "publish_checkpoint", scope: "Publish ENV-150 to phase-e." },
          blockerReport: ordinaryReport,
        }),
      },
    });
    const pendingPermissionState = await loadTaskStateSnapshot(ordinaryTask.id);
    assert.equal(
      guardNoUnresolvedBlocker(pendingPermissionState!, "submit_for_review").ok,
      false,
      "pending permission round remains unresolved",
    );
    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: ordinaryTask.id,
        userId: human.id,
        kind: "task.blocker.permission.granted",
        payload: JSON.stringify({
          blockerCommentId: permissionCommentId,
          authorizationCommentId: "authorization-comment-1",
        }),
      },
    });
    const grantedPermissionState = await loadTaskStateSnapshot(ordinaryTask.id);
    assert.equal(
      grantedPermissionState!.activeBlocker!.permissionGrant?.authorizationCommentId,
      "authorization-comment-1",
      "aggregate loads the permission grant attached to the active blocker",
    );
    assert.equal(
      guardNoUnresolvedBlocker(grantedPermissionState!, "submit_for_review").ok,
      true,
      "granted permission round is agent-actionable, not unresolved",
    );
    passed += 3;

    console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
    console.log("All ENV-150 override executor tests passed.");
  } catch (e) {
    failed++;
    console.error(`FAIL: ${(e as Error).message}`);
    console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
    process.exit(1);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
