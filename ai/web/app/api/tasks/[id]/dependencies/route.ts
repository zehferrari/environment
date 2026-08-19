import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getViewer } from "@/lib/auth/permissions";
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
 * Server-side validation via validateTaskDependency for each new edge.
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

  // Verify the task exists and is accessible
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, private: true, projectId: true, deletedAt: true },
  });

  if (!task || task.deletedAt) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const dependencies = await getTaskDependenciesWithDetails(taskId);
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

  // Verify the task exists and is accessible
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, private: true, projectId: true, deletedAt: true },
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

  try {
    const result = await setTaskDependencies({
      taskId,
      prerequisiteTaskIds: body.prerequisiteTaskIds,
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