import {
  bootScenarioDb,
  createScenarioSandbox,
  seedTask,
  seedWorld,
} from "./lib/workflow-scenario-harness";

async function main() {
  const sandbox = await createScenarioSandbox({ name: "debug-f3" });
  try {
    const boot = await bootScenarioDb();
    const db = boot.db;

    const world = await seedWorld(db, {
      agentSlug: "f3-debug",
      projectSlug: "f3-debug",
      withEpic: true,
    });

    const task = await seedTask(db, world, {
      title: "F3 debug",
      status: "To Do",
      approved: true,
      underEpic: true,
    });

    const { submitWorkflowCommand } = await import("@/lib/tasks/orchestrator");

    // Start implementation
    let result = await submitWorkflowCommand({
      taskId: task.id,
      intent: "start_implementation" as any,
      actor: { id: world.agentUserId, kind: "agent" },
      expectedWorkflowVersion: 0,
      idempotencyKey: "dbg-start",
      source: "test",
    } as any);
    console.log("start:", JSON.stringify(result));

    const task1 = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true, activeWorkflowCycleId: true } });
    console.log("task after start:", JSON.stringify(task1));

    // Submit for review
    result = await submitWorkflowCommand({
      taskId: task.id,
      intent: "submit_for_review" as any,
      actor: { id: world.agentUserId, kind: "agent" },
      expectedWorkflowVersion: task1.workflowVersion,
      idempotencyKey: "dbg-submit",
      source: "test",
      workflowCycleId: task1.activeWorkflowCycleId,
      evidence: { candidateSha: "sha-v1", baseSha: "base-sha" },
      payload: { candidateSha: "sha-v1" },
    } as any);
    console.log("submit:", JSON.stringify(result));

    const task2 = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true, activeWorkflowCycleId: true } });
    console.log("task after submit:", JSON.stringify(task2));

    // Check for review runs
    const reviewRuns = await db.reviewRun.findMany({ where: { taskId: task.id }, select: { id: true, status: true, candidateSha: true, workflowCycleId: true } });
    console.log("review runs:", JSON.stringify(reviewRuns));

    // Check for procedure runs
    const procRuns = await db.taskProcedureRun.findMany({ where: { taskId: task.id }, select: { id: true, type: true, status: true, workflowCycleId: true } });
    console.log("procedure runs:", JSON.stringify(procRuns));

    // Try validation_succeeded as monitor
    result = await submitWorkflowCommand({
      taskId: task.id,
      intent: "repository_validation_succeeded" as any,
      actor: { id: world.agentUserId, kind: "agent", role: "monitor" as any },
      expectedWorkflowVersion: task2.workflowVersion,
      idempotencyKey: "dbg-validation",
      source: "test",
      workflowCycleId: task2.activeWorkflowCycleId,
      evidence: { candidateSha: "sha-v1" },
      payload: { candidateSha: "sha-v1" },
    } as any);
    console.log("validation:", JSON.stringify(result));

    const task3 = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true, activeWorkflowCycleId: true } });
    console.log("task after validation:", JSON.stringify(task3));

    const reviewRuns2 = await db.reviewRun.findMany({ where: { taskId: task.id }, select: { id: true, status: true, candidateSha: true, workflowCycleId: true } });
    console.log("review runs after validation:", JSON.stringify(reviewRuns2));

  } finally {
    await sandbox.dispose();
  }
}
main().catch(console.error);
