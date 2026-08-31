import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { createWorkspace } from "@/lib/workspaces/service";
import { uploadAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import {
  accessibleProjectWhere,
  getViewer,
  requireOwner,
} from "@/lib/auth/permissions";
import WorkspacesCreateFab from "@/components/workspaces-create-fab";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

// The one board (+) speed-dial, shared by every board page (landing, a
// workspace board, a project board) so the create/add affordance is identical
// everywhere. Self-contained: it fetches the viewer's accessible projects for
// the epic/task/attachment project picker and owns the workspace-create action,
// so a page only has to drop <BoardCreateFab /> at the end of its tree.
export default async function BoardCreateFab() {
  const viewer = await getViewer();
  if (!viewer) return null;

  const projectRows = await db.project.findMany({
    where: accessibleProjectWhere(viewer, { archivedAt: null, deletedAt: null }),
    orderBy: { name: "asc" },
    select: {
      slug: true,
      name: true,
      workspaces: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { workspace: { select: { name: true } } },
      },
    },
  });
  const projects = projectRows.map((project) => ({
    slug: project.slug,
    name: project.name,
    workspaceName: project.workspaces[0]?.workspace.name ?? "No workspace",
  }));

  async function createWorkspaceAction(formData: FormData) {
    "use server";
    await requireOwner();
    const workspace = await createWorkspace({
      name: String(formData.get("name") ?? ""),
      slug: String(formData.get("slug") ?? ""),
      type: String(formData.get("type") ?? "internal"),
      description: String(formData.get("description") ?? ""),
    });
    revalidatePath("/workspaces");
    redirect(`/workspaces/${workspace.slug}/settings`);
  }

  return (
    <WorkspacesCreateFab
      isOwner={viewer.canAccessOwnerFeatures}
      projects={projects}
      maxAttachmentLabel={formatBytes(attachmentMaxBytes())}
      uploadAttachmentAction={uploadAttachment}
      createWorkspaceAction={createWorkspaceAction}
    />
  );
}
