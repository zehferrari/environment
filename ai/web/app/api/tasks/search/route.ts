import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getViewer, accessibleTaskWhere } from "@/lib/auth/permissions";

/**
 * ENV-159 Step 8: Task search endpoint for the multi-prerequisite editor.
 *
 * GET /api/tasks/search?q=…&exclude=<taskId>
 *
 * Searches by title or workItemKey, scoped to tasks the viewer can access
 * via accessibleTaskWhere. Excludes the calling task and already-deleted tasks.
 * Returns { results: [{ id, title, workItemKey, status, project: { name, slug } }] }
 */

export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  const exclude = searchParams.get("exclude");

  if (q.length < 1) {
    return NextResponse.json({ results: [] });
  }

  const where = accessibleTaskWhere(viewer, {
    deletedAt: null,
    ...(exclude ? { id: { not: exclude } } : {}),
    OR: [
      { title: { contains: q, mode: "insensitive" } },
      { workItemKey: { contains: q, mode: "insensitive" } },
    ],
  });

  const tasks = await db.task.findMany({
    where,
    select: {
      id: true,
      title: true,
      workItemKey: true,
      status: true,
      project: { select: { name: true, slug: true } },
    },
    take: 20,
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({
    results: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      workItemKey: t.workItemKey,
      status: t.status,
      project: t.project,
    })),
  });
}