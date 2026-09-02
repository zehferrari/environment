import { db } from "@/lib/db";
import { accessibleProjectWhere, getViewer, workspaceAccessWhere } from "@/lib/auth/permissions";
import { listAssignablePrincipals } from "@/lib/principals";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import CreateFab, { type CreateFabProject, type CreateFabWorkspace } from "@/components/create-fab";
import type { AvatarComboboxOption } from "@/components/avatar-combobox";
import BillingCreateDialog from "@/components/billing-create-dialog";
import { listBillingAgents } from "@/lib/billing/run";

// Server wrapper for the one app-wide create FAB: loads the bounded picker data
// (accessible workspaces + projects + assignable principals) once for the whole
// app and hands it to the client component. Epic/task pickers load on demand.
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

export default async function CreateFabServer() {
  const viewer = await getViewer();
  if (!viewer) return null;

  const [workspaceRows, projectRows, principals, billingAgents] = await Promise.all([
    db.workspace.findMany({
      where: { AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)] },
      orderBy: { name: "asc" },
      select: { id: true, slug: true, name: true },
    }),
    db.project.findMany({
      where: accessibleProjectWhere(viewer, { archivedAt: null, deletedAt: null }),
      orderBy: { name: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        repositoryPath: true,
        workspaces: {
          orderBy: { createdAt: "asc" },
          select: { workspace: { select: { id: true, slug: true, name: true } } },
        },
      },
    }),
    viewer.canAccessOwnerFeatures ? listAssignablePrincipals(viewer) : Promise.resolve([]),
    viewer.canAccessOwnerFeatures ? listBillingAgents() : Promise.resolve([]),
  ]);

  const workspaces: CreateFabWorkspace[] = workspaceRows;
  const projects: CreateFabProject[] = projectRows.map((project) => ({
    id: project.id,
    slug: project.slug,
    name: project.name,
    workspaceId: project.workspaces[0]?.workspace.id ?? null,
    workspaceSlug: project.workspaces[0]?.workspace.slug ?? null,
    workspaceName: project.workspaces[0]?.workspace.name ?? "No workspace",
  }));
  const principalOptions: AvatarComboboxOption[] = principals.map((principal) => ({
    value: principal.id,
    label: principal.name,
    actor: {
      id: principal.id,
      username: principal.username,
      kind: principal.kind,
      name: principal.name,
      avatarUpdatedAt: principal.avatarUpdatedAt,
      agent: principal.agentSlug
        ? { slug: principal.agentSlug, name: principal.name, avatar: principal.agentAvatar }
        : null,
    },
  }));

  return (
    <>
      <CreateFab
        isOwner={viewer.canAccessOwnerFeatures}
        workspaces={workspaces}
        projects={projects}
        principals={principalOptions}
        maxAttachmentLabel={formatBytes(attachmentMaxBytes())}
      />
      {viewer.canAccessOwnerFeatures ? (
        <BillingCreateDialog
          projects={projectRows
            .filter((project) => Boolean(project.repositoryPath))
            .map((project) => ({
              id: project.id,
              slug: project.slug,
              name: project.name,
              workspaceSlugs: project.workspaces.map((link) => link.workspace.slug),
            }))}
          agents={billingAgents}
          defaultAgent={billingAgents.find((agent) => agent.role === "monitor")?.slug ?? billingAgents[0]?.slug ?? ""}
        />
      ) : null}
    </>
  );
}
