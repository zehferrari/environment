import { db } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";

/**
 * ENV-159 Step 8: Validate a task dependency edge before writing it.
 *
 * Checks:
 * 1. Self-dependency (task cannot depend on itself)
 * 2. Duplicate (edge already exists in TaskDependency table)
 * 3. Inaccessible/private task
 * 4. Direct cycle (prerequisite depends on task)
 * 5. Transitive cycle (following the dependency chain from prerequisiteTaskId
 *    leads back to taskId)
 *
 * Returns { ok: true } if the edge is valid, or { ok: false, reason } with a
 * descriptive reason for each rejection case.
 */
export async function validateTaskDependency(args: {
  taskId: string;
  prerequisiteTaskId: string;
  db?: PrismaClient;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = args.db ?? db;

  // 1. Self-dependency
  if (args.taskId === args.prerequisiteTaskId) {
    return { ok: false, reason: "A task cannot depend on itself" };
  }

  // 2. Duplicate check — existing edge in TaskDependency table
  const existing = await client.taskDependency.findUnique({
    where: {
      taskId_prerequisiteTaskId: {
        taskId: args.taskId,
        prerequisiteTaskId: args.prerequisiteTaskId,
      },
    },
    select: { id: true },
  });
  if (existing) {
    return { ok: false, reason: "This dependency edge already exists" };
  }

  // 3. Inaccessible/private task — the prerequisite must be visible
  const prerequisite = await client.task.findUnique({
    where: { id: args.prerequisiteTaskId },
    select: { id: true, private: true, deletedAt: true, projectId: true },
  });
  if (!prerequisite) {
    return { ok: false, reason: "Prerequisite task does not exist" };
  }
  if (prerequisite.deletedAt) {
    return { ok: false, reason: "Prerequisite task is deleted" };
  }
  if (prerequisite.private) {
    // Cross-project private tasks are not accessible unless in the same project
    const task = await client.task.findUnique({
      where: { id: args.taskId },
      select: { projectId: true },
    });
    if (!task || task.projectId !== prerequisite.projectId) {
      return { ok: false, reason: "Prerequisite task is private and not accessible" };
    }
  }

  // 4. Direct cycle — prerequisite depends on task
  const directCycle = await client.taskDependency.findUnique({
    where: {
      taskId_prerequisiteTaskId: {
        taskId: args.prerequisiteTaskId,
        prerequisiteTaskId: args.taskId,
      },
    },
    select: { id: true },
  });
  if (directCycle) {
    return { ok: false, reason: "Adding this dependency would create a direct cycle" };
  }

  // 5. Transitive cycle — follow the dependency chain from prerequisiteTaskId
  // to see if it leads back to taskId. BFS with a visited set to prevent
  // infinite loops on existing cycles.
  const visited = new Set<string>();
  const queue: string[] = [args.prerequisiteTaskId];
  let depth = 0;
  const MAX_DEPTH = 50; // Safety limit

  while (queue.length > 0 && depth < MAX_DEPTH) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    if (current === args.taskId) {
      return {
        ok: false,
        reason: "Adding this dependency would create a transitive cycle",
      };
    }

    // Also check legacy blockedById for cycle detection
    const currentTask = await client.task.findUnique({
      where: { id: current },
      select: { blockedById: true },
    });

    const deps = await client.taskDependency.findMany({
      where: { taskId: current },
      select: { prerequisiteTaskId: true },
    });

    for (const dep of deps) {
      if (!visited.has(dep.prerequisiteTaskId)) {
        queue.push(dep.prerequisiteTaskId);
      }
    }

    // Check legacy blockedById as well
    if (currentTask?.blockedById && !visited.has(currentTask.blockedById)) {
      queue.push(currentTask.blockedById);
    }

    depth++;
  }

  return { ok: true };
}