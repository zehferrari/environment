import { notFound } from "next/navigation";
import TaskPage from "@/app/(app)/projects/[slug]/tasks/[taskId]/page";
import WorkspacePane from "@/components/workspace-pane";
import { db } from "@/lib/db";
import {
  accessibleTaskWhere,
  requireViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";

type TaskSearchParams = {
  chat?: string;
  chatArchive?: string;
  chatRoom?: string;
  tab?: string;
  commit?: string;
  file?: string;
};

// Landing-board cards keep their canonical /projects/... task URL. When
// navigation starts on /workspaces, this root interceptor leaves the landing
// board mounted and renders that project's existing task page beside it.
export default async function LandingProjectTaskPane(props: {
  params: Promise<{ projectSlug: string; taskId: string }>;
  searchParams: Promise<TaskSearchParams>;
}) {
  const viewer = await requireViewer();
  const { projectSlug, taskId } = await props.params;

  // The intercepted page bypasses the target project's layout, so reproduce
  // its access boundary here and additionally prove the task's project belongs
  // to at least one accessible active workspace — the set the landing board
  // displays. This prevents a crafted soft navigation from displaying a
  // deleted, archived, or unrelated project's task in the pane.
  const task = await db.task.findFirst({
    where: accessibleTaskWhere(viewer, {
      id: taskId,
      archivedAt: null,
      deletedAt: null,
      project: {
        slug: projectSlug,
        archivedAt: null,
        deletedAt: null,
        workspaces: {
          some: {
            workspace: {
              AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)],
            },
          },
        },
      },
    }),
    select: { id: true },
  });
  if (!task) notFound();

  return (
    <WorkspacePane closeHref="/workspaces">
      <TaskPage
        params={Promise.resolve({ slug: projectSlug, taskId })}
        searchParams={props.searchParams}
        contained
      />
    </WorkspacePane>
  );
}
