import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
  accessibleProjectWhere,
  requireViewer,
  viewerExperienceForRole,
  workspaceAccessWhere,
} from "@/lib/auth/permissions";

// The workspaces landing board *is* the home page. Keeping it mounted at
// /workspaces (rather than moving it to "/") preserves its parallel-route
// task interceptors and board chrome scope, so "/" just hands over.
export default async function HomePage() {
  const viewer = await requireViewer();
  const experience = viewerExperienceForRole(viewer.role);
  if (experience.customerSafe) {
    const [workspaces, projects] = await Promise.all([
      db.workspace.findMany({
        where: { AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)] },
        orderBy: { name: "asc" },
        select: { slug: true },
        take: 2,
      }),
      db.project.findMany({
        where: accessibleProjectWhere(viewer, { archivedAt: null, deletedAt: null }),
        orderBy: { name: "asc" },
        select: { slug: true },
        take: 2,
      }),
    ]);
    if (workspaces.length === 1) redirect(`/workspaces/${workspaces[0]!.slug}`);
    if (workspaces.length === 0 && projects.length === 1) redirect(`/projects/${projects[0]!.slug}`);
  }
  redirect("/workspaces");
}
