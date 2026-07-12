// Agent-ack auto-transition endpoint (HOMELAB-44).
// When an agent acknowledges a wake on a task they are assigned to, the
// server moves the task To Do → In Progress. This is the only path
// where an agent advances status without an explicit human action;
// the rule itself lives in lib/workflow.ts (autoTransitionOnAck).

import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { accessibleTaskWhere, getViewer } from "@/lib/auth/permissions";
import {
  autoTransitionOnAck,
  type ActorKind,
  type TaskStatus,
} from "@/lib/workflow";
import { buildTaskAckReady } from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { revalidateTaskShell } from "@/lib/tasks/cache";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const userId = viewer.id;
  const kind: ActorKind = viewer.kind;

  const { id } = await ctx.params;
  const task = await db.task.findFirst({
    where: accessibleTaskWhere(viewer, { id }),
    select: {
      id: true,
      status: true,
      assigneeId: true,
      approvedOn: true,
      projectId: true,
      title: true,
      workItemKey: true,
      project: { select: { slug: true } },
    },
  });
  if (!task) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const next = autoTransitionOnAck({
    status: task.status,
    actor: { id: userId, kind },
    assigneeId: task.assigneeId,
  });

  if (!next) {
    return NextResponse.json({
      taskId: task.id,
      status: task.status as TaskStatus,
      transitioned: false,
    });
  }
  if (!task.approvedOn) {
    return NextResponse.json({
      taskId: task.id,
      status: task.status as TaskStatus,
      transitioned: false,
      reason: "action_plan_not_approved",
    });
  }

  const maxRank = await db.task.aggregate({
    where: { status: next },
    _max: { rank: true },
  });
  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: {
        status: next,
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: new Date(),
      },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId,
        kind: "task.ack.auto",
        payload: JSON.stringify({ from: task.status, to: next }),
      },
    }),
  ]);

  // Surface the auto-transition to any open board (live SSE refresh).
  revalidateTaskShell(task.id);
  publishBoardTouch(task.projectId);

  // Dispatch is downstream of persistence (HOMELAB-44 contract). The
  // notifier swallows transport / config errors and surfaces them via
  // its own observability path — the ack response is unaffected.
  await notifyDispatch(
    buildTaskAckReady(
      {
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        actor: { id: userId, kind },
        task: {
          id: task.id,
          key: task.workItemKey ?? task.id,
          projectKey: task.project.slug,
          title: task.title,
        },
      },
      {
        reason: "auto-transition",
        fromStatus: task.status,
        toStatus: next,
      },
    ),
  );

  return NextResponse.json({
    taskId: task.id,
    status: next,
    transitioned: true,
  });
}
