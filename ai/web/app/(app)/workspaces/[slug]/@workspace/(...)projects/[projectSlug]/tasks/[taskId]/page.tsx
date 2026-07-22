import { notFound } from "next/navigation";
import TaskPage from "@/app/(app)/projects/[slug]/tasks/[taskId]/page";
import WorkspacePane from "@/components/workspace-pane";
import { db } from "@/lib/db";
import {
  accessibleTaskWhere,
  requireViewer,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";
import { normalizeWorkspaceSlug } from "@/lib/workspaces/service";

type TaskSearchParams = {
  chat?: string;
  chatArchive?: string;
  chatRoom?: string;
  tab?: string;
  commit?: string;
  file?: string;
};

// Workspace cards keep their canonical /projects/... task URL. When navigation
// starts inside a workspace board, this root interceptor leaves the workspace
// mounted and renders that project's existing task page beside it.
export default async function WorkspaceProjectTaskPane(props: {
  params: Promise<{ slug: string; projectSlug: string; taskId: string }>;
  searchParams: Promise<TaskSearchParams>;
}) {
  const viewer = await requireViewer();
  const { slug: rawWorkspaceSlug, projectSlug, taskId } = await props.params;
  let workspaceSlug: string;
  try {
    workspaceSlug = normalizeWorkspaceSlug(rawWorkspaceSlug);
  } catch {
    notFound();
  }

  // The intercepted page bypasses the target project's layout, so reproduce
  // its access boundary here and additionally prove the task belongs to this
  // active workspace board. This prevents a crafted soft navigation from
  // displaying a deleted, archived, or unrelated project's task in the pane.
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
              AND: [{ slug: workspaceSlug }, workspaceAccessWhere(viewer)],
            },
          },
        },
      },
    }),
    select: { id: true },
  });
  if (!task) notFound();

  return (
    <WorkspacePane closeHref={`/workspaces/${workspaceSlug}`}>
      <TaskPage
        params={Promise.resolve({ slug: projectSlug, taskId })}
        searchParams={props.searchParams}
        contained
      />
    </WorkspacePane>
  );
}
