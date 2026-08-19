import assert from "node:assert/strict";
import { validateTaskDependency } from "@/lib/tasks/validate-task-dependency";
import type { PrismaClient } from "@prisma/client";

/**
 * ENV-159 Step 7: Multi-prerequisite editor tests.
 *
 * Tests call the REAL exported validateTaskDependency function with a mock
 * PrismaClient — no hand-written re-implementations.
 *
 * Covers: self-dependency, duplicate, inaccessible/private, deleted task,
 * direct cycle, transitive cycle, valid dependency.
 */

// ---------------------------------------------------------------------------
// Mock PrismaClient — in-memory task/dependency store
// ---------------------------------------------------------------------------

interface MockTask {
  id: string;
  private: boolean;
  deletedAt: Date | null;
  projectId: string;
  blockedById: string | null;
}

interface MockDependency {
  id: string;
  taskId: string;
  prerequisiteTaskId: string;
}

function createMockDb(opts: {
  tasks?: MockTask[];
  dependencies?: MockDependency[];
} = {}) {
  const tasks = new Map((opts.tasks ?? []).map((t) => [t.id, t]));
  const deps = new Map((opts.dependencies ?? []).map((d) => [`${d.taskId}|${d.prerequisiteTaskId}`, d]));

  const mockDb = {
    taskDependency: {
      findUnique: async ({ where }: { where: { taskId_prerequisiteTaskId: { taskId: string; prerequisiteTaskId: string } } }) => {
        const key = `${where.taskId_prerequisiteTaskId.taskId}|${where.taskId_prerequisiteTaskId.prerequisiteTaskId}`;
        return deps.get(key) ?? null;
      },
      findMany: async ({ where }: { where: { taskId: string } }) => {
        const results: MockDependency[] = [];
        for (const [key, dep] of deps) {
          if (dep.taskId === where.taskId) results.push(dep);
        }
        return results;
      },
    },
    task: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        return tasks.get(where.id) ?? null;
      },
    },
  } as unknown as PrismaClient;

  return mockDb;
}

// ---------------------------------------------------------------------------
// Test 1: Reject self-dependency
// ---------------------------------------------------------------------------

export async function testRejectSelfDependency() {
  const mockDb = createMockDb({
    tasks: [{ id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null }],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-1", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("itself"));
}

// ---------------------------------------------------------------------------
// Test 2: Reject duplicate
// ---------------------------------------------------------------------------

export async function testRejectDuplicate() {
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: false, deletedAt: null, projectId: "p1", blockedById: null },
    ],
    dependencies: [{ id: "dep-1", taskId: "task-1", prerequisiteTaskId: "task-2" }],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("already exists"));
}

// ---------------------------------------------------------------------------
// Test 3: Reject inaccessible/private task
// ---------------------------------------------------------------------------

export async function testRejectPrivateTask() {
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: true, deletedAt: null, projectId: "p2", blockedById: null },
    ],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("private"));
}

// ---------------------------------------------------------------------------
// Test 4: Reject deleted task
// ---------------------------------------------------------------------------

export async function testRejectDeletedTask() {
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: false, deletedAt: new Date(), projectId: "p1", blockedById: null },
    ],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("deleted"));
}

// ---------------------------------------------------------------------------
// Test 5: Reject direct cycle
// ---------------------------------------------------------------------------

export async function testRejectDirectCycle() {
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: false, deletedAt: null, projectId: "p1", blockedById: null },
    ],
    dependencies: [{ id: "dep-1", taskId: "task-2", prerequisiteTaskId: "task-1" }],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("direct cycle"));
}

// ---------------------------------------------------------------------------
// Test 6: Reject transitive cycle (A→B→C→A)
// ---------------------------------------------------------------------------

export async function testRejectTransitiveCycle() {
  // task-2 depends on task-3, task-3 depends on task-1
  // Adding task-1 depends on task-2 would create: task-1→task-2→task-3→task-1
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-3", private: false, deletedAt: null, projectId: "p1", blockedById: null },
    ],
    dependencies: [
      { id: "dep-1", taskId: "task-2", prerequisiteTaskId: "task-3" },
      { id: "dep-2", taskId: "task-3", prerequisiteTaskId: "task-1" },
    ],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("transitive cycle"));
}

// ---------------------------------------------------------------------------
// Test 7: Accept valid dependency
// ---------------------------------------------------------------------------

export async function testAcceptValidDependency() {
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: false, deletedAt: null, projectId: "p1", blockedById: null },
    ],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, true, "Valid dependency should be accepted");
}

// ---------------------------------------------------------------------------
// Test 8: Transitive cycle via legacy blockedById
// ---------------------------------------------------------------------------

export async function testTransitiveCycleViaLegacyBlockedBy() {
  // task-2 has legacy blockedById = task-3, task-3 depends on task-1
  // Adding task-1 depends on task-2 would create: task-1→task-2→(blockedBy)task-3→task-1
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: false, deletedAt: null, projectId: "p1", blockedById: "task-3" },
      { id: "task-3", private: false, deletedAt: null, projectId: "p1", blockedById: null },
    ],
    dependencies: [{ id: "dep-1", taskId: "task-3", prerequisiteTaskId: "task-1" }],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("transitive cycle"));
}

// ---------------------------------------------------------------------------
// Test 9: Private task in same project is accessible
// ---------------------------------------------------------------------------

export async function testPrivateSameProjectAccessible() {
  const mockDb = createMockDb({
    tasks: [
      { id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null },
      { id: "task-2", private: true, deletedAt: null, projectId: "p1", blockedById: null },
    ],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-2", db: mockDb });
  assert.equal(result.ok, true, "Private task in same project should be accessible");
}

// ---------------------------------------------------------------------------
// Test 10: Nonexistent prerequisite task
// ---------------------------------------------------------------------------

export async function testNonexistentPrerequisite() {
  const mockDb = createMockDb({
    tasks: [{ id: "task-1", private: false, deletedAt: null, projectId: "p1", blockedById: null }],
  });
  const result = await validateTaskDependency({ taskId: "task-1", prerequisiteTaskId: "task-999", db: mockDb });
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes("does not exist"));
}

// ---------------------------------------------------------------------------
// Run all tests
// ---------------------------------------------------------------------------

export async function runEnv159MultiPrerequisiteTests() {
  await testRejectSelfDependency();
  await testRejectDuplicate();
  await testRejectPrivateTask();
  await testRejectDeletedTask();
  await testRejectDirectCycle();
  await testRejectTransitiveCycle();
  await testAcceptValidDependency();
  await testTransitiveCycleViaLegacyBlockedBy();
  await testPrivateSameProjectAccessible();
  await testNonexistentPrerequisite();
  console.log("✓ ENV-159 multi-prerequisite editor tests (10 tests) passed");
}

// Self-execute when run directly
if (process.argv[1] && process.argv[1].endsWith("env159-multi-prerequisite-test.ts")) {
  runEnv159MultiPrerequisiteTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}