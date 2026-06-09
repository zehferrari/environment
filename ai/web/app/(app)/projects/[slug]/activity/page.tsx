import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { describeActivity } from "@/lib/activity";
import ActivityAgenda from "@/components/activity-agenda";

export const dynamic = "force-dynamic";

const ACTIVITY_FEED_LIMIT = 50;
const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  if (!project) notFound();

  const activity = await db.activityLog.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: ACTIVITY_FEED_LIMIT,
    include: {
      user: { select: actorSelect },
      task: { select: { title: true } },
    },
  });

  const feed = activity.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    label: describeActivity({
      kind: row.kind,
      payload: row.payload,
      actorName: row.user?.username ?? null,
      taskTitle: row.task?.title ?? null,
    }),
    actor: row.user
      ? {
          id: row.user.id,
          username: row.user.username,
          kind: row.user.kind,
          name: row.user.name,
          avatarUpdatedAt: row.user.avatarUpdatedAt?.toISOString() ?? null,
          agent: row.user.agent,
        }
      : null,
  }));

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">
        Recent activity
      </h2>
      <ActivityAgenda feed={feed} />
    </div>
  );
}
