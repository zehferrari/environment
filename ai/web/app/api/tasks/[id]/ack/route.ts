// Agent-ack endpoint (HOMELAB-44, reduced by the 2026-07 workflow overhaul).
// An ack is now a liveness ping only: it never changes task status. The old
// To Do → In Progress auto-transition bypassed the per-project WIP and
// branch-clash guards that gate the workflow endpoint's `start` action, so
// status changes are exclusively the workflow endpoint's job now.

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accessibleTaskWhere, getViewer } from "@/lib/auth/permissions";
import type { TaskStatus } from "@/lib/workflow";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const task = await db.task.findFirst({
    where: accessibleTaskWhere(viewer, { id }),
    select: { id: true, status: true },
  });
  if (!task) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    taskId: task.id,
    status: task.status as TaskStatus,
    transitioned: false,
    guidance:
      "Ack is a liveness ping only and never changes task status. To begin work, call the task workflow endpoint with action=start from a workflow turn (or POST /api/agent/tasks/<taskId>/request-workflow-turn with your PM bearer to receive one).",
  });
}
