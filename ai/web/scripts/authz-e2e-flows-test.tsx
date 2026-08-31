// ENV-169 — End-to-end role journeys for the Client UI Epic's task 9 (AC10):
// the invitation/edit flow, Admin guardrails, Customer isolation, Owner
// preview mode, and revocation while a session is active.
//
// Real server code only, per the authz-scenario-harness conventions:
//   * Viewers resolve through getViewerByUserId — role/status/agentVisibility
//     always derive from the seeded rows, never from literals.
//   * The invitation story drives the transactional access-management cores
//     (inviteHumanUserCore / updateHumanAccessCore / setHumanUserRoleCore)
//     plus the real setPasswordFromToken server action for activation.
//   * The preview journey runs the real issueOwnerPreviewToken /
//     resolveOwnerPreviewTarget cores and proves the preview lens equals the
//     customer's real session across every read surface and the production
//     sidebar markup.
//   * The revocation journey mints a genuine Auth.js session JWT whose
//     identity survives the revocation at the middleware boundary while the
//     viewer-policy stream pushes the new epoch and every authorized surface
//     denies; a re-grant closes the round trip.
//   * UI legs render the production SidebarNav and PreviewBanner components.
//     No policy is re-implemented here.

import assert from "node:assert/strict";

import { agentIdentifierSentinels, setupAuthzScenario } from "./lib/authz-scenario-harness";

type SseFrame = { event: string; data: string };

async function waitFor(cond: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  while (!cond()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`authz-e2e-flows-test: timeout waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type PolicyStreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: Uint8Array | undefined };

interface PolicyStreamReader {
  read(): Promise<PolicyStreamReadResult>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

async function drainStream(
  reader: PolicyStreamReader,
  frames: SseFrame[],
  onDone?: () => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const frame: SseFrame = { event: "", data: "" };
        for (const rawLine of block.split("\n")) {
          const line = rawLine.replace(/\r$/, "");
          if (line.startsWith("event:")) frame.event = line.slice(6).trim();
          else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
        }
        if (frame.event !== "") frames.push(frame);
        separator = buffer.indexOf("\n\n");
      }
    }
  } finally {
    onDone?.();
  }
}

async function assertRejected(
  promise: Promise<unknown>,
  messagePart: string,
  label: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error, `${label}: rejection must be an Error`);
    assert.ok(
      error.message.includes(messagePart),
      `${label}: expected rejection message to include "${messagePart}", got: ${error.message}`,
    );
    return true;
  });
}

async function main(): Promise<void> {
  const s = await setupAuthzScenario();
  const { db, world, modules } = s;
  const { permissions, accessManagement, workspacesService, publishingService, actorVisibility, redactAgents } =
    modules;
  try {
    // Late imports: every production module must load after the sandbox has
    // repointed DATABASE_URL (harness contract).
    const preview = await import("../lib/auth/preview");
    const userActions = await import("../lib/users/actions");
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AppRouterContext } = await import(
      "next/dist/shared/lib/app-router-context.shared-runtime"
    );
    const { PathnameContext, SearchParamsContext } = await import(
      "next/dist/shared/lib/hooks-client-context.shared-runtime"
    );
    const { default: SidebarNav } = await import("../components/sidebar-nav");
    const { default: PreviewBanner } = await import("../components/preview-banner");

    (globalThis as typeof globalThis & { React: unknown }).React = React;
    const router = {
      back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {},
      prefetch: async () => undefined,
    };
    const withNavigation = (element: import("react").ReactNode) => (
      <AppRouterContext.Provider value={router as never}>
        <PathnameContext.Provider value="/workspaces">
          <SearchParamsContext.Provider value={new URLSearchParams()}>{element}</SearchParamsContext.Provider>
        </PathnameContext.Provider>
      </AppRouterContext.Provider>
    );

    const ownerViewer = await s.mustViewer(world.owner.id);
    const adminAViewer = await s.mustViewer(world.adminA.id);
    const customerAViewer = await s.mustViewer(world.customerA.id);
    const projectA = world.projects.projectA;
    const projectB = world.projects.projectB;

    const sentinels = agentIdentifierSentinels(world);
    const sweep = (payload: unknown, label: string): void => {
      const json = JSON.stringify(payload) ?? "null";
      for (const forbidden of sentinels) {
        assert.equal(json.includes(forbidden), false, `${label} must not contain "${forbidden}"`);
      }
    };
    const wsSlugs = async (viewer: unknown) =>
      (await workspacesService.listWorkspaces(false, viewer as never))
        .map((w: { slug: string }) => w.slug)
        .sort();
    const taskCount = async (viewer: unknown) =>
      db.task.count({
        where: { AND: [permissions.accessibleTaskWhere(viewer as never, { deletedAt: null })] },
      });

    // ================================================================ J1 ==
    // Invitation journey: invite → token material → activation through the
    // real server action → owner edits the grant set → promote → demote, with
    // the full audit trail.
    const invite = await accessManagement.inviteHumanUserCore(ownerViewer, {
      username: "az-e2e-invited",
      email: "az-e2e-invited@example.invalid",
      displayName: "E2E Invited",
      role: "customer",
      projectIds: [projectA.id],
    });
    assert.ok(invite.token.length > 20, "J1: invitation issues a real token");
    const inviteeRow = await db.user.findUniqueOrThrow({
      where: { id: invite.userId },
      select: { status: true, rolePermission: { select: { name: true } } },
    });
    assert.equal(inviteeRow.status, "invited", "J1: invited user starts in the invited state");
    assert.equal(inviteeRow.rolePermission?.name, "customer", "J1: invitation carries the requested role");
    const tokenHash = accessManagement.inviteTokenHash(invite.token);
    const inviteTokenRow = await db.passwordResetToken.findUniqueOrThrow({ where: { tokenHash } });
    assert.equal(inviteTokenRow.userId, invite.userId, "J1: token row belongs to the invitee");
    assert.equal(inviteTokenRow.usedAt, null, "J1: token is unused");
    assert.ok(inviteTokenRow.expiresAt.getTime() > Date.now(), "J1: token is unexpired");
    const inviteAudit = await db.accessAuditLog.findFirstOrThrow({
      where: { affectedUser: { id: invite.userId } },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(inviteAudit.actorUserId, world.owner.id, "J1: invitation audited with the Owner actor");
    assert.equal(inviteAudit.action, "grant", "J1: invitation recorded as a grant");
    assert.deepEqual(JSON.parse(inviteAudit.newProjectIds), [projectA.id], "J1: granted scope recorded");

    // Activation through the real server action (success redirects to login).
    const activationForm = new FormData();
    activationForm.set("token", invite.token);
    activationForm.set("password", "Az-E2e-Invited-Passphrase-1");
    activationForm.set("passwordConfirmation", "Az-E2e-Invited-Passphrase-1");
    let activationRedirected = false;
    try {
      await userActions.setPasswordFromToken(activationForm);
    } catch {
      activationRedirected = true; // expected: NEXT_REDIRECT to /login?invited=1
    }
    assert.ok(activationRedirected, "J1: activation completes with the login redirect");
    const activatedRow = await db.user.findUniqueOrThrow({
      where: { id: invite.userId },
      select: { status: true, mustRotatePassword: true },
    });
    assert.equal(activatedRow.status, "active", "J1: first owner-set password activates the invitation");
    assert.equal(activatedRow.mustRotatePassword, false, "J1: activation clears the rotation flag");
    const spentTokenRow = await db.passwordResetToken.findUniqueOrThrow({ where: { tokenHash } });
    assert.notEqual(spentTokenRow.usedAt, null, "J1: activation consumes the invitation token");
    const inviteeViewer = await s.mustViewer(invite.userId);
    assert.equal(
      await permissions.canAccessProject(inviteeViewer, { id: projectA.id }),
      true,
      "J1: activated invitee reaches the granted project",
    );
    assert.equal(
      await permissions.canAccessProject(inviteeViewer, { id: projectB.id }),
      false,
      "J1: activated invitee cannot reach an ungranted project",
    );

    // Owner edit: full-set replace adds Project B while keeping Project A.
    const edit = await accessManagement.updateHumanAccessCore(ownerViewer, {
      userId: invite.userId,
      projectIds: [projectA.id, projectB.id],
    });
    assert.equal(edit.changed, true, "J1: owner edit changes the grant set");
    assert.equal(
      await permissions.canAccessProject(await s.mustViewer(invite.userId), { id: projectB.id }),
      true,
      "J1: edited scope takes effect on the next request",
    );
    // Promote to Admin (owner-only role machinery), then demote back.
    const promote = await accessManagement.updateHumanAccessCore(ownerViewer, {
      userId: invite.userId,
      projectIds: [projectA.id, projectB.id],
      role: "admin",
    });
    assert.equal(promote.changed, true, "J1: owner promotes the invitee");
    const promotedRow = await db.user.findUniqueOrThrow({
      where: { id: invite.userId },
      select: { rolePermission: { select: { name: true } } },
    });
    assert.equal(promotedRow.rolePermission?.name, "admin", "J1: promotion lands in the role row");
    const demote = await accessManagement.setHumanUserRoleCore(ownerViewer, {
      userId: invite.userId,
      role: "customer",
    });
    assert.equal(demote.changed, true, "J1: owner demotes the invitee back");
    const demotedRow = await db.user.findUniqueOrThrow({
      where: { id: invite.userId },
      select: { rolePermission: { select: { name: true } } },
    });
    assert.equal(demotedRow.rolePermission?.name, "customer", "J1: demotion lands in the role row");
    const journeyAudits = await db.accessAuditLog.findMany({
      where: { affectedUser: { id: invite.userId } },
      orderBy: { createdAt: "asc" },
    });
    assert.ok(journeyAudits.length >= 4, "J1: grant/edit/promote/demote all leave audit rows");
    const roleAuditRows = journeyAudits.filter(
      (a) => a.newRole === "admin" || (a.oldRole === "admin" && a.newRole === "customer"),
    );
    assert.ok(roleAuditRows.length >= 2, "J1: role changes are audited");

    // ================================================================ J2 ==
    // Admin guardrail journey: every forbidden edit is rejected server-side
    // and leaves no user, membership, or audit state behind.
    const before = {
      users: await db.user.count(),
      members: await db.projectMember.count(),
      audits: await db.accessAuditLog.count(),
    };
    await assertRejected(
      accessManagement.updateHumanAccessCore(adminAViewer, {
        userId: world.adminA.id,
        projectIds: [projectA.id],
      }),
      "An Admin cannot edit their own access.",
      "J2: Admin cannot edit their own access",
    );
    await assertRejected(
      accessManagement.updateHumanAccessCore(adminAViewer, {
        userId: world.adminB.id,
        projectIds: [projectA.id],
      }),
      "An Admin can only manage Customer access.",
      "J2: Admin cannot edit another Admin",
    );
    await assertRejected(
      accessManagement.updateHumanAccessCore(adminAViewer, {
        userId: world.owner.id,
        projectIds: [projectA.id],
      }),
      "The Mission Control owner has access to every project.",
      "J2: Admin cannot edit the Owner",
    );
    await assertRejected(
      accessManagement.updateHumanAccessCore(adminAViewer, {
        userId: world.customerBare.id,
        projectIds: [projectB.id],
      }),
      "Access can only be granted or revoked within your own project scope.",
      "J2: Admin cannot grant an out-of-scope project",
    );
    await assertRejected(
      accessManagement.setHumanUserRoleCore(adminAViewer, {
        userId: world.customerA.id,
        role: "admin",
      }),
      "Only the Mission Control owner can promote or demote.",
      "J2: Admin cannot promote or demote",
    );
    assert.equal(await db.user.count(), before.users, "J2: rejected edits create no users");
    assert.equal(await db.projectMember.count(), before.members, "J2: rejected edits change no grants");
    assert.equal(await db.accessAuditLog.count(), before.audits, "J2: rejected edits write no audit rows");
    // Positive control: the same Admin manages a Customer inside their scope.
    const scoped = await accessManagement.updateHumanAccessCore(adminAViewer, {
      userId: world.customerBare.id,
      projectIds: [projectA.id],
    });
    assert.equal(scoped.changed, true, "J2: in-scope Admin edit succeeds");
    assert.deepEqual(
      await wsSlugs(await s.mustViewer(world.customerBare.id)),
      ["az-workspace-a"],
      "J2: the edited Customer lands in the granted workspace",
    );
    const scopedAudit = await db.accessAuditLog.findFirstOrThrow({
      where: { affectedUser: { id: world.customerBare.id } },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(scopedAudit.actorUserId, world.adminA.id, "J2: in-scope edit is audited with the Admin actor");

    // ================================================================ J3 ==
    // Customer isolation journey: one live session walks the permitted
    // surfaces and finds zero agent identifiers anywhere.
    const anonBoundary = await s.callMiddleware(await s.requestAs(null, "http://127.0.0.1:3000/workspaces"));
    assert.equal(anonBoundary.status, 307, "J3: anonymous request redirects to login");
    assert.match(anonBoundary.location ?? "", /\/login/, "J3: anonymous redirect leaks nothing");
    const sessionCookieStr = await s.sessionCookie(world.customerA.id);
    const customerBoundary = await s.callMiddleware(
      await s.requestAs(null, "http://127.0.0.1:3000/workspaces", {
        headers: { cookie: sessionCookieStr },
      }),
    );
    assert.notEqual(customerBoundary.status, 307, "J3: the customer session passes the boundary");

    const customerWorkspaces = (await workspacesService.listWorkspaces(
      false,
      customerAViewer as never,
    )) as Array<{ slug: string; agentSlugs?: string[] }>;
    assert.deepEqual(
      customerWorkspaces.map((w) => w.slug).sort(),
      ["az-workspace-a"],
      "J3: customer lands in their permitted workspace only",
    );
    for (const workspace of customerWorkspaces) {
      assert.deepEqual(workspace.agentSlugs ?? [], [], "J3: workspace page data carries no agent slugs");
    }
    sweep(customerWorkspaces, "J3 customer workspace payload");

    assert.equal(await permissions.canAccessProject(customerAViewer, { id: projectA.id }), true,
      "J3: permitted project reachable");
    assert.equal(await permissions.canAccessProject(customerAViewer, { id: projectB.id }), false,
      "J3: out-of-scope project unreachable");
    assert.equal(await permissions.canAccessEpic(customerAViewer, world.epics.epicA.id), true,
      "J3: permitted Epic reachable");
    assert.equal(await permissions.canAccessEpic(customerAViewer, world.epics.privateEpicA.id), false,
      "J3: private Epic unreachable");
    assert.equal(await taskCount(customerAViewer), 25, "J3: customer sees exactly the permitted public work items");

    // Sweeps run over the page's own customer projection (author projector +
    // free-text agent redactor), never raw rows — the human-authored comment
    // that names an agent is visible, but its body is redacted on serialization.
    const visibility = await actorVisibility.getActorVisibility(customerAViewer);
    const redactBody = redactAgents.buildAgentRedactor(visibility.agentIdentities, visibility.maskAgents);
    const visibleComments = await db.comment.findMany({
      where: permissions.accessibleCommentWhere(customerAViewer as never, { taskId: world.tasks.taskA.id }),
      include: { user: true },
    });
    assert.deepEqual(
      visibleComments.map((c) => c.id).sort(),
      [world.comments.humanOnTaskA.id, world.comments.humanNamingAgent.id].sort(),
      "J3: customer comments keep human rows only",
    );
    const projectedComments = visibleComments.map((c) => ({
      id: c.id,
      body: redactBody(c.body),
      author: actorVisibility.serializeVisibleActor(c.user, visibility),
    }));
    sweep(projectedComments, "J3 customer comment payload (projected author + redacted body)");
    const mentionRow = projectedComments.find((c) => c.id === world.comments.humanNamingAgent.id);
    assert.ok(mentionRow, "J3: humanNamingAgent row present for redaction check");
    assert.equal(
      mentionRow.body.includes("az-agent-a"),
      false,
      "J3: redacted body carries no real agent slug",
    );
    const visibleAttachments = await db.attachment.findMany({
      where: permissions.accessibleAttachmentWhere(customerAViewer as never, {}),
      select: { id: true, filename: true, uploaderId: true },
    });
    assert.deepEqual(
      visibleAttachments.map((a) => a.id),
      [world.attachments.humanOnTaskA.id],
      "J3: customer attachment metadata keeps the human upload only",
    );
    sweep(visibleAttachments, "J3 customer attachment payload");

    const published = await publishingService.listPublishedForProject(customerAViewer, projectA.id);
    assert.equal(published.length, 1, "J3: the customer-safe published item is visible");
    assert.equal(published[0]?.title, "AZ Published Update", "J3: published item is the seeded one");
    sweep(published, "J3 published payload");
    await assert.rejects(
      publishingService.listPublishableSources(customerAViewer, world.tasks.taskA.id),
      (error: unknown) => error instanceof Error,
      "J3: customer cannot reach the internal compose surface",
    );

    const customerSidebar = renderToStaticMarkup(
      withNavigation(
        <SidebarNav
          isOwner={false}
          canViewAgents={false}
          canManageCustomerAccess={false}
          customerSafe={true}
          agents={[]}
          projects={[]}
          workspaces={[{
            slug: "az-workspace-a",
            name: "AZ Workspace A",
            logoSrc: null,
            projects: [{ slug: "az-project-a", name: "AZ Project A", completion: 50 }],
            agentSlugs: [],
          }]}
          meName={world.customerA.username}
          meKind="human"
          userId={world.customerA.id}
          userAvatarVersion={null}
          signOutAction={async () => undefined}
        />,
      ),
    );
    assert.match(customerSidebar, /AZ Workspace A/, "J3: customer navigation renders the permitted workspace");
    assert.doesNotMatch(
      customerSidebar,
      /Agents|Mission Control|Unread messages|Internal Agent|Customer access|Logs &amp; Activity|Settings/,
      "J3: customer navigation contains zero agent or internal controls",
    );

    // ================================================================ J4 ==
    // Owner preview journey: the preview lens is the customer's real session.
    const previewToken = await preview.issueOwnerPreviewToken(world.owner.id, world.customerA.id);
    assert.ok(previewToken, "J4: Owner can issue a preview token for an active Customer");
    assert.equal(await preview.issueOwnerPreviewToken(world.adminA.id, world.customerA.id), null,
      "J4: Admin cannot activate preview");
    assert.equal(await preview.issueOwnerPreviewToken(world.customerA.id, world.adminA.id), null,
      "J4: Customer cannot activate preview");
    assert.equal(await preview.issueOwnerPreviewToken(world.owner.id, world.owner.id), null,
      "J4: the Owner is not an eligible target");
    assert.equal(await preview.issueOwnerPreviewToken(world.owner.id, world.agents.agentA.userId), null,
      "J4: agents are not eligible targets");
    const previewTarget = await preview.resolveOwnerPreviewTarget(ownerViewer, previewToken);
    assert.ok(previewTarget, "J4: Owner-bound token resolves the Customer target");
    assert.equal(await preview.resolveOwnerPreviewTarget(adminAViewer, previewToken), null,
      "J4: preview token is bound to the Owner actor");
    assert.equal(
      await preview.resolveOwnerPreviewTarget(ownerViewer, `${previewToken.slice(0, -1)}x`),
      null,
      "J4: tampered preview token is rejected",
    );
    const effectiveViewer = {
      ...previewTarget,
      preview: {
        actor: {
          id: world.owner.id,
          username: world.owner.username,
          kind: "human" as const,
          role: "owner" as const,
        },
        targetUserId: previewTarget.id,
      },
    };
    const visibleIds = async (viewer: unknown) => ({
      projects: (
        await db.project.findMany({
          where: permissions.accessibleProjectWhere(viewer as never),
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((r) => r.id),
      tasks: (
        await db.task.findMany({
          where: permissions.accessibleTaskWhere(viewer as never, { deletedAt: null }),
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((r) => r.id),
      comments: (
        await db.comment.findMany({
          where: permissions.accessibleCommentWhere(viewer as never),
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((r) => r.id),
      attachments: (
        await db.attachment.findMany({
          where: permissions.accessibleAttachmentWhere(viewer as never, {}),
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((r) => r.id),
    });
    assert.deepEqual(
      await visibleIds(effectiveViewer),
      await visibleIds(customerAViewer),
      "J4: preview lens equals the Customer session across every read surface",
    );
    type ShellViewer = {
      canAccessOwnerFeatures: boolean;
      role: Parameters<typeof modules.roles.viewerExperienceForRole>[0];
      username: string;
      id: string;
      kind: "human" | "agent";
    };
    const shellFor = (shellViewer: ShellViewer) => {
      const experience = modules.roles.viewerExperienceForRole(shellViewer.role);
      return renderToStaticMarkup(
        withNavigation(
          <SidebarNav
            isOwner={shellViewer.canAccessOwnerFeatures}
            canViewAgents={experience.canViewGlobalAgentOperations}
            canManageCustomerAccess={experience.canManageCustomerAccess}
            customerSafe={experience.customerSafe}
            agents={[]}
            projects={[{ slug: "az-project-a", name: "AZ Project A", completion: 50 }]}
            workspaces={[{
              slug: "az-workspace-a",
              name: "AZ Workspace A",
              logoSrc: null,
              projects: [{ slug: "az-project-a", name: "AZ Project A", completion: 50 }],
              agentSlugs: [],
            }]}
            meName={shellViewer.username}
            meKind={shellViewer.kind}
            userId={shellViewer.id}
            userAvatarVersion={null}
            signOutAction={async () => undefined}
          />,
        ),
      );
    };
    assert.equal(
      shellFor(effectiveViewer),
      shellFor(customerAViewer),
      "J4: preview renders the Customer production sidebar (banner excluded)",
    );
    const banner = renderToStaticMarkup(
      <PreviewBanner username={world.customerA.username} role="customer" />,
    );
    assert.match(banner, /data-owner-preview-banner/, "J4: preview banner marks the DOM");
    assert.match(
      banner,
      new RegExp(`Previewing as.*@${world.customerA.username}.*Customer.*Exit preview`),
      "J4: preview banner names the target and offers exit",
    );

    // ================================================================ J5 ==
    // Revocation while the session is active: the same JWT keeps passing the
    // identity boundary, the policy stream pushes the new epoch to the live
    // session, every authorized surface denies, and a re-grant restores it.
    const readEpoch = async (): Promise<number | null> =>
      (
        await db.user.findUnique({
          where: { id: world.customerA.id },
          select: { policyVersion: true },
        })
      )?.policyVersion ?? null;
    const epochBefore = await readEpoch();
    if (epochBefore === null) {
      throw new Error("J5: policy epoch row missing before the mid-session revocation leg");
    }
    const frames: SseFrame[] = [];
    let streamDone = false;
    const policyStream = modules.viewerPolicyStream.createViewerPolicyStream({
      viewerId: world.customerA.id,
      initialEpoch: epochBefore,
      readEpoch,
      resolveViewer: () => permissions.getViewerByUserId(world.customerA.id),
      heartbeatMs: 60,
    });
    const policyReader = policyStream.getReader();
    void drainStream(policyReader, frames, () => {
      streamDone = true;
    });
    await waitFor(() => frames.length > 0, 5000, "J5: policy stream connect epoch");
    assert.equal(frames[0]?.event, "policy-version", "J5: stream emits the connect epoch first");
    assert.match(frames[0]?.data ?? "", /^\d+$/, "J5: connect payload is the epoch integer only");

    assert.equal(await permissions.canAccessProject(customerAViewer, { id: projectA.id }), true,
      "J5: pre-revoke session is authorized");
    assert.equal(await taskCount(customerAViewer), 25, "J5: pre-revoke scope is the permitted set");

    await accessManagement.updateHumanAccessCore(ownerViewer, {
      userId: world.customerA.id,
      projectIds: [],
    });
    await waitFor(
      () => frames.some((f) => f.event === "policy-changed"),
      5000,
      "J5: policy-changed frame after mid-session revocation",
    );
    const changedFrame = frames.find((f) => f.event === "policy-changed");
    assert.match(changedFrame?.data ?? "", /^\d+$/,
      "J5: policy-changed payload is the epoch integer only — no scope content");
    assert.equal(Number(changedFrame?.data), epochBefore + 1,
      "J5: revocation pushed the next epoch to the live session");
    sweep(frames, "J5 policy stream frames");

    const postRevokeBoundary = await s.callMiddleware(
      await s.requestAs(null, "http://127.0.0.1:3000/workspaces", {
        headers: { cookie: sessionCookieStr },
      }),
    );
    assert.notEqual(postRevokeBoundary.status, 307,
      "J5: the same live session still passes the identity boundary (JWT is identity-only)");
    const revokedViewer = await s.mustViewer(world.customerA.id);
    assert.deepEqual(await wsSlugs(revokedViewer), [],
      "J5: revoked session sees no workspaces");
    assert.equal(await permissions.canAccessProject(revokedViewer, { id: projectA.id }), false,
      "J5: revoked project denies on the next request");
    assert.equal(await permissions.canAccessEpic(revokedViewer, world.epics.epicA.id), false,
      "J5: revoked Epic denies on the next request");
    assert.equal(await taskCount(revokedViewer), 0, "J5: revoked session reads zero work items");
    const revokedComments = await db.comment.findMany({
      where: permissions.accessibleCommentWhere(revokedViewer as never, { taskId: world.tasks.taskA.id }),
      select: { id: true },
    });
    assert.equal(revokedComments.length, 0, "J5: revoked session reads zero comments");
    await assert.rejects(
      publishingService.listPublishedForProject(revokedViewer, projectA.id),
      /Not authorized/,
      "J5: revoked session cannot read published items",
    );

    const regrant = await accessManagement.updateHumanAccessCore(ownerViewer, {
      userId: world.customerA.id,
      projectIds: [projectA.id],
    });
    assert.equal(regrant.changed, true, "J5: re-grant commits");
    const restoredViewer = await s.mustViewer(world.customerA.id);
    assert.equal(await permissions.canAccessProject(restoredViewer, { id: projectA.id }), true,
      "J5: re-grant restores the project on the next request");
    assert.equal(await taskCount(restoredViewer), 25, "J5: re-grant restores the permitted work-item set");
    await waitFor(
      () => frames.filter((f) => f.event === "policy-changed").length >= 2,
      5000,
      "J5: re-grant pushes a second epoch frame",
    );
    // Cancel through the reader: stream.cancel() is illegal while a reader
    // holds the lock (ERR_INVALID_STATE).
    void policyReader.cancel();
    await waitFor(() => streamDone, 5000, "J5: policy stream drain finishes");

    console.log(
      "authz-e2e-flows-test: ok — J1 invitation→activation→edit journey audited end to end, " +
      "J2 Admin guardrails rejected server-side with zero state, " +
      "J3 Customer isolation journey with zero agent identifiers, " +
      "J4 Owner preview lens equals the Customer session (reads + production markup + banner), " +
      "J5 active-session revocation (epoch push, identity survives, authorization denies, re-grant restores)",
    );
  } finally {
    await s.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});