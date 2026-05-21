// Agent-ack auto-transition endpoint (HOMELAB-44).
// When an agent acknowledges a wake on a task they are assigned to, the
// server moves the task To Do → In Progress. This is the only path
// where an agent advances status without an explicit human action;
// the rule itself lives in lib/workflow.ts (autoTransitionOnAck).

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  autoTransitionOnAck,
  type ActorKind,
  type TaskStatus,
} from "@/lib/workflow";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";

  const { id } = await ctx.params;
  const task = await db.task.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      assigneeId: true,
      projectId: true,
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

  const maxRank = await db.task.aggregate({
    where: { status: next },
    _max: { rank: true },
  });
  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: { status: next, rank: (maxRank._max.rank ?? 0) + 1 },
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

  return NextResponse.json({
    taskId: task.id,
    status: next,
    transitioned: true,
  });
}
