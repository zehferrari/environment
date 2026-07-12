import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { renderFullMarkdown } from "@/lib/markdown";
import { readRepoReadme } from "@/lib/projects/repo-readme";
import { describeActivity } from "@/lib/activity";
import ActivityAgenda from "@/components/activity-agenda";
import {
  accessibleActivityWhere,
  accessibleProjectWhere,
  requireViewer,
} from "@/lib/auth/permissions";
import { getActorVisibility, visibleActivityRows, visibleActivityWhere } from "@/lib/users/actor-visibility";

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

// Project "Summary" tab — renders the README.md at the root of the project's
// configured repository folder (2/3 width) alongside a sticky, scrollable recent
// activity sidebar (1/3 width). The tab is only shown (see project-tabs.tsx) when
// that README exists; direct hits with no repo/README 404.
export default async function ProjectSummaryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const viewer = await requireViewer();
  const project = await db.project.findFirst({
    where: accessibleProjectWhere(viewer, { slug }),
    select: { id: true, repositoryPath: true, deletedAt: true },
  });
  if (!project || project.deletedAt) notFound();

  const readme = await readRepoReadme(project.repositoryPath);
  if (readme === null) notFound();

  const activityWhere = await accessibleActivityWhere(viewer, { projectId: project.id });
  const [activity, actorVisibility] = await Promise.all([
    db.activityLog.findMany({
      where: { AND: [activityWhere, visibleActivityWhere(viewer)] },
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_FEED_LIMIT,
      include: {
        user: { select: actorSelect },
        task: { select: { title: true } },
      },
    }),
    getActorVisibility(viewer),
  ]);

  const feed = visibleActivityRows(activity, actorVisibility).map((row) => ({
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
    <div className="grid gap-6 lg:grid-cols-3">
      <section className="rounded-panel border border-line bg-panel p-6 shadow-sm lg:col-span-2">
        <div className="md" dangerouslySetInnerHTML={renderFullMarkdown(readme)} />
      </section>
      <aside className="lg:col-span-1">
        <div className="lg:sticky lg:top-card lg:h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pr-1">
          <h2 className="mb-3 text-caption uppercase tracking-wider text-text-muted">
            Recent activity
          </h2>
          <ActivityAgenda feed={feed} />
        </div>
      </aside>
    </div>
  );
}
