import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { describeActivity } from "@/lib/activity";
import {
  accessibleActivityWhere,
  accessibleTaskWhere,
  getViewer,
} from "@/lib/auth/permissions";
import {
  getActorVisibility,
  visibleActivityRows,
  visibleActivityWhere,
} from "@/lib/users/actor-visibility";

export const dynamic = "force-dynamic";

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

// Live agent snapshot — same loopback source the sidebar and board read.
async function readAgentStates(): Promise<{ slug: string; busy: boolean }[]> {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return [];
    const snapshot = (await res.json()) as {
      agents?: Record<string, { busy_state?: { is_busy?: boolean } | null }>;
    };
    return Object.entries(snapshot.agents ?? {}).map(([slug, agent]) => ({
      slug,
      busy: Boolean(agent?.busy_state?.is_busy),
    }));
  } catch {
    return [];
  }
}

// ENV-110 Command Deck rail: one lean payload for the 5xl widget rail —
// agent states, board queue depth, and the latest visible activity.
export async function GET() {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const activityWhere = await accessibleActivityWhere(viewer);
  const [agents, queueGroups, activity, actorVisibility] = await Promise.all([
    readAgentStates(),
    db.task.groupBy({
      by: ["status"],
      where: accessibleTaskWhere(viewer, { deletedAt: null, parentTaskId: null }),
      _count: { _all: true },
    }),
    db.activityLog.findMany({
      where: { AND: [activityWhere, visibleActivityWhere(viewer)] },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: {
        user: { select: actorSelect },
        task: { select: { title: true } },
      },
    }),
    getActorVisibility(viewer),
  ]);

  return NextResponse.json({
    agents,
    queues: queueGroups.map((group) => ({ status: group.status, count: group._count._all })),
    activity: visibleActivityRows(activity, actorVisibility).map((row) => ({
      id: row.id,
      at: row.createdAt.toISOString(),
      label: describeActivity({
        kind: row.kind,
        payload: row.payload,
        actorName: row.user?.username ?? null,
        taskTitle: row.task?.title ?? null,
      }),
    })),
  });
}
