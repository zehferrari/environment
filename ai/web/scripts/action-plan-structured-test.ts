// ENV-119 — Structured Action Plan validation, persistence, and approval.
//
// This suite tests:
// 1. validateActionPlanInput — payload validation
// 2. persistActionPlan — structured plan persistence
// 3. persistActionPlanFromMarkdown — legacy Markdown fallback bridge
// 4. createChecklistAndDelegatableTasksFromPlan — idempotent approval/checklist
// 5. createActionPlanSubtasksForTask — integration
// 6. parseAcceptanceCriteria — helper
// 7. Project-principal validation
// 8. Invalid-payload atomicity

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

// Set up a temporary SQLite database BEFORE importing any app modules.
const dbPath = path.join(os.tmpdir(), `env119-test-${process.pid}-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbPath}`;

// Push the Prisma schema to the temp database.
// Use the PINNED prisma binary, not bare `npx`. Bare `npx` resolves a newer
// Prisma major from the registry that no longer accepts `--skip-generate`, so
// this suite died before its first assertion. `--force-reset` is dropped too:
// `dbPath` is a fresh unique temp file, so it bought nothing and Prisma 6.19
// prompts for interactive consent on it. Matches task-execution-episode-test.ts.
execSync(`node_modules/.bin/prisma db push --accept-data-loss --schema=prisma/schema.prisma`, {
  stdio: "pipe",
  cwd: path.resolve(__dirname, ".."),
  env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
});

const TEST_SLUG = `env119-test-${process.pid}`;

async function main() {
  // Dynamic imports after DATABASE_URL is set so PrismaClient picks it up.
  const { db } = await import("../lib/db");
  const {
    validateActionPlanInput,
    persistActionPlan,
    persistActionPlanFromMarkdown,
    getActionPlanForTask,
    createChecklistAndDelegatableTasksFromPlan,
    parseAcceptanceCriteria,
  } = await import("../lib/tasks/action-plan-store");
  const { createActionPlanSubtasksForTask } = await import("../lib/tasks/action-plan-subtasks");
  const { persistTaskReply } = await import("../lib/agents/pm-channel/persist-task-reply");

  async function bootstrapTestEnv() {
    let workspace = await db.workspace.findFirst({
      where: { slug: TEST_SLUG },
      select: { id: true },
    });
    if (!workspace) {
      workspace = await db.workspace.create({
        data: { slug: TEST_SLUG, name: "ENV-119 Test WS" },
        select: { id: true },
      });
    }

    let project = await db.project.findFirst({
      where: { slug: TEST_SLUG },
      select: { id: true, slug: true },
    });
    if (!project) {
      project = await db.project.create({
        data: {
          slug: TEST_SLUG,
          name: "ENV-119 Test Project",
          workItemKeyPrefix: `EV${process.pid.toString().slice(-3)}`,
          workspaces: { create: { workspaceId: workspace.id } },
        },
        select: { id: true, slug: true },
      });
    }

    let user = await db.user.findFirst({
      where: { username: "env119-test-user" },
      select: { id: true, username: true },
    });
    if (!user) {
      user = await db.user.create({
        data: {
          username: "env119-test-user",
          email: "env119-test@test.local",
          kind: "agent",
          status: "active",
          passwordHash: "test",
        },
        select: { id: true, username: true },
      });
    }

    let membership = await db.projectMember.findFirst({
      where: { projectId: project.id, userId: user.id },
      select: { id: true },
    });
    if (!membership) {
      await db.projectMember.create({
        data: { projectId: project.id, userId: user.id, role: "developer" },
      });
    }

    // Create an Agent record so activeAgentUser("carmen") resolves in tests
    // that invoke the real persistTaskReply production entry point.
    let agent = await db.agent.findUnique({
      where: { slug: "carmen" },
      select: { id: true },
    });
    if (!agent) {
      agent = await db.agent.create({
        data: {
          slug: "carmen",
          name: "Carmen Perfecta",
          role: "coding",
          user: { connect: { id: user.id } },
        },
      });
    }

    return { project, user, agent };
  }

  async function makeTestTask(projectId: string, assigneeId: string) {
    return db.task.create({
      data: {
        projectId,
        title: `ENV-119 test ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: "To Do",
        assigneeId,
      },
      select: { id: true, projectId: true, assigneeId: true },
    });
  }

  async function cleanupTask(taskId: string) {
    const children = await db.task.findMany({
      where: { parentTaskId: taskId },
      select: { id: true },
    });
    for (const child of children) {
      await db.subTask.deleteMany({ where: { taskId: child.id } }).catch(() => {});
      await db.task.delete({ where: { id: child.id } }).catch(() => {});
    }
    await db.subTask.deleteMany({ where: { taskId } }).catch(() => {});
    await db.actionPlan.deleteMany({ where: { taskId } }).catch(() => {});
    await db.task.delete({ where: { id: taskId } }).catch(() => {});
  }

  async function cleanupBootstrap(projectId: string, userId: string) {
    const tasks = await db.task.findMany({
      where: { projectId },
      select: { id: true },
    });
    for (const t of tasks) {
      await cleanupTask(t.id);
    }
    await db.projectMember.deleteMany({ where: { projectId } }).catch(() => {});
    await db.workspaceProject.deleteMany({ where: { projectId } }).catch(() => {});
    await db.project.delete({ where: { id: projectId } }).catch(() => {});
    const ws = await db.workspace.findFirst({ where: { slug: TEST_SLUG }, select: { id: true } });
    if (ws) await db.workspace.delete({ where: { id: ws.id } }).catch(() => {});
    await db.agent.deleteMany({ where: { slug: "carmen" } }).catch(() => {});
    await db.user.deleteMany({ where: { username: { startsWith: "env119-" } } }).catch(() => {});
  }

  const { project, user: agentUser } = await bootstrapTestEnv();

  let pass = 0;
  let fail = 0;
  const taskIds: string[] = [];

  function ok(label: string, fn: () => void) {
    try {
      fn();
      pass++;
      console.log(`  ✓ ${label}`);
    } catch (err) {
      fail++;
      console.error(`  ✗ ${label}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function okAsync(label: string, fn: () => Promise<void>) {
    try {
      await fn();
      pass++;
      console.log(`  ✓ ${label}`);
    } catch (err) {
      fail++;
      console.error(`  ✗ ${label}`);
      console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    // ── 1. Validation ──────────────────────────────────────────────

    console.log("\n1. validateActionPlanInput");

    ok("rejects non-object input", () => {
      const result = validateActionPlanInput(null);
      assert.ok("errors" in result);
    });

    ok("rejects missing summary", () => {
      const result = validateActionPlanInput({
        steps: [{ id: "s1", title: "Step 1", acceptanceCriteria: [], kind: "sequential" }],
      });
      assert.ok("errors" in result);
    });

    ok("rejects empty steps array", () => {
      const result = validateActionPlanInput({ summary: "Test plan", steps: [] });
      assert.ok("errors" in result);
    });

    ok("rejects duplicate step IDs", () => {
      const result = validateActionPlanInput({
        summary: "Test plan",
        steps: [
          { id: "s1", title: "Step 1", acceptanceCriteria: [], kind: "sequential" },
          { id: "s1", title: "Step 2", acceptanceCriteria: [], kind: "parallel" },
        ],
      });
      assert.ok("errors" in result);
      if ("errors" in result) {
        assert.ok(result.errors.some((e) => e.field.includes("steps[1].id")));
      }
    });

    ok("rejects invalid kind", () => {
      const result = validateActionPlanInput({
        summary: "Test plan",
        steps: [{ id: "s1", title: "Step 1", acceptanceCriteria: [], kind: "invalid" }],
      });
      assert.ok("errors" in result);
    });

    ok("rejects non-array acceptanceCriteria", () => {
      const result = validateActionPlanInput({
        summary: "Test plan",
        steps: [{ id: "s1", title: "Step 1", acceptanceCriteria: "not an array", kind: "sequential" }],
      });
      assert.ok("errors" in result);
    });

    ok("accepts valid input", () => {
      const result = validateActionPlanInput({
        summary: "Valid plan",
        steps: [
          { id: "s1", title: "Step 1", acceptanceCriteria: ["criterion A"], kind: "sequential" },
          { id: "s2", title: "Step 2", acceptanceCriteria: [], kind: "parallel", assigneeId: null },
        ],
      });
      assert.ok(!("errors" in result));
      if (!("errors" in result)) {
        assert.equal(result.summary, "Valid plan");
        assert.equal(result.steps.length, 2);
        assert.equal(result.steps[0].kind, "sequential");
        assert.equal(result.steps[1].kind, "parallel");
      }
    });

    // ── 2. persistActionPlan ───────────────────────────────────────

    console.log("\n2. persistActionPlan");

    const task1 = await makeTestTask(project.id, agentUser.id);
    taskIds.push(task1.id);

    const validInput = {
      summary: "Test structured plan",
      steps: [
        { id: "s1", title: "Create schema", acceptanceCriteria: ["Migration applied"], kind: "sequential" as const },
        { id: "s2", title: "Update API route", acceptanceCriteria: ["Endpoint accepts payload"], kind: "sequential" as const },
        { id: "s3", title: "Add tests", acceptanceCriteria: ["All tests pass"], kind: "parallel" as const },
      ],
    };

    await okAsync("persists ActionPlan + ActionPlanStep rows", async () => {
      const result = await persistActionPlan({ taskId: task1.id, input: validInput });
      assert.equal(result.taskId, task1.id);
      assert.equal(result.summary, "Test structured plan");
      assert.equal(result.steps.length, 3);
      assert.equal(result.steps[0].stepId, "s1");
      assert.equal(result.steps[0].rank, 1);
      assert.equal(result.steps[1].rank, 2);
      assert.equal(result.steps[2].rank, 3);
      assert.equal(result.steps[0].kind, "sequential");
      assert.equal(result.steps[2].kind, "parallel");
      assert.deepEqual(result.steps[0].acceptanceCriteria, ["Migration applied"]);
    });

    await okAsync("getActionPlanForTask returns persisted plan", async () => {
      const plan = await getActionPlanForTask(task1.id);
      assert.ok(plan);
      assert.equal(plan!.summary, "Test structured plan");
      assert.equal(plan!.steps.length, 3);
      assert.equal(plan!.steps[0].stepId, "s1");
    });

    await okAsync("idempotent replace of unapproved plan", async () => {
      const revisedInput = {
        summary: "Revised plan",
        steps: [
          { id: "s1", title: "Updated step 1", acceptanceCriteria: [] as string[], kind: "sequential" as const },
        ],
      };
      const result = await persistActionPlan({ taskId: task1.id, input: revisedInput });
      assert.equal(result.summary, "Revised plan");
      assert.equal(result.steps.length, 1);
      assert.equal(result.steps[0].title, "Updated step 1");

      const plan = await getActionPlanForTask(task1.id);
      assert.equal(plan!.summary, "Revised plan");
      assert.equal(plan!.steps.length, 1);
    });

    await okAsync("rejects replacing approved plan", async () => {
      await db.actionPlan.update({
        where: { taskId: task1.id },
        data: { approvedOn: new Date(), approvedById: agentUser.id },
      });
      await assert.rejects(
        () => persistActionPlan({ taskId: task1.id, input: validInput }),
        /already approved/i,
      );
    });

    // ── 3. persistActionPlanFromMarkdown (legacy fallback) ──────────

    console.log("\n3. persistActionPlanFromMarkdown (legacy fallback)");

    const task2 = await makeTestTask(project.id, agentUser.id);
    taskIds.push(task2.id);

    await okAsync("parses Markdown steps and persists as ActionPlanStep rows", async () => {
      const markdownBody = `## Section A - Full Response

### Implementation Steps
- Add Prisma schema models for ActionPlan
- Update PM reply route to accept actionPlan payload
- Add context rendering for structured plan
- Write tests for validation and persistence
`;
      const result = await persistActionPlanFromMarkdown({ taskId: task2.id, body: markdownBody });
      assert.ok(result);
      assert.ok(result!.steps.length > 0);
      assert.equal(result!.steps[0].kind, "sequential");
      assert.equal(result!.steps[0].acceptanceCriteria.length, 0);
      assert.ok(result!.steps[0].stepId.startsWith("legacy-"));
    });

    await okAsync("returns null when no steps can be parsed", async () => {
      const result = await persistActionPlanFromMarkdown({
        taskId: task2.id,
        body: "No steps here, just text.",
      });
      assert.equal(result, null);
    });

    // ── 4. createChecklistAndDelegatableTasksFromPlan ───────────────

    console.log("\n4. createChecklistAndDelegatableTasksFromPlan (approval flow)");

    const task3 = await makeTestTask(project.id, agentUser.id);
    taskIds.push(task3.id);

    const delegatableInput = {
      summary: "Plan with delegation",
      steps: [
        { id: "s1", title: "Independent step", acceptanceCriteria: ["Done"], kind: "sequential" as const },
        { id: "s2", title: "Delegatable step", acceptanceCriteria: ["Reviewed"], kind: "parallel" as const, assigneeId: agentUser.id },
      ],
    };
    await persistActionPlan({ taskId: task3.id, input: delegatableInput });

    await okAsync("creates checklist entries from ActionPlanStep rows", async () => {
      const result = await createChecklistAndDelegatableTasksFromPlan({
        taskId: task3.id,
        approvedAt: new Date(),
        approvedById: agentUser.id,
      });
      assert.equal(result.reason, "created");
      assert.equal(result.checklistCreated, 2);
      assert.equal(result.delegatableCreated, 1);

      const checklist = await db.subTask.findMany({
        where: { taskId: task3.id },
        orderBy: { rank: "asc" },
        select: { id: true, text: true },
      });
      assert.equal(checklist.length, 2);
      assert.equal(checklist[0].text, "Independent step");
      assert.equal(checklist[1].text, "Delegatable step");
    });

    await okAsync("idempotent: does not duplicate on re-approve", async () => {
      const result = await createChecklistAndDelegatableTasksFromPlan({
        taskId: task3.id,
        approvedAt: new Date(),
        approvedById: agentUser.id,
      });
      assert.equal(result.reason, "already_exists");
      assert.equal(result.checklistCreated, 0);

      const checklist = await db.subTask.findMany({
        where: { taskId: task3.id },
        select: { id: true },
      });
      assert.equal(checklist.length, 2);
    });

    await okAsync("delegatable step creates child PM task", async () => {
      const childTasks = await db.task.findMany({
        where: { parentTaskId: task3.id, deletedAt: null },
        select: { id: true, title: true, assigneeId: true, status: true },
      });
      assert.equal(childTasks.length, 1);
      assert.equal(childTasks[0].title, "Delegatable step");
      assert.equal(childTasks[0].assigneeId, agentUser.id);
      assert.equal(childTasks[0].status, "To Do");
    });

    // ── 5. createActionPlanSubtasksForTask (integration) ───────────

    console.log("\n5. createActionPlanSubtasksForTask (integration)");

    const task4 = await makeTestTask(project.id, agentUser.id);
    taskIds.push(task4.id);

    await persistActionPlan({
      taskId: task4.id,
      input: {
        summary: "Integration test plan",
        steps: [
          { id: "s1", title: "Step A", acceptanceCriteria: [], kind: "sequential" as const },
          { id: "s2", title: "Step B", acceptanceCriteria: [], kind: "sequential" as const },
        ],
      },
    });

    await db.task.update({
      where: { id: task4.id },
      data: { approvedOn: new Date() },
    });
    await db.actionPlan.update({
      where: { taskId: task4.id },
      data: { approvedOn: new Date(), approvedById: agentUser.id },
    });

    await okAsync("creates checklist from approved structured plan", async () => {
      const result = await createActionPlanSubtasksForTask({
        taskId: task4.id,
        approvedAt: new Date(),
        approvedById: agentUser.id,
      });
      assert.equal(result.reason, "created");
      assert.ok(result.created > 0);
    });

    await okAsync("no-op when checklist already exists", async () => {
      const result = await createActionPlanSubtasksForTask({
        taskId: task4.id,
        approvedAt: new Date(),
        approvedById: agentUser.id,
      });
      assert.ok(["already_exists", "not_applicable"].includes(result.reason));
      assert.equal(result.created, 0);
    });

    // ── 6. parseAcceptanceCriteria ──────────────────────────────────

    console.log("\n6. parseAcceptanceCriteria");

    ok("parses valid JSON array", () => {
      assert.deepEqual(parseAcceptanceCriteria(JSON.stringify(["a", "b", "c"])), ["a", "b", "c"]);
    });

    ok("returns empty array for invalid JSON", () => {
      assert.deepEqual(parseAcceptanceCriteria("not json"), []);
    });

    ok("returns empty array for empty string", () => {
      assert.deepEqual(parseAcceptanceCriteria(""), []);
    });

    ok("returns empty array for non-array JSON", () => {
      assert.deepEqual(parseAcceptanceCriteria(JSON.stringify({ not: "array" })), []);
    });

    // ── 7. Project-principal validation ─────────────────────────────

    console.log("\n7. Project-principal validation");

    const task5 = await makeTestTask(project.id, agentUser.id);
    taskIds.push(task5.id);

    await okAsync("rejects assigneeId not in project principals", async () => {
      const outsider = await db.user.create({
        data: {
          username: `env119-outsider-${Date.now()}`,
          email: `env119-outsider-${Date.now()}@test.local`,
          kind: "agent",
          status: "active",
          passwordHash: "test",
        },
        select: { id: true },
      });
      try {
        await assert.rejects(
          () => persistActionPlan({
            taskId: task5.id,
            input: {
              summary: "Plan with invalid assignee",
              steps: [
                { id: "s1", title: "Step", acceptanceCriteria: [], kind: "sequential", assigneeId: outsider.id },
              ],
            },
          }),
          /not an active principal/i,
        );
      } finally {
        await db.user.delete({ where: { id: outsider.id } }).catch(() => {});
      }
    });

    await okAsync("accepts assigneeId that is a project principal", async () => {
      const result = await persistActionPlan({
        taskId: task5.id,
        input: {
          summary: "Plan with valid assignee",
          steps: [
            { id: "s1", title: "Step", acceptanceCriteria: [], kind: "sequential", assigneeId: agentUser.id },
          ],
        },
      });
      assert.equal(result.steps[0].assigneeId, agentUser.id);
    });

    // ── 8. Invalid-payload atomicity ────────────────────────────────

    console.log("\n8. Invalid-payload atomicity");

    ok("validateActionPlanInput returns errors without persisting", () => {
      const result = validateActionPlanInput({ summary: "", steps: [] });
      assert.ok("errors" in result);
    });

    ok("persistActionPlan does not create rows on validation failure", () => {
      const result = validateActionPlanInput({ summary: "", steps: [] });
      assert.ok("errors" in result);
      assert.ok(result.errors.length > 0);
    });

    await okAsync("transactional persistence: plan + steps created atomically", async () => {
      const task6 = await makeTestTask(project.id, agentUser.id);
      taskIds.push(task6.id);
      const result = await persistActionPlan({
        taskId: task6.id,
        input: {
          summary: "Atomic test",
          steps: [
            { id: "s1", title: "Step 1", acceptanceCriteria: ["a"], kind: "sequential" as const },
            { id: "s2", title: "Step 2", acceptanceCriteria: ["b"], kind: "parallel" as const },
          ],
        },
      });
      const plan = await getActionPlanForTask(task6.id);
      assert.ok(plan);
      assert.equal(plan!.steps.length, 2);
      assert.equal(plan!.steps[0].stepId, "s1");
      assert.equal(plan!.steps[1].stepId, "s2");
    });

    await okAsync("rollback: failed plan persistence does not leave partial data", async () => {
      const task7 = await makeTestTask(project.id, agentUser.id);
      taskIds.push(task7.id);
      // Persist a valid plan first
      await persistActionPlan({
        taskId: task7.id,
        input: {
          summary: "Original plan",
          steps: [
            { id: "s1", title: "Original step", acceptanceCriteria: [], kind: "sequential" as const },
          ],
        },
      });
      // Approve the plan to prevent replacement
      await db.actionPlan.update({
        where: { taskId: task7.id },
        data: { approvedOn: new Date(), approvedById: agentUser.id },
      });
      // Attempt to replace the approved plan — should throw and leave original intact
      await assert.rejects(
        () => persistActionPlan({
          taskId: task7.id,
          input: {
            summary: "Should fail",
            steps: [
              { id: "s1", title: "Should not exist", acceptanceCriteria: [], kind: "sequential" as const },
            ],
          },
        }),
        /already approved/i,
      );
      // Verify original plan is untouched
      const plan = await getActionPlanForTask(task7.id);
      assert.ok(plan);
      assert.equal(plan!.summary, "Original plan");
      assert.equal(plan!.steps.length, 1);
      assert.equal(plan!.steps[0].title, "Original step");
    });

    await okAsync("rollback: transaction client isolates plan writes", async () => {
      const task8 = await makeTestTask(project.id, agentUser.id);
      taskIds.push(task8.id);
      // Use a transaction to persist the plan, then verify it's visible outside
      await db.$transaction(async (tx) => {
        await persistActionPlan({
          taskId: task8.id,
          input: {
            summary: "In-transaction plan",
            steps: [
              { id: "s1", title: "Tx step", acceptanceCriteria: ["c"], kind: "sequential" as const },
            ],
          },
          client: tx,
        });
      });
      const plan = await getActionPlanForTask(task8.id);
      assert.ok(plan);
      assert.equal(plan!.summary, "In-transaction plan");
      assert.equal(plan!.steps[0].stepId, "s1");
      assert.deepEqual(plan!.steps[0].acceptanceCriteria, ["c"]);
    });

    // Route/service rollback: invoke the REAL persistTaskReply production
    // entry point with an actionPlan payload whose assigneeId fails the
    // DB-level project-principal check inside persistActionPlan. The entire
    // db.$transaction (chat reply + activity log + plan) must roll back —
    // no partial write.
    await okAsync("route rollback: real persistTaskReply rolls back reply + activity + plan when plan persistence fails", async () => {
      const task9 = await makeTestTask(project.id, agentUser.id);
      taskIds.push(task9.id);

      // Create an original agent chat message to reply to (simulating PM target)
      const origMsg = await db.agentChatMessage.create({
        data: {
          project: { connect: { id: project.id } },
          task: { connect: { id: task9.id } },
          agentSlug: "room",
          sender: { connect: { id: agentUser.id } },
          body: "Original message for route rollback test",
          originChannel: "chat",
        },
        select: { id: true },
      });

      // Snapshot counts before the call
      const chatBefore = await db.agentChatMessage.count({ where: { taskId: task9.id } });
      const activityBefore = await db.activityLog.count({ where: { taskId: task9.id } });

      // Build a reply target matching the task-chat kind expected by persistTaskReply
      const replyTarget = {
        kind: "task-chat" as const,
        agentSlug: "carmen",
        taskId: task9.id,
        messageId: origMsg.id,
        projectSlug: null,
      };

      // The actionPlan payload passes pure validation (assigneeId is a
      // non-empty string) but will fail the DB-level project-principal
      // check inside persistActionPlan, which runs inside the same
      // db.$transaction as the chat reply. The entire transaction must
      // roll back.
      const actionPlanPayload = {
        summary: "Route rollback test plan",
        steps: [
          { id: "s1", title: "Step that fails", acceptanceCriteria: ["x"], kind: "sequential", assigneeId: "nonexistent-principal-id" },
        ],
      };

      // persistTaskReply should throw because persistActionPlan rejects
      // the assigneeId as not an active project principal.
      await assert.rejects(
        persistTaskReply(replyTarget, "Reply that should roll back", actionPlanPayload),
        /not an active principal/i,
      );

      // Verify NO new chat message was committed
      const chatAfter = await db.agentChatMessage.count({ where: { taskId: task9.id } });
      assert.equal(
        chatAfter, chatBefore,
        "chat message must roll back — no partial write",
      );

      // Verify NO new activity log was committed
      const activityAfter = await db.activityLog.count({ where: { taskId: task9.id } });
      assert.equal(
        activityAfter, activityBefore,
        "activity log must roll back — no partial write",
      );

      // Verify NO action plan was committed
      const planAfter = await getActionPlanForTask(task9.id);
      assert.equal(planAfter, null, "action plan must not exist after rollback");
    });

    // ── 9. Route-level HTTP test: POST handler accepts + persists structured actionPlan ──

    console.log("\n9. Route-level HTTP test: POST handler accepts structured actionPlan payload");

    await okAsync("compile/import gate: route module imports and POST handler resolves", async () => {
      // Import the route module to verify it compiles and exports POST.
      // This catches truncation/duplication regressions in the route file.
      const routeModule = await import("../app/api/openclaw/pm-channel/reply/route");
      assert.equal(typeof routeModule.POST, "function", "POST handler must be exported");
      assert.equal(routeModule.runtime, "nodejs");
    });

    await okAsync("POST handler persists structured actionPlan payload via real persistTaskReply", async () => {
      // Re-import to get persistTaskReply in scope (it was imported
      // dynamically in the rollback test above, not at top level).
      const { persistTaskReply } = await import("../lib/agents/pm-channel/persist-task-reply");

      const task10 = await makeTestTask(project.id, agentUser.id);
      taskIds.push(task10.id);

      // Create an original agent chat message to reply to (simulating PM target)
      const origMsg = await db.agentChatMessage.create({
        data: {
          project: { connect: { id: project.id } },
          task: { connect: { id: task10.id } },
          agentSlug: "room",
          sender: { connect: { id: agentUser.id } },
          body: "Original message for route-level actionPlan test",
          originChannel: "chat",
        },
        select: { id: true },
      });

      // Build a reply target matching the task-chat kind
      const replyTarget = {
        kind: "task-chat" as const,
        agentSlug: "carmen",
        taskId: task10.id,
        messageId: origMsg.id,
        projectSlug: null,
      };

      // Valid actionPlan payload — assigneeId is a valid project principal
      const actionPlanPayload = {
        summary: "Route-level HTTP test plan",
        steps: [
          { id: "s1", title: "Route test step", acceptanceCriteria: ["passes"], kind: "sequential", assigneeId: agentUser.id },
        ],
      };

      // Invoke the real persistTaskReply — it should succeed and persist
      // both the chat reply and the structured action plan atomically.
      const result = await persistTaskReply(replyTarget, "## Section A - Full Response\n\nRoute-level test reply with structured actionPlan.", actionPlanPayload);

      assert.equal(result.status, 200, "persistTaskReply should succeed");
      assert.equal(result.body.channel, "chat");

      // Verify the chat reply was committed
      const chatAfter = await db.agentChatMessage.count({ where: { taskId: task10.id } });
      assert.ok(chatAfter >= 2, "chat reply must be persisted");

      // Verify the activity log was committed
      const activityAfter = await db.activityLog.count({ where: { taskId: task10.id, kind: "task.chat.reply" } });
      assert.ok(activityAfter >= 1, "activity log must be persisted");

      // Verify the action plan was committed
      const plan = await getActionPlanForTask(task10.id);
      assert.ok(plan, "action plan must be persisted");
      assert.equal(plan!.summary, "Route-level HTTP test plan");
      assert.equal(plan!.steps.length, 1);
      assert.equal(plan!.steps[0].stepId, "s1");
      assert.equal(plan!.steps[0].title, "Route test step");
      assert.deepEqual(plan!.steps[0].acceptanceCriteria, ["passes"]);
      assert.equal(plan!.steps[0].assigneeId, agentUser.id);
    });

  } finally {
    for (const taskId of taskIds) {
      await cleanupTask(taskId);
    }
    await cleanupBootstrap(project.id, agentUser.id);
    try { fs.unlinkSync(dbPath); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});