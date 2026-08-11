import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

async function main() {
  const routeSource = readFileSync("app/api/agent/epics/[epicId]/workflow/route.ts", "utf8");
  const epicPromptSource = readFileSync("lib/agents/context/epic.ts", "utf8");
  assert.match(routeSource, /execution: "parallel" \| "dependent"/);
  assert.match(routeSource, /taskDependency\.createMany/);
  assert.match(routeSource, /allowSharedWorkspace: true/);
  assert.match(epicPromptSource, /Numbering and queue rank are presentation order only|Array order and task numbering NEVER imply a dependency/);

  const sandbox = await mkdtemp(path.join(tmpdir(), "task-dependencies-"));
  const dbUrl = `file:${path.join(sandbox, "test.db")}`;
  process.env.DATABASE_URL = dbUrl;
  try {
    await execFileP("pnpm", ["prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    const { db } = await import("@/lib/db");
    const {
      taskPrerequisites,
      unresolvedTaskPrerequisites,
      validateTaskDependency,
    } = await import("@/lib/tasks/blocking");
    const { assignOpenEpicTasks } = await import("@/lib/epics/assignment");
    const { transitionTask } = await import("@/lib/tasks/transition-kernel");

    const manager = await db.user.create({
      data: { username: "manager", email: "manager@example.invalid", kind: "human", isOwner: true },
    });
    const agent = await db.agent.create({
      data: { slug: "worker", name: "Worker", role: "coding" },
    });
    const worker = await db.user.create({
      data: { username: "worker", email: "worker@example.invalid", kind: "agent", agentId: agent.id },
    });
    const [projectA, projectB, projectC] = await Promise.all([
      db.project.create({ data: { slug: "dependency-a", name: "A" } }),
      db.project.create({ data: { slug: "dependency-b", name: "B" } }),
      db.project.create({ data: { slug: "dependency-c", name: "C" } }),
    ]);
    await db.workspace.create({
      data: {
        slug: "dependency-workspace",
        name: "Dependency Workspace",
        projects: { create: [{ projectId: projectA.id }, { projectId: projectB.id }] },
      },
    });
    const epic = await db.epic.create({
      data: {
        projectId: projectA.id,
        title: "Dependency Epic",
        status: "In Progress",
        approvedOn: new Date(),
        approvedById: manager.id,
        actingManagerId: manager.id,
        reporterId: manager.id,
        workers: { create: { userId: worker.id } },
      },
    });
    const first = await db.task.create({
      data: { projectId: projectB.id, title: "External prerequisite", workItemKey: "B-1", status: "Done" },
    });
    const second = await db.task.create({
      data: { projectId: projectA.id, title: "Local prerequisite", workItemKey: "A-1", status: "To Do" },
    });
    const dependent = await db.task.create({
      data: {
        projectId: projectA.id,
        epicId: epic.id,
        title: "Dependent task",
        workItemKey: "A-2",
        status: "To Do",
        dependencies: {
          create: [
            { prerequisiteTaskId: first.id },
            { prerequisiteTaskId: second.id },
          ],
        },
      },
    });

    assert.equal((await validateTaskDependency({
      taskId: dependent.id,
      projectId: projectA.id,
      prerequisiteTaskId: first.id,
      allowSharedWorkspace: true,
    })).ok, true, "shared-workspace cross-project prerequisite must be valid");
    const isolated = await db.task.create({ data: { projectId: projectC.id, title: "Isolated", status: "To Do" } });
    const isolatedValidation = await validateTaskDependency({
      taskId: dependent.id,
      projectId: projectA.id,
      prerequisiteTaskId: isolated.id,
      allowSharedWorkspace: true,
    });
    assert.equal(isolatedValidation.ok, false);
    assert.equal(isolatedValidation.ok ? null : isolatedValidation.code, "NO_SHARED_WORKSPACE");

    const selected = await db.task.findUniqueOrThrow({
      where: { id: dependent.id },
      select: {
        blockedById: true,
        blockedBy: { select: { id: true, status: true, workItemKey: true } },
        dependencies: { select: { prerequisite: { select: { id: true, status: true, workItemKey: true } } } },
      },
    });
    assert.equal(taskPrerequisites(selected).length, 2);
    assert.deepEqual(unresolvedTaskPrerequisites(selected).map((task) => task.workItemKey), ["A-1"]);

    const blockedAssignment = await db.$transaction((tx) => assignOpenEpicTasks(tx, {
      epicId: epic.id,
      projectId: projectA.id,
      actorUserId: manager.id,
      excludeUserIds: [manager.id],
      via: "dependency-test",
    }));
    assert.equal(blockedAssignment.assignments.length, 0);
    assert.equal(blockedAssignment.skipped, "all_open_tasks_blocked");

    await transitionTask({
      taskId: second.id,
      projectId: projectA.id,
      actorUserId: manager.id,
      intent: "operator_override",
      from: "To Do",
      to: "Done",
      source: "dependency-test",
      idempotencyKey: "complete-prerequisite",
    });
    const refillEffect = await db.workflowOutbox.findFirstOrThrow({
      where: { taskId: second.id, effectType: "dependency_refill" },
    });
    assert.equal(refillEffect.status, "queued", "Done must durably enqueue downstream queue refill");
    const unblockedAssignment = await db.$transaction((tx) => assignOpenEpicTasks(tx, {
      epicId: epic.id,
      projectId: projectA.id,
      actorUserId: manager.id,
      excludeUserIds: [manager.id],
      via: "dependency-test",
    }));
    assert.equal(unblockedAssignment.assignments.length, 1);
    assert.equal(unblockedAssignment.assignments[0].task.id, dependent.id);

    const cycleA = await db.task.create({ data: { projectId: projectA.id, title: "Cycle A" } });
    const cycleB = await db.task.create({
      data: {
        projectId: projectA.id,
        title: "Cycle B",
        dependencies: { create: { prerequisiteTaskId: cycleA.id } },
      },
    });
    const cycle = await validateTaskDependency({
      taskId: cycleA.id,
      projectId: projectA.id,
      prerequisiteTaskId: cycleB.id,
    });
    assert.equal(cycle.ok, false);
    assert.equal(cycle.ok ? null : cycle.code, "CYCLE");

    await db.$disconnect();
    console.log("[task-dependency-graph] PASS");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
