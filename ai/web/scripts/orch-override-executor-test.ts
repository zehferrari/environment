// ENV-150 Step 13 — Human status override executor end-to-end test.
//
// Verifies the override_status intent executor against a disposable DB:
//   - a human override to a non-Done status raises a wait-for-human blocker
//     (task.blocker activity + blocker_notice comment) atomically with the
//     status transition;
//   - loadTaskAggregate resolves activeBlocker from that activity;
//   - guardNoUnresolvedBlocker refuses an agent workflow intent while the
//     wait-for-human blocker is active;
//   - an authorized human clear_blocker resolves it (task.blocker.cleared),
//     after which the agent command is allowed again;
//   - an override to Done creates no blocker.
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
    const { submitWorkflowCommand, loadTaskStateSnapshot } = await import("@/lib/tasks/orchestrator");
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

    // --- 1. Override to a non-Done status raises a wait-for-human blocker ---
    const res = await submitWorkflowCommand(humanCmd({ targetStatus: "In Progress", reason: "human confirmed" }, "ov-1", 0));
    assert.equal(res.status, "accepted", "human override to Review is accepted");
    passed++;

    const blockerActivity = await db.activityLog.findFirst({
      where: { taskId: task.id, kind: "task.blocker" },
      orderBy: { createdAt: "desc" },
    });
    assertOk(blockerActivity, "a task.blocker activity is created");
    assertOk(blockerActivity!.id !== null && blockerActivity!.id !== undefined, "blocker activity has an id");
    const blockerPayloadRaw = blockerActivity!.payload;
    assertOk(blockerPayloadRaw, "blocker activity has a payload");
    const blockerPayload = JSON.parse(blockerPayloadRaw as string);
    assert.equal(blockerPayload.override?.kind, "wait_for_human", "override kind is wait_for_human");
    assert.equal(blockerPayload.override?.targetStatus, "In Progress", "override targetStatus is In Progress");
    assert.equal(blockerPayload.override?.reason, "human confirmed", "override reason is carried");
    assert.equal(blockerPayload.permissionRequest, null, "wait-for-human blocker has no permission request");
    passed += 4;

    const notice = await db.comment.findFirst({
      where: { taskId: task.id, commentKind: "blocker_notice" },
      orderBy: { createdAt: "desc" },
    });
    assertOk(notice, "a blocker_notice comment is created");
    assertOk(notice!.body.includes("stop all further work"), "notice instructs the agent to stop");
    passed += 2;

    const updatedTask = await db.task.findUnique({ where: { id: task.id } });
    assert.equal(updatedTask!.status, "In Progress", "status transitioned to In Progress");
    assert.equal(updatedTask!.alertReporter, true, "alertReporter is set");
    passed += 2;

    // --- 2. loadTaskAggregate resolves activeBlocker from the activity ---
    const state = await loadTaskStateSnapshot(task.id);
    assertOk(state, "aggregate loads");
    assertOk(state!.activeBlocker, "activeBlocker is resolved from the activity log");
    assert.equal(state!.activeBlocker!.commentId, notice!.id, "activeBlocker.commentId matches the notice");
    assert.equal(state!.activeBlocker!.permissionRequest, null, "activeBlocker has no permission request");
    passed += 3;

    // --- 3. guardNoUnresolvedBlocker refuses an agent intent while blocked ---
    const agentRefused = guardNoUnresolvedBlocker(state!, "submit_for_review");
    assert.equal(agentRefused.ok, false, "agent submit_for_review refused while wait-for-human blocker active");
    assertOk((agentRefused as any).reason.includes("blocker_unresolved"), "refusal names blocker_unresolved");
    passed += 2;

    // --- 4. Human clear_blocker resolves it; agent command allowed again ---
    const clearRes = await submitWorkflowCommand({
      taskId: task.id,
      intent: "clear_blocker",
      actor: { id: human.id, kind: "human", username: "zeh" },
      payload: { blockerId: notice!.id, resolution: "Human reviewed; proceed." },
      expectedWorkflowVersion: state!.workflowVersion,
      workflowCycleId: null,
      source: "operator",
      idempotencyKey: "ov-clear-1",
    });
    assert.equal(clearRes.status, "accepted", "human clear_blocker is accepted");
    passed++;

    const clearedActivity = await db.activityLog.findFirst({
      where: { taskId: task.id, kind: "task.blocker.cleared" },
      orderBy: { createdAt: "desc" },
    });
    assertOk(clearedActivity, "a task.blocker.cleared activity is created");
    passed++;

    const stateAfterClear = await loadTaskStateSnapshot(task.id);
    assertOk(stateAfterClear, "aggregate loads after clear");
    assert.equal(stateAfterClear!.activeBlocker, null, "activeBlocker is null after clear_blocker");
    passed += 2;

    const agentAllowed = guardNoUnresolvedBlocker(stateAfterClear!, "submit_for_review");
    assert.equal(agentAllowed.ok, true, "agent submit_for_review allowed after blocker cleared");
    passed++;

    // --- 5. Override to Done creates no blocker ---
    const doneRes = await submitWorkflowCommand(humanCmd({ targetStatus: "Done", reason: "complete" }, "ov-2", stateAfterClear!.workflowVersion));
    assert.equal(doneRes.status, "accepted", "human override to Done is accepted");
    passed++;

    const doneBlockers = await db.activityLog.count({
      where: { taskId: task.id, kind: "task.blocker" },
    });
    assert.equal(doneBlockers, 1, "no additional task.blocker activity for the Done override");
    const doneState = await loadTaskStateSnapshot(task.id);
    assert.equal(doneState!.status, "Done", "status transitioned to Done");
    assert.equal(doneState!.activeBlocker, null, "no active blocker after Done override");
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
