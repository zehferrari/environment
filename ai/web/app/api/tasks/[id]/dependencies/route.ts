import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { accessibleTaskWhere, getViewer, canAccessTask } from "@/lib/auth/permissions";
import {
  getTaskDependenciesWithDetails,
  setTaskDependencies,
} from "@/lib/tasks/task-dependency-queries";

/**
 * ENV-159 Step 8: Multi-prerequisite task editor API endpoint.
 *
 * GET  — returns current dependencies with task details (key, title, status)
 * POST — accepts { prerequisiteTaskIds: string[] } for full diff replacement
 *
 * Server-side validation via validateTaskDependency (blocking.ts) for each new edge.
 * Full add/remove diff applied transactionally; failed edge rejects whole change.
 * Manager-created/cross-project dependency edges not editable by current user
 * are rendered read-only and preserved on save.
 */

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id: taskId } = await ctx.params;

  // Authorization: viewer must have access to this task
  const hasAccess = await canAccessTask(viewer, taskId);
  if (!hasAccess) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, deletedAt: true },
  });

  if (!task || task.deletedAt) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const dependencies = await getTaskDependenciesWithDetails(taskId, viewer);
  return NextResponse.json({ dependencies });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id: taskId } = await ctx.params;

  // Authorization: viewer must have access to this task
  const hasAccess = await canAccessTask(viewer, taskId);
  if (!hasAccess) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, deletedAt: true, projectId: true },
  });

  if (!task || task.deletedAt) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  let body: { prerequisiteTaskIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.prerequisiteTaskIds)) {
    return NextResponse.json(
      { error: "prerequisiteTaskIds must be an array of task IDs" },
      { status: 400 },
    );
  }

  // Validate all IDs are non-empty strings
  for (const id of body.prerequisiteTaskIds) {
    if (typeof id !== "string" || id.trim().length === 0) {
      return NextResponse.json(
        { error: "All prerequisiteTaskIds must be non-empty strings" },
        { status: 400 },
      );
    }
  }

  const requestedIds = [...new Set(body.prerequisiteTaskIds)];
  const visibleRequestedCount = await db.task.count({
    where: accessibleTaskWhere(viewer, { id: { in: requestedIds }, deletedAt: null }),
  });
  if (visibleRequestedCount !== requestedIds.length) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Preserve cross-project (manager-created) edges that the viewer cannot remove.
  // The submitted set is merged with preserved edges so that omitting a
  // read-only edge does not delete it.
  const existingDeps = await db.taskDependency.findMany({
    where: { taskId },
    select: { prerequisiteTaskId: true, prerequisite: { select: { projectId: true } } },
  });
  const legacyTask = await db.task.findUnique({
    where: { id: taskId },
    select: { blockedById: true, blockedBy: { select: { projectId: true } } },
  });

  const preservedIds: string[] = [];
  for (const dep of existingDeps) {
    if (dep.prerequisite.projectId !== task.projectId) {
      preservedIds.push(dep.prerequisiteTaskId);
    }
  }
  // Check legacy blockedById for cross-project
  if (legacyTask?.blockedById && legacyTask.blockedBy && legacyTask.blockedBy.projectId !== task.projectId) {
    if (!preservedIds.includes(legacyTask.blockedById)) {
      preservedIds.push(legacyTask.blockedById);
    }
  }

  // Merge: preserved edges are always kept; submitted edges are added on top
  const submittedSet = new Set(body.prerequisiteTaskIds);
  for (const preservedId of preservedIds) {
    submittedSet.add(preservedId);
  }
  const mergedPrerequisiteTaskIds = [...submittedSet];

  try {
    const result = await setTaskDependencies({
      taskId,
      prerequisiteTaskIds: mergedPrerequisiteTaskIds,
      actorUserId: viewer.id,
    });
    return NextResponse.json({
      added: result.added,
      removed: result.removed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to set dependencies";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
