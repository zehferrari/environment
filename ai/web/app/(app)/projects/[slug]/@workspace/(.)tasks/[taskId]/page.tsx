import TaskPage from "../../../tasks/[taskId]/page";
import WorkspacePane from "@/components/workspace-pane";

// ENV-110 split workspace: soft-navigating to a task from inside the project
// intercepts the route here so the board stays mounted in the children slot.
// The pane reuses the full task detail page — no duplicated detail UI.
export default async function WorkspaceTaskPage(props: {
  params: Promise<{ slug: string; taskId: string }>;
  searchParams: Promise<{ chat?: string; chatArchive?: string; chatRoom?: string; tab?: string; commit?: string; file?: string }>;
}) {
  const { slug } = await props.params;
  return (
    <WorkspacePane closeHref={`/projects/${slug}`}>
      <TaskPage params={props.params} searchParams={props.searchParams} contained />
    </WorkspacePane>
  );
}
