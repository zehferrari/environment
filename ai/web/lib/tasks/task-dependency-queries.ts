import { db } from "@/lib/db";
import type { PrismaClient } from "@prisma/client";
import { validateTaskDependency } from "./validate-task-dependency";

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
 */
export async function getTaskDependenciesWithDetails(taskId: string) {
  const [deps, task] = await Promise.all([
    db.taskDependency.findMany({
      where: { taskId },
      include: {
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
    }),
    db.task.findUnique({
      where: { id: taskId },
      select: {
        blockedById: true,
        project: { select: { id: true, name: true } },
      },
    }),
  ]);

  const results: Array<{
    id: string;
    title: string;
    workItemKey: string | null;
    status: string;
    projectId: string | null;
    private: boolean;
    source: "dependency" | "legacy";
  }> = deps.map((d) => ({
    id: d.prerequisite.id,
    title: d.prerequisite.title,
    workItemKey: d.prerequisite.workItemKey,
    status: d.prerequisite.status,
    projectId: d.prerequisite.projectId,
    private: d.prerequisite.private,
    source: "dependency" as const,
  }));

  // Add legacy blockedById if not already in the dependency list
  if (task?.blockedById) {
    const alreadyListed = results.some((r) => r.id === task.blockedById);
    if (!alreadyListed) {
      const legacy = await db.task.findUnique({
        where: { id: task.blockedById },
        select: {
          id: true,
          title: true,
          workItemKey: true,
          status: true,
          projectId: true,
          private: true,
        },
      });
      if (legacy) {
        results.push({
          ...legacy,
          source: "legacy" as const,
        });
      }
    }
  }

  return results;
}

/**
 * Transactional add/remove diff for task dependencies.
 * Full add/remove diff applied transactionally; failed edge rejects whole change.
 */
export async function setTaskDependencies(args: {
  taskId: string;
  prerequisiteTaskIds: string[];
  actorUserId: string;
  db?: PrismaClient;
}): Promise<{ added: string[]; removed: string[] }> {
  const client = args.db ?? db;

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
      prerequisiteTaskId,
      db: client,
    });
    if (!validation.ok) {
      throw new Error(`Cannot add dependency on ${prerequisiteTaskId}: ${validation.reason}`);
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