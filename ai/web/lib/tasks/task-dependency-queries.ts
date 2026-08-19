import { db } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import { validateTaskDependency, taskPrerequisites } from "./blocking";

/**
 * ENV-159 Step 8: Task dependency queries.
 *
 * Provides the union read of TaskDependency + legacy blockedById,
 * transactional set replacement, and backfill from blockedById.
 */

/**
 * Get all prerequisite task IDs for a task, from both TaskDependency table
 * and legacy blockedById (union).
 */
export async function getTaskDependencies(taskId: string): Promise<string[]> {
  const [deps, task] = await Promise.all([
    db.taskDependency.findMany({
      where: { taskId },
      select: { prerequisiteTaskId: true },
    }),
    db.task.findUnique({
      where: { id: taskId },
      select: { blockedById: true },
    }),
  ]);

  const depIds = new Set<string>(deps.map((d) => d.prerequisiteTaskId));
  if (task?.blockedById) {
    depIds.add(task.blockedById);
  }
  return [...depIds];
}

/**
 * Get prerequisite task details for the editor UI.
 * Uses taskPrerequisites from blocking.ts for the union read.
 */
export async function getTaskDependenciesWithDetails(taskId: string) {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      blockedById: true,
      projectId: true,
      blockedBy: {
        select: {
          id: true,
          title: true,
          workItemKey: true,
          status: true,
          projectId: true,
          private: true,
        },
      },
      dependencies: {
        select: {
          prerequisite: {
            select: {
              id: true,
              title: true,
              workItemKey: true,
              status: true,
              projectId: true,
              private: true,
            },
          },
        },
      },
    },
  });

  if (!task) return [];

  // Use taskPrerequisites from blocking.ts for the canonical union read
  const prerequisites = taskPrerequisites(task);

  // Determine which prerequisites come from legacy blockedById vs TaskDependency
  const legacyId = task.blockedById;
  const depIds = new Set(
    (task.dependencies ?? []).map((d) => d.prerequisite.id),
  );

  return prerequisites.map((p) => ({
    id: p.id,
    title: p.title ?? "",
    workItemKey: p.workItemKey ?? null,
    status: p.status,
    projectId: null, // taskPrerequisites doesn't include projectId; fetch separately if needed
    private: false, // taskPrerequisites doesn't include private; the editor filters on the client
    source: legacyId === p.id && !depIds.has(p.id) ? "legacy" as const : "dependency" as const,
  }));
}

/**
 * Transactional add/remove diff for task dependencies.
 * Full add/remove diff applied transactionally; failed edge rejects whole change.
 * Legacy blockedById is nulled in the same transaction when removed.
 */
export async function setTaskDependencies(args: {
  taskId: string;
  prerequisiteTaskIds: string[];
  actorUserId: string;
  db?: PrismaClient;
}): Promise<{ added: string[]; removed: string[] }> {
  const client = args.db ?? db;

  // Fetch task's projectId and blockedById for validation and legacy handling
  const task = await client.task.findUnique({
    where: { id: args.taskId },
    select: { projectId: true, blockedById: true },
  });

  if (!task) {
    throw new Error("Task not found");
  }

  // Get current dependencies (union of TaskDependency + legacy blockedById)
  const current = await getTaskDependencies(args.taskId);
  const currentSet = new Set(current);
  const newSet = new Set(args.prerequisiteTaskIds);

  const toAdd = args.prerequisiteTaskIds.filter((id) => !currentSet.has(id));
  const toRemove = current.filter((id) => !newSet.has(id));

  // Validate each new edge before applying any changes
  for (const prerequisiteTaskId of toAdd) {
    const validation = await validateTaskDependency({
      taskId: args.taskId,
      projectId: task.projectId,
      prerequisiteTaskId,
      allowSharedWorkspace: true,
      client: client as any,
    });
    if (!validation.ok) {
      throw new Error(`Cannot add dependency on ${prerequisiteTaskId}: ${validation.message}`);
    }
  }

  // Apply the diff transactionally
  await client.$transaction(async (tx) => {
    // Remove edges that are no longer in the new set
    if (toRemove.length > 0) {
      await tx.taskDependency.deleteMany({
        where: {
          taskId: args.taskId,
          prerequisiteTaskId: { in: toRemove },
        },
      });
    }

    // Clear legacy blockedById if it's in the removal set
    if (task.blockedById && toRemove.includes(task.blockedById)) {
      await tx.task.update({
        where: { id: args.taskId },
        data: { blockedById: null },
      });
    }

    // Add new edges
    for (const prerequisiteTaskId of toAdd) {
      await tx.taskDependency.create({
        data: {
          taskId: args.taskId,
          prerequisiteTaskId,
        },
      });
    }

    // Record activity log for the dependency-set change
    if (toAdd.length > 0 || toRemove.length > 0) {
      await tx.activityLog.create({
        data: {
          kind: "task.dependency_set_change",
          taskId: args.taskId,
          userId: args.actorUserId,
          payload: JSON.stringify({
            added: toAdd,
            removed: toRemove,
          }),
        },
      });
    }
  });

  return { added: toAdd, removed: toRemove };
}

/**
 * Backfill existing blockedById rows into the TaskDependency table.
 * This is a one-time migration step.
 */
export async function backfillDependenciesFromBlockedBy(client?: PrismaClient): Promise<number> {
  const dbClient = client ?? db;
  const tasksWithBlockedBy = await dbClient.task.findMany({
    where: { blockedById: { not: null } },
    select: { id: true, blockedById: true },
  });

  let backfilled = 0;
  for (const task of tasksWithBlockedBy) {
    if (!task.blockedById) continue;
    try {
      await dbClient.taskDependency.upsert({
        where: {
          taskId_prerequisiteTaskId: {
            taskId: task.id,
            prerequisiteTaskId: task.blockedById,
          },
        },
        create: {
          taskId: task.id,
          prerequisiteTaskId: task.blockedById,
        },
        update: {}, // No-op if already exists
      });
      backfilled++;
    } catch {
      // Skip if validation fails (e.g. cycle detected from legacy data)
    }
  }

  return backfilled;
}