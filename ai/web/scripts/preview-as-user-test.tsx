import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrismaClient } from "@prisma/client";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const router = {
  back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {},
  prefetch: async () => undefined,
};

function withNavigation(children: React.ReactNode) {
  return (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value="/workspaces">
        <SearchParamsContext.Provider value={new URLSearchParams()}>{children}</SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

const execFileP = promisify(execFile);

async function dbPush(dbUrl: string): Promise<void> {
  await execFileP(
    "pnpm",
    ["prisma", "db", "push", "--skip-generate", "--accept-data-loss", "--schema=prisma/schema.prisma"],
    { env: { ...process.env, DATABASE_URL: dbUrl }, cwd: process.cwd() },
  );
}

async function main(): Promise<void> {
  const temp = await mkdtemp(path.join(tmpdir(), "owner-preview-"));
  const originalDbUrl = process.env.DATABASE_URL;
  const originalSecret = process.env.AUTH_SECRET;
  let prisma: PrismaClient | undefined;

  try {
    const dbUrl = `file:${path.join(temp, "test.db")}`;
    await dbPush(dbUrl);
    process.env.DATABASE_URL = dbUrl;
    process.env.AUTH_SECRET = "preview-as-user-hermetic-test-secret";

    const dbMod = await import("../lib/db");
    const permissions = await import("../lib/auth/permissions");
    const preview = await import("../lib/auth/preview");
    const { default: PreviewBanner } = await import("../components/preview-banner");
    const { default: SidebarNav } = await import("../components/sidebar-nav");
    const { viewerExperienceForRole } = await import("../lib/auth/roles");
    prisma = dbMod.db as PrismaClient;

    const adminRole = await prisma.rolePermission.create({ data: { name: "admin" } });
    const customerRole = await prisma.rolePermission.create({ data: { name: "customer" } });
    const owner = await prisma.user.create({
      data: { username: "preview-owner", email: "preview-owner@example.test", kind: "human", isOwner: true, mustRotatePassword: false },
    });
    const admin = await prisma.user.create({
      data: { username: "preview-admin", email: "preview-admin@example.test", kind: "human", rolePermissionId: adminRole.id, mustRotatePassword: false },
    });
    const customer = await prisma.user.create({
      data: { username: "preview-customer", email: "preview-customer@example.test", kind: "human", rolePermissionId: customerRole.id, mustRotatePassword: false },
    });
    const deactivated = await prisma.user.create({
      data: { username: "preview-off", email: "preview-off@example.test", kind: "human", status: "deactivated", rolePermissionId: customerRole.id, mustRotatePassword: false },
    });
    const agentRow = await prisma.agent.create({ data: { slug: "preview-agent", name: "Preview Agent", role: "coding" } });
    const agent = await prisma.user.create({
      data: { username: "preview-agent", email: "preview-agent@example.test", kind: "agent", agentId: agentRow.id, mustRotatePassword: false },
    });
    const projectA = await prisma.project.create({
      data: {
        slug: "preview-a",
        name: "Preview A",
        members: { create: [{ userId: admin.id }, { userId: customer.id }] },
      },
    });
    const projectB = await prisma.project.create({ data: { slug: "preview-b", name: "Preview B" } });
    const visibleTask = await prisma.task.create({ data: { projectId: projectA.id, title: "Visible task" } });
    await prisma.task.create({ data: { projectId: projectA.id, title: "Private task", private: true } });
    await prisma.task.create({ data: { projectId: projectB.id, title: "Other project task" } });
    await prisma.comment.create({ data: { taskId: visibleTask.id, userId: customer.id, body: "Human update" } });
    await prisma.comment.create({
      data: { taskId: visibleTask.id, userId: agent.id, authorAgentSlug: agentRow.slug, body: "Internal agent update" },
    });
    await prisma.attachment.create({
      data: {
        projectId: projectA.id,
        taskId: visibleTask.id,
        uploaderId: customer.id,
        filename: "human.txt",
        storagePath: "human.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
        sha256: "a".repeat(64),
      },
    });
    await prisma.attachment.create({
      data: {
        projectId: projectA.id,
        taskId: visibleTask.id,
        uploaderId: agent.id,
        filename: "internal.txt",
        storagePath: "internal.txt",
        mimeType: "text/plain",
        sizeBytes: 8,
        sha256: "b".repeat(64),
      },
    });

    const ownerViewer = await permissions.getViewerByUserId(owner.id);
    const adminViewer = await permissions.getViewerByUserId(admin.id);
    const customerViewer = await permissions.getViewerByUserId(customer.id);
    assert.ok(ownerViewer && adminViewer && customerViewer);

    async function visibleSnapshot(viewer: NonNullable<typeof adminViewer>) {
      const [projects, tasks, comments, attachments] = await Promise.all([
        prisma!.project.findMany({ where: permissions.accessibleProjectWhere(viewer), select: { id: true }, orderBy: { id: "asc" } }),
        prisma!.task.findMany({ where: permissions.accessibleTaskWhere(viewer), select: { id: true }, orderBy: { id: "asc" } }),
        prisma!.comment.findMany({ where: permissions.accessibleCommentWhere(viewer), select: { id: true }, orderBy: { id: "asc" } }),
        prisma!.attachment.findMany({ where: permissions.accessibleAttachmentWhere(viewer), select: { id: true }, orderBy: { id: "asc" } }),
      ]);
      return { projects, tasks, comments, attachments };
    }

    const before = {
      users: await prisma.user.findMany({ select: { id: true, status: true, isOwner: true, rolePermissionId: true }, orderBy: { id: "asc" } }),
      members: await prisma.projectMember.findMany({ select: { userId: true, projectId: true }, orderBy: { id: "asc" } }),
      activities: await prisma.activityLog.count(),
      audits: await prisma.accessAuditLog.count(),
      cursors: await prisma.chatReadCursor.count(),
      drafts: await prisma.descriptionDraft.count(),
    };

    for (const realViewer of [adminViewer, customerViewer]) {
      const token = await preview.issueOwnerPreviewToken(owner.id, realViewer.id);
      assert.ok(token, `${realViewer.role} is an eligible preview target`);
      const target = await preview.resolveOwnerPreviewTarget(ownerViewer, token);
      assert.ok(target);
      const effectiveViewer = {
        ...target,
        preview: {
          actor: { id: owner.id, username: owner.username, kind: "human" as const, role: "owner" as const },
          targetUserId: target.id,
        },
      };
      assert.deepEqual(
        { id: effectiveViewer.id, username: effectiveViewer.username, kind: effectiveViewer.kind, role: effectiveViewer.role, agentVisibility: effectiveViewer.agentVisibility, canAccessOwnerFeatures: effectiveViewer.canAccessOwnerFeatures },
        { id: realViewer.id, username: realViewer.username, kind: realViewer.kind, role: realViewer.role, agentVisibility: realViewer.agentVisibility, canAccessOwnerFeatures: realViewer.canAccessOwnerFeatures },
        `${realViewer.role} preview resolves the same centralized Viewer policy as the real session`,
      );
      assert.deepEqual(await visibleSnapshot(effectiveViewer), await visibleSnapshot(realViewer), `${realViewer.role} preview read payloads and counts match the real viewer`);
      const renderShell = (shellViewer: typeof realViewer) => {
        const experience = viewerExperienceForRole(shellViewer.role);
        return renderToStaticMarkup(withNavigation(
          <SidebarNav
            isOwner={shellViewer.canAccessOwnerFeatures}
            canViewAgents={experience.canViewGlobalAgentOperations}
            canManageCustomerAccess={experience.canManageCustomerAccess}
            customerSafe={experience.customerSafe}
            agents={[]}
            projects={[{ slug: "preview-a", name: "Preview A", completion: 50 }]}
            workspaces={[{ slug: "clients", name: "Clients", logoSrc: null, projects: [{ slug: "preview-a", name: "Preview A", completion: 50 }], agentSlugs: [] }]}
            meName={shellViewer.username}
            meKind={shellViewer.kind}
            userId={shellViewer.id}
            userAvatarVersion={null}
            signOutAction={async () => undefined}
          />,
        ));
      };
      assert.equal(renderShell(effectiveViewer), renderShell(realViewer), `${realViewer.role} preview renders the same production sidebar HTML as the real session (banner excluded)`);
    }

    assert.equal(await preview.issueOwnerPreviewToken(admin.id, customer.id), null, "Admin cannot activate preview");
    assert.equal(await preview.issueOwnerPreviewToken(customer.id, admin.id), null, "Customer cannot activate preview");
    assert.equal(await preview.issueOwnerPreviewToken(owner.id, owner.id), null, "Owner is not an eligible target");
    assert.equal(await preview.issueOwnerPreviewToken(owner.id, agent.id), null, "agent is not an eligible target");
    assert.equal(await preview.issueOwnerPreviewToken(owner.id, deactivated.id), null, "deactivated human is not an eligible target");
    const customerToken = await preview.issueOwnerPreviewToken(owner.id, customer.id);
    assert.ok(customerToken);
    assert.equal(await preview.resolveOwnerPreviewTarget(adminViewer, customerToken), null, "signed cookie is bound to the authenticated Owner actor");
    assert.equal(await preview.resolveOwnerPreviewTarget(ownerViewer, `${customerToken.slice(0, -1)}x`), null, "tampered cookie is rejected");

    const after = {
      users: await prisma.user.findMany({ select: { id: true, status: true, isOwner: true, rolePermissionId: true }, orderBy: { id: "asc" } }),
      members: await prisma.projectMember.findMany({ select: { userId: true, projectId: true }, orderBy: { id: "asc" } }),
      activities: await prisma.activityLog.count(),
      audits: await prisma.accessAuditLog.count(),
      cursors: await prisma.chatReadCursor.count(),
      drafts: await prisma.descriptionDraft.count(),
    };
    assert.deepEqual(after, before, "activation and representative preview reads persist no domain, session, cursor, draft, or audit state");

    const banner = renderToStaticMarkup(<PreviewBanner username="preview-customer" role="customer" />);
    assert.match(banner, /data-owner-preview-banner/);
    assert.match(banner, /Previewing as.*@preview-customer.*Customer.*Exit preview/s);

    const [middleware, usersPage, taskPage, epicPage, descriptionField] = await Promise.all([
      readFile(path.join(process.cwd(), "middleware.ts"), "utf8"),
      readFile(path.join(process.cwd(), "app/(app)/system/users/page.tsx"), "utf8"),
      readFile(path.join(process.cwd(), "app/(app)/projects/[slug]/tasks/[taskId]/page.tsx"), "utf8"),
      readFile(path.join(process.cwd(), "app/(app)/projects/[slug]/epics/[epicId]/page.tsx"), "utf8"),
      readFile(path.join(process.cwd(), "components/description-field.tsx"), "utf8"),
    ]);
    assert.match(middleware, /previewRequested[\s\S]*!\["GET", "HEAD", "OPTIONS"\]\.includes\(req\.method\)[\s\S]*status: 403/, "preview cookie fences every unsafe browser method before route/server-action execution");
    assert.match(usersPage, /isOwner && user\.status === "active"[\s\S]*data-owner-preview-trigger/, "only the normal Owner user-management DOM renders activation controls");
    assert.match(taskPage, /!viewer\.preview && selectedTab === "Action Plan"/, "Task navigation does not update read cursors in preview");
    assert.match(epicPage, /!viewer\.preview && currentUserId && selectedTab === "Action Plan"/, "Epic navigation does not update read cursors in preview");
    assert.match(descriptionField, /!id \|\| !scope \|\| readOnlyPreview/, "preview disables description-draft heartbeat writes");

    console.log("preview-as-user-test: ok");
  } finally {
    if (prisma) await prisma.$disconnect();
    if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDbUrl;
    if (originalSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalSecret;
    await rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
