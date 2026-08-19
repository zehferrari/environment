// Must precede the real Next route import; see workflow-scenario-harness.
import "./lib/next-als-polyfill";

import assert from "node:assert/strict";
import {
  bootScenarioDb,
  createScenarioSandbox,
  dispatchWorkflowTurn,
  seedTask,
  seedWorld,
} from "./lib/workflow-scenario-harness";

async function main() {
  const sandbox = await createScenarioSandbox({ name: "phasee-08-route", schema: "migrate" });
  try {
    const boot = await bootScenarioDb();
    const world = await seedWorld(boot.db, {
      agentSlug: "phasee08-agent",
      projectSlug: "phasee08-project",
    });
    const task = await seedTask(boot.db, world, {
      title: "V2-owned route rejection",
      status: "In Progress",
      approved: true,
    });
    const cycle = await boot.db.taskWorkflowCycle.create({
      data: {
        taskId: task.id,
        sequence: 1,
        status: "open",
        openedWorkflowVersion: task.workflowVersion,
        workflowEngine: "orchestrator_v2",
      },
    });
    await boot.db.task.update({
      where: { id: task.id },
      data: {
        workflowEngine: "orchestrator_v2",
        workflowEnginePinnedAt: new Date(),
        activeWorkflowCycleId: cycle.id,
      },
    });

    const turn = await dispatchWorkflowTurn({ boot, world, taskId: task.id });
    const before = await Promise.all([
      boot.db.activityLog.count({
        where: {
          taskId: task.id,
          kind: "task.workflow.legacy_boundary.invoked",
          payload: { contains: "agent-task-workflow-route" },
        },
      }),
      boot.db.workflowTransition.count({ where: { taskId: task.id } }),
      boot.db.taskWorkflowCommandReceipt.count({ where: { taskId: task.id } }),
    ]);

    const authorizationFailure = await turn.post("request_subtask", {
      subtaskText: "Unauthorized reviewer request",
      comment: "The assignee is not the reviewer.",
    });
    assert.equal(authorizationFailure.status, 403);
    assert.equal(authorizationFailure.body.orchestratorStatus, "forbidden");

    const guardFailure = await turn.post("start");
    assert.equal(guardFailure.status, 409);
    assert.equal(guardFailure.body.orchestratorStatus, "stale");

    const after = await Promise.all([
      boot.db.activityLog.count({
        where: {
          taskId: task.id,
          kind: "task.workflow.legacy_boundary.invoked",
          payload: { contains: "agent-task-workflow-route" },
        },
      }),
      boot.db.workflowTransition.count({ where: { taskId: task.id } }),
      boot.db.taskWorkflowCommandReceipt.count({ where: { taskId: task.id } }),
    ]);
    assert.deepEqual(after, before, "V2 authorization/guard failures create zero legacy or command mutations");

    const startWorld = await seedWorld(boot.db, {
      agentSlug: "phasee08-starter",
      projectSlug: "phasee08-start-project",
    });
    const startTask = await seedTask(boot.db, startWorld, {
      title: "V2 cycle ownership stamp",
      status: "To Do",
      approved: true,
    });
    await boot.db.task.update({
      where: { id: startTask.id },
      data: { workflowEngine: "orchestrator_v2", workflowEnginePinnedAt: new Date() },
    });
    const startTurn = await dispatchWorkflowTurn({ boot, world: startWorld, taskId: startTask.id });
    const startResponse = await startTurn.post("start");
    assert.equal(startResponse.status, 202);
    assert.equal(startResponse.body.orchestratorStatus, "accepted");
    const started = await boot.db.task.findUniqueOrThrow({
      where: { id: startTask.id },
      select: {
        status: true,
        activeWorkflowCycleId: true,
      },
    });
    const startedCycle = await boot.db.taskWorkflowCycle.findUniqueOrThrow({
      where: { id: started.activeWorkflowCycleId! },
      select: { workflowEngine: true },
    });
    assert.equal(started.status, "In Progress");
    assert.equal(startedCycle.workflowEngine, "orchestrator_v2");
    assert.equal(await boot.db.activityLog.count({
      where: {
        taskId: startTask.id,
        kind: "task.workflow.legacy_boundary.invoked",
        payload: { contains: "agent-task-workflow-route" },
      },
    }), 0, "accepted V2 start records no legacy route attempt");
    console.log("[phasee-08-agent-route-integration] PASS");
  } finally {
    await sandbox.dispose();
  }
}

main().catch((error) => {
  console.error("[phasee-08-agent-route-integration] FAIL", error);
  process.exit(1);
});
