import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function freshDb(): Promise<{ dbUrl: string; cleanup: () => Promise<void> }> {
  const sandbox = await mkdtemp(path.join(tmpdir(), "phasee-09-browser-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  await execFileP(
    "pnpm",
    ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: dbUrl } },
  );
  return { dbUrl, cleanup: () => rm(sandbox, { recursive: true, force: true }) };
}

async function assertSourceContracts() {
  const moveStatus = await readFile("lib/tasks/move-status.ts", "utf8");
  assert.doesNotMatch(moveStatus, /submitWorkflowCommand|applyTaskTransition|transitionTask|\bdb\./);
  assert.doesNotMatch(moveStatus, /function moveTaskStatus/);

  for (const file of [
    "app/(app)/projects/[slug]/page.tsx",
    "app/(app)/workspaces/[slug]/page.tsx",
    "app/(app)/workspaces/(landing)/page.tsx",
  ]) {
    const source = await readFile(file, "utf8");
    assert.match(source, /submitBrowserStatusOverride/, `${file} submits the canonical browser command`);
    assert.doesNotMatch(source, /moveTaskStatus|transitionTask\(|applyTaskTransition\(/, `${file} has no direct status writer`);
    assert.doesNotMatch(source, /recordLegacyWorkflowBoundaryInvocation/, `${file} is no longer a legacy boundary`);
  }

  const taskDetail = await readFile("app/(app)/projects/[slug]/tasks/[taskId]/page.tsx", "utf8");
  assert.match(taskDetail, /submitBrowserStatusOverride/);
  assert.match(taskDetail, /submitBrowserPlanApproval/);
  assert.doesNotMatch(taskDetail, /moveTaskStatus|applyTaskTransition\(|recordLegacyWorkflowBoundaryInvocation/);
}

async function main() {
  await assertSourceContracts();
  const { dbUrl, cleanup } = await freshDb();
  process.env.DATABASE_URL = dbUrl;

  try {
    const { db } = await import("@/lib/db");
    const { submitBrowserStatusOverride } = await import("@/lib/tasks/orchestrator/browser-status-adapter");
    const { submitBrowserPlanApproval } = await import("@/lib/tasks/orchestrator/browser-plan-adapter");

    const human = await db.user.create({
      data: { username: "owner", email: "owner@example.test", kind: "human", isOwner: true },
    });
    const agent = await db.user.create({
      data: { username: "agent", email: "agent@example.test", kind: "agent" },
    });
    const project = await db.project.create({
      data: { slug: "phasee-09-browser", name: "Phase E browser adapters" },
    });
    const actor = { id: human.id, username: human.username, kind: "human" as const, isOwner: true };

    const overrideTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Browser override",
        status: "To Do",
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });
    const firstOverride = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "To Do",
      targetStatus: "In Progress",
      expectedWorkflowVersion: 0,
      surface: "project-board",
    });
    assert.equal(firstOverride.ok, true);
    const afterOverride = await db.task.findUniqueOrThrow({ where: { id: overrideTask.id } });
    assert.equal(afterOverride.status, "In Progress");
    assert.equal(afterOverride.workflowVersion, 1);
    assert.equal(await db.activityLog.count({ where: { taskId: overrideTask.id, kind: "task.blocker" } }), 1);
    assert.equal(await db.comment.count({ where: { taskId: overrideTask.id, commentKind: "blocker_notice" } }), 1);

    const replay = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "To Do",
      targetStatus: "In Progress",
      expectedWorkflowVersion: 0,
      surface: "project-board",
    });
    assert.equal(replay.ok, true, "same browser evidence replays exactly");
    assert.equal(await db.activityLog.count({ where: { taskId: overrideTask.id, kind: "task.blocker" } }), 1);

    const stale = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "To Do",
      targetStatus: "Review",
      expectedWorkflowVersion: 0,
      surface: "task-detail",
    });
    assert.deepEqual(stale, {
      ok: false,
      code: "STALE_VERSION",
      message: "The task changed while this status update was pending. Refresh the board and try again.",
    });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: overrideTask.id } })).status, "In Progress");

    const done = await submitBrowserStatusOverride({
      actor,
      taskId: overrideTask.id,
      currentStatus: "In Progress",
      targetStatus: "Done",
      expectedWorkflowVersion: 1,
      surface: "workspace-landing",
    });
    assert.equal(done.ok, true);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: overrideTask.id } })).status, "Done");
    assert.equal(
      await db.activityLog.count({ where: { taskId: overrideTask.id, kind: "task.blocker" } }),
      1,
      "Done creates no additional wait-for-human blocker",
    );

    const planTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Browser plan approval",
        status: "Backlog",
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });
    const plan = await db.actionPlan.create({
      data: {
        taskId: planTask.id,
        summary: "Approve through browser command",
        version: 1,
        status: "draft",
        authorId: agent.id,
        contentHash: "phasee-09-browser-plan",
      },
    });
    await db.actionPlanStep.create({
      data: {
        actionPlanId: plan.id,
        stepId: "browser-step",
        title: "Use canonical command",
        acceptanceCriteria: JSON.stringify(["Approval is atomic"]),
        kind: "sequential",
        rank: 0,
      },
    });
    const approval = await submitBrowserPlanApproval({
      actor,
      taskId: planTask.id,
      actionPlanId: plan.id,
      actionPlanVersion: 1,
      expectedWorkflowVersion: 0,
    });
    assert.equal(approval.ok, true);
    assert.ok(approval.ok && approval.procedureId, "approval schedules prepare_todo_task");
    const approvedTask = await db.task.findUniqueOrThrow({ where: { id: planTask.id } });
    assert.equal(approvedTask.status, "To Do");
    assert.ok(approvedTask.approvedOn);
    assert.equal(approvedTask.approvedById, human.id);
    assert.equal((await db.actionPlan.findUniqueOrThrow({ where: { id: plan.id } })).status, "approved");
    assert.equal(await db.subTask.count({ where: { taskId: planTask.id, kind: "implementation" } }), 1);
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: planTask.id, type: "prepare_todo_task" } }), 1);

    const queuedPlanTask = await db.task.create({
      data: {
        projectId: project.id,
        title: "Queued browser plan approval",
        status: "To Do",
        assigneeId: agent.id,
        actingManagerId: human.id,
        reporterId: human.id,
      },
    });
    const queuedPlan = await db.actionPlan.create({
      data: {
        taskId: queuedPlanTask.id,
        summary: "Approve without a status edge",
        version: 1,
        status: "draft",
        authorId: agent.id,
        contentHash: "phasee-09-browser-queued-plan",
      },
    });
    await db.actionPlanStep.create({
      data: {
        actionPlanId: queuedPlan.id,
        stepId: "queued-browser-step",
        title: "Use the canonical approval no-op",
        acceptanceCriteria: JSON.stringify(["To Do approval stays in To Do"]),
        kind: "sequential",
        rank: 0,
      },
    });
    const queuedApproval = await submitBrowserPlanApproval({
      actor,
      taskId: queuedPlanTask.id,
      actionPlanId: queuedPlan.id,
      actionPlanVersion: 1,
      expectedWorkflowVersion: 0,
    });
    assert.equal(queuedApproval.ok, true);
    const approvedQueuedTask = await db.task.findUniqueOrThrow({ where: { id: queuedPlanTask.id } });
    assert.equal(approvedQueuedTask.status, "To Do");
    assert.equal(approvedQueuedTask.workflowVersion, 0);
    assert.ok(approvedQueuedTask.approvedOn);
    assert.equal(
      await db.activityLog.count({
        where: {
          taskId: queuedPlanTask.id,
          kind: "task.workflow.approve_plan",
        },
      }),
      1,
      "queued plan approval is an audited canonical no-op",
    );
    assert.equal(
      await db.taskProcedureRun.count({ where: { taskId: queuedPlanTask.id, type: "prepare_todo_task" } }),
      1,
    );

    const approvalReplay = await submitBrowserPlanApproval({
      actor,
      taskId: planTask.id,
      actionPlanId: plan.id,
      actionPlanVersion: 1,
      expectedWorkflowVersion: 0,
    });
    assert.equal(approvalReplay.ok, true);
    assert.equal(await db.taskProcedureRun.count({ where: { taskId: planTask.id, type: "prepare_todo_task" } }), 1);

    console.log("phasee-09 browser adapters: PASS");
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
