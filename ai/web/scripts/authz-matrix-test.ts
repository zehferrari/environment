// ENV-169 — Role × surface authorization matrix (AC1–AC6 of the Client UI
// Epic acceptance gate).
//
// Every case drives the REAL server policy: viewers are resolved through the
// harness's getViewerByUserId (never literal Viewer objects), scope checks
// run through lib/auth/permissions accessible*Where predicates and the real
// workspaces service, role machinery runs through the transactional
// access-management cores and the pure access-policy matrix, navigation is
// asserted through the real role helpers plus the real SidebarNav component,
// and the request boundary runs the real exported middleware plus a real
// token-scoped agent route handler. No policy is re-implemented here.

import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { setupAuthzScenario } from "./lib/authz-scenario-harness";

type AnyRow = { id: string };

async function assertRejected(promise: Promise<unknown>, messagePart?: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Error, "rejection must be an Error");
    if (messagePart !== undefined) {
      assert.ok(
        error.message.includes(messagePart),
        `expected rejection message to include "${messagePart}", got: ${error.message}`,
      );
    }
    return true;
  });
}

async function main(): Promise<void> {
  const s = await setupAuthzScenario();
  const { db, world, modules } = s;
  const { permissions, accessManagement, accessPolicy, roles, workspacesService } = modules;
  try {
    const owner = await s.mustViewer(world.owner.id);
    const adminA = await s.mustViewer(world.adminA.id);
    const customerA = await s.mustViewer(world.customerA.id);

    const projectA = world.projects.projectA;
    const projectB = world.projects.projectB;
    type PolicyInput = Parameters<typeof accessPolicy.evaluateAccessPolicy>[0];
    type PolicySubject = NonNullable<PolicyInput["viewer"]>;
    const subject = (u: AnyRow, role: PolicySubject["role"]): PolicySubject => ({
      id: u.id, kind: "human", role,
    });
    const policyCell = (args: {
      viewer: PolicySubject;
      viewerProjectIds: string[];
      target: PolicySubject;
      requestedRole: PolicySubject["role"];
      requestedProjectIds: string[];
    }) => accessPolicy.evaluateAccessPolicy({ intent: "access_edit", ...args });
    const taskCount = (viewer: unknown, whereExtra?: Prisma.TaskWhereInput) =>
      db.task.count({
        where: { AND: [permissions.accessibleTaskWhere(viewer as never, { deletedAt: null }), whereExtra ?? {}] },
      });
    const wsSlugs = async (viewer: unknown) =>
      (await workspacesService.listWorkspaces(false, viewer as never))
        .map((w: { slug: string }) => w.slug)
        .sort();

    // ---------------------------------------------------------------- AC1 --
    // Owner retains global access and is the only role with role machinery.
    assert.deepEqual(await wsSlugs(owner), ["az-workspace-a", "az-workspace-b"],
      "AC1: Owner sees every workspace");
    assert.equal(await permissions.canAccessProject(owner, { id: projectA.id }), true,
      "AC1: Owner can access Project A");
    assert.equal(await permissions.canAccessProject(owner, { id: projectB.id }), true,
      "AC1: Owner can access Project B");
    assert.equal(await permissions.canAccessProject(owner, { slug: "az-project-b" }), true,
      "AC1: Owner deep-link reach is global");
    assert.equal(await permissions.canAccessEpic(owner, world.epics.privateEpicA.id), true,
      "AC1: Owner reaches private Epic");
    assert.equal(
      await db.task.count({
        where: { AND: [permissions.accessibleTaskWhere(owner, { deletedAt: null })] },
      }),
      27,
      "AC1: Owner task scope covers every task incl. private",
    );

    // Only the Owner can grant the Admin role; non-admins cannot manage at all.
    await assertRejected(
      accessManagement.inviteHumanUserCore(adminA, {
        username: "az-matrix-x1", email: "az-matrix-x1@example.invalid", displayName: null,
        role: "admin", projectIds: [projectA.id],
      }),
      "Only the Mission Control owner can grant the Admin role.",
    );
    await assertRejected(
      accessManagement.inviteHumanUserCore(customerA, {
        username: "az-matrix-x2", email: "az-matrix-x2@example.invalid", displayName: null,
        role: "customer", projectIds: [],
      }),
      "Only the Mission Control owner or an Admin can manage access.",
    );

    // Owner-side positive: granting the Admin role succeeds and is audited.
    const adminInvite = await accessManagement.inviteHumanUserCore(owner, {
      username: "az-matrix-admin", email: "az-matrix-admin@example.invalid", displayName: null,
      role: "admin", projectIds: [projectA.id],
    });
    assert.ok(adminInvite.token.length > 20, "AC1: Owner admin invitation issues a token");
    const adminInviteAudit = await db.accessAuditLog.findFirstOrThrow({
      where: { affectedUser: { username: "az-matrix-admin" } },
    });
    assert.equal(adminInviteAudit.actorUserId, world.owner.id, "AC1: promote-to-Admin audited with Owner actor");
    assert.equal(adminInviteAudit.newRole, "admin", "AC1: Admin grant recorded");

    // Global agent operations exist only in the Owner experience.
    assert.equal(roles.viewerExperienceForRole("owner").canViewGlobalAgentOperations, true,
      "AC1: Owner experience exposes global agent operations");
    assert.equal(roles.viewerExperienceForRole("admin").canViewGlobalAgentOperations, false,
      "AC1: Admin experience has no global agent operations");
    assert.equal(roles.viewerExperienceForRole("customer").canViewGlobalAgentOperations, false,
      "AC1: Customer experience has no global agent operations");
    assert.equal(roles.viewerExperienceForRole("customer").customerSafe, true,
      "AC1: Customer experience is customer-safe");

    // ---------------------------------------------------------------- AC2 --
    // Admin guardrails are rejected server-side, leave no state, write no audit.
    const usersBefore = await db.user.count();
    const auditBefore = await db.accessAuditLog.count();

    assert.equal(
      (await policyCell({
        viewer: subject(adminA as never, "admin"), viewerProjectIds: [projectA.id],
        target: subject(adminA as never, "admin"), requestedRole: "admin", requestedProjectIds: [projectA.id],
      })).allowed, false,
      "AC2: Admin cannot edit their own access",
    );
    assert.equal(
      (await policyCell({
        viewer: subject(adminA as never, "admin"), viewerProjectIds: [projectA.id],
        target: subject(world.adminB, "admin"), requestedRole: "admin", requestedProjectIds: [projectA.id],
      })).allowed, false,
      "AC2: Admin cannot edit another Admin",
    );
    assert.equal(
      (await policyCell({
        viewer: subject(adminA as never, "admin"), viewerProjectIds: [projectA.id],
        target: subject(world.owner, "owner"), requestedRole: "owner", requestedProjectIds: [projectA.id],
      })).allowed, false,
      "AC2: Admin cannot edit the Owner",
    );
    assert.equal(
      (await policyCell({
        viewer: subject(adminA as never, "admin"), viewerProjectIds: [projectA.id],
        target: subject(world.customerBare, "customer"), requestedRole: "customer", requestedProjectIds: [projectB.id],
      })).allowed, false,
      "AC2: Admin cannot grant an out-of-scope project",
    );
    assert.equal(
      (await policyCell({
        viewer: subject(customerA as never, "customer"), viewerProjectIds: [projectA.id],
        target: subject(world.customerBare, "customer"), requestedRole: "customer", requestedProjectIds: [projectA.id],
      })).allowed, false,
      "AC2: Customers never manage access",
    );

    await assertRejected(
      accessManagement.inviteHumanUserCore(adminA, {
        username: "az-matrix-x3", email: "az-matrix-x3@example.invalid", displayName: null,
        role: "customer", projectIds: [projectB.id],
      }),
      undefined,
    );
    assert.equal(await db.user.count(), usersBefore, "AC2: rejected operations create no users");
    assert.equal(await db.accessAuditLog.count(), auditBefore, "AC2: rejected operations write no audit rows");

    // Positive control: Admin manages Customer access inside their own scope.
    const scopedInvite = await accessManagement.inviteHumanUserCore(adminA, {
      username: "az-matrix-scoped", email: "az-matrix-scoped@example.invalid", displayName: "Scoped Person",
      role: "customer", projectIds: [projectA.id],
    });
    assert.ok(scopedInvite.token.length > 20, "AC2: in-scope Admin invite succeeds");
    const scopedInviteAudit = await db.accessAuditLog.findFirstOrThrow({
      where: { affectedUser: { username: "az-matrix-scoped" } },
    });
    assert.equal(scopedInviteAudit.action, "grant", "AC2: in-scope grant audited");
    assert.equal(scopedInviteAudit.actorUserId, world.adminA.id, "AC2: Admin actor recorded");
    assert.deepEqual(JSON.parse(scopedInviteAudit.newProjectIds), [projectA.id], "AC2: granted scope recorded");

    // ---------------------------------------------------------------- AC3 --
    // Admin granted Project A only: Project B is undiscoverable everywhere.
    const customerB2 = await db.user.create({
      data: {
        username: "az-customer-b2", email: "az-customer-b2@example.invalid", kind: "human",
        mustRotatePassword: false,
        rolePermission: { connect: { name: "customer" } },
        projectMembers: { create: [{ projectId: projectB.id }] },
      },
    });
    assert.deepEqual(await wsSlugs(adminA), ["az-workspace-a"],
      "AC3: Admin sees only the workspace containing their granted project");

    const adminUsers = await db.user.findMany({
      where: permissions.accessibleUserWhere(adminA),
      select: { id: true },
    });
    const adminUserIds = new Set(adminUsers.map((u) => u.id));
    for (const expected of [world.owner.id, world.adminA.id, world.adminB.id, world.customerA.id, world.agents.agentA.userId]) {
      assert.ok(adminUserIds.has(expected), `AC3: Admin keeps in-scope actor ${expected.slice(-6)} (agent activity in scope stays visible)`);
    }
    for (const forbidden of [customerB2.id, world.customerBare.id, world.agents.agentB.userId]) {
      assert.equal(adminUserIds.has(forbidden), false,
        "AC3: Project B users, grantless users, and out-of-scope agents are undiscoverable");
    }

    assert.equal(await permissions.canAccessProject(adminA, { slug: "az-project-b" }), false,
      "AC3: direct URL to Project B is out of scope");
    assert.equal(await permissions.canAccessEpic(adminA, world.epics.epicB.id), false,
      "AC3: Project B Epic unreachable");
    assert.equal(await taskCount(adminA), 25, "AC3: Admin task set is exactly the 25 public Project A tasks");
    assert.equal(await taskCount(adminA, { id: world.tasks.taskB.id }), 0,
      "AC3: Project B task undiscoverable via direct query");
    assert.equal(await taskCount(adminA, { id: world.tasks.privateTaskA.id }), 0,
      "AC3: private Task stays Owner-only");

    const adminCommentsAll = await db.comment.findMany({
      where: permissions.accessibleCommentWhere(adminA),
      select: { id: true },
    });
    const adminCommentIds = new Set(adminCommentsAll.map((c) => c.id));
    assert.equal(adminCommentIds.has(world.comments.agentOnTaskA.id), true,
      "AC3: Admin retains in-scope agent comments (visible, masked presentation)");
    assert.equal(adminCommentIds.has(world.comments.humanOnTaskB.id), false,
      "AC3: Project B human comment undiscoverable");
    assert.equal(adminCommentIds.has(world.comments.agentOnTaskB.id), false,
      "AC3: Project B agent comment undiscoverable");

    const adminActivities = await db.activityLog.findMany({
      where: await permissions.accessibleActivityWhere(adminA, {}),
      select: { id: true },
    });
    const adminActivityIds = new Set(adminActivities.map((a) => a.id));
    assert.equal(adminActivityIds.has(world.activities.agentOnTaskA.id), true,
      "AC3: Admin sees agent activity inside Project A");
    assert.equal(adminActivityIds.has(world.activities.agentOnProjectB.id), false,
      "AC3: Project B agent activity undiscoverable");

    const adminAttachments = await db.attachment.findMany({
      where: permissions.accessibleAttachmentWhere(adminA, {}),
      select: { id: true },
    });
    const adminAttachmentIds = new Set(adminAttachments.map((a) => a.id));
    assert.equal(adminAttachmentIds.has(world.attachments.agentOnTaskA.id), true,
      "AC3: Admin retains the in-scope agent attachment");
    assert.equal(adminAttachmentIds.has(world.attachments.humanOnProjectB.id), false,
      "AC3: Project B attachment undiscoverable");

    // Search surface (GET /api/tasks/search?q=…): the route resolves its
    // session through getViewer() — the request-ALS class the harness
    // documents as undrivable in-process — so this case drives the exact
    // predicate composition the route runs (same where + projection + take),
    // per the plan's "undiscoverable via pages, APIs, search and direct URLs".
    const searchResults = async (viewer: unknown, q: string) =>
      db.task.findMany({
        where: permissions.accessibleTaskWhere(viewer as never, {
          deletedAt: null,
          OR: [
            { title: { contains: q } },
            { workItemKey: { contains: q } },
          ],
        }),
        select: {
          id: true,
          title: true,
          workItemKey: true,
          status: true,
          project: { select: { name: true, slug: true } },
        },
        take: 20,
      });
    for (const viewer of [adminA, customerA]) {
      assert.deepEqual(
        (await searchResults(viewer, "Task A")).map((t) => t.id),
        [world.tasks.taskA.id],
        "AC3: search returns exactly the permitted Project A row — the composition is not vacuously empty",
      );
      assert.deepEqual(await searchResults(viewer, "Task B"), [],
        "AC3: Project B task is undiscoverable via search");
      assert.deepEqual(await searchResults(viewer, "Private Task"), [],
        "AC3: private Task stays undiscoverable via search");
      assert.deepEqual(await searchResults(viewer, "az-no-such-term-anywhere"), [],
        "AC3: search denies forbidden content with the identical empty shape of a nonexistent term (no existence oracle)");
    }

    // ---------------------------------------------------------------- AC4 --
    // Customer: permitted human-facing views work, agent surfaces are absent.
    assert.deepEqual(await wsSlugs(customerA), ["az-workspace-a"],
      "AC4: Customer lands in their permitted workspace");
    assert.deepEqual(await wsSlugs(await s.mustViewer(world.customerBare.id)), [],
      "AC4: grantless Customer sees no workspace at all");
    assert.equal(await taskCount(customerA), 25, "AC4: Customer sees permitted public work items");
    assert.equal(await taskCount(customerA, { id: world.tasks.taskA.id }), 1,
      "AC4: permitted work-item view works");
    assert.equal(await taskCount(customerA, { id: world.tasks.privateTaskA.id }), 0,
      "AC4: private Task unreachable for Customer");
    assert.equal(await permissions.canAccessEpic(customerA, world.epics.epicA.id), true,
      "AC4: permitted Epic reachable");
    assert.equal(await permissions.canAccessEpic(customerA, world.epics.privateEpicA.id), false,
      "AC4: private Epic unreachable for Customer");

    const customerComments = await db.comment.findMany({
      where: permissions.accessibleCommentWhere(customerA, { taskId: world.tasks.taskA.id }),
      select: { id: true },
    });
    assert.deepEqual(
      customerComments.map((c) => c.id).sort(),
      [world.comments.humanOnTaskA.id, world.comments.humanNamingAgent.id].sort(),
      "AC4: Customer comments keep human rows only — no agent, generated, or re-attributed content",
    );

    const customerUsers = await db.user.findMany({
      where: permissions.accessibleUserWhere(customerA),
      select: { id: true },
    });
    const customerUserIds = new Set(customerUsers.map((u) => u.id));
    assert.ok(customerUserIds.has(world.owner.id), "AC4: Customer sees human users in scope");
    assert.equal(customerUserIds.has(world.agents.agentA.userId), false,
      "AC4: agent identities are absent from the Customer universe");

    // Navigation/controls: zero agent surfaces for the Customer role.
    assert.deepEqual(
      roles.taskDetailTabsForRole("customer", true).filter(
        (t) => ["Action Plan", "Sub-Tasks", "Activities", "Development", "Changes"].includes(t),
      ),
      [],
      "AC4: Customer Task tabs contain no internal workflow tabs",
    );
    assert.deepEqual(
      roles.epicDetailTabsForRole("customer", true).filter((t) => ["Action Plan", "Activities", "Development", "Changes"].includes(t)),
      [],
      "AC4: Customer Epic tabs contain no internal workflow tabs",
    );
    assert.equal(roles.viewerExperienceForRole("customer").canViewProjectWorkflow, false,
      "AC4: Customer experience cannot view project workflow internals");

    {
      const React = (await import("react")).default;
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
      const { PathnameContext, SearchParamsContext } = await import(
        "next/dist/shared/lib/hooks-client-context.shared-runtime"
      );
      // components/sidebar-nav.tsx exports SidebarNav as a default export.
      const SidebarNav = (await import("../components/sidebar-nav")).default as never;
      (globalThis as typeof globalThis & { React: unknown }).React = React;
      const router = {
        back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {},
        prefetch: async () => undefined,
      };
      const withNavigation = (element: import("react").ReactNode) =>
        React.createElement(
          AppRouterContext.Provider, { value: router as never },
          React.createElement(
            PathnameContext.Provider, { value: "/workspaces" },
            React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams() }, element),
          ),
        );
      const customerSidebar = renderToStaticMarkup(
        withNavigation(React.createElement(SidebarNav, {
          isOwner: false,
          canViewAgents: false,
          canManageCustomerAccess: false,
          customerSafe: true,
          agents: [],
          projects: [],
          workspaces: [{
            slug: "az-workspace-a",
            name: "AZ Workspace A",
            logoSrc: null,
            projects: [{ slug: "az-project-a", name: "AZ Project A", completion: 50 }],
            agentSlugs: [],
          }],
          meName: "Customer user",
          meKind: "human",
          userId: world.customerA.id,
          userAvatarVersion: null,
          signOutAction: async () => undefined,
        })),
      );
      assert.match(customerSidebar, /AZ Workspace A/, "AC4: Customer navigation renders the permitted workspace");
      assert.doesNotMatch(customerSidebar,
        /Agents|Mission Control|Unread messages|Internal Agent|Customer access|Logs &amp; Activity|Settings/,
        "AC4: Customer navigation contains zero agent or internal controls");
    }

    // ---------------------------------------------------------------- AC6 --
    // Deep links: session gate at the boundary; uniform denial beyond it.
    const anon = await s.callMiddleware(
      await s.requestAs(null, "http://127.0.0.1:3000/workspaces"),
    );
    assert.equal(anon.status, 307, "AC6: anonymous deep link redirects to login");
    assert.match(anon.location ?? "", /\/login/, "AC6: anonymous deep link is safe-not-found (login, no metadata)");
    const authed = await s.callMiddleware(
      await s.requestAs(world.customerA.id, "http://127.0.0.1:3000/workspaces"),
    );
    assert.notEqual(authed.status, 307, "AC6: authenticated session passes the request boundary");

    // Forbidden and nonexistent resources deny identically — no existence oracle.
    assert.equal(await permissions.canAccessProject(customerA, { id: projectB.id }), false,
      "AC6: forbidden project denies");
    assert.equal(await permissions.canAccessProject(customerA, { id: "does-not-exist-000" }), false,
      "AC6: nonexistent project denies with the same shape");
    assert.equal(await taskCount(customerA, { id: world.tasks.taskB.id }), 0,
      "AC6: forbidden task query is empty");
    assert.equal(await taskCount(customerA, { id: "does-not-exist-000" }), 0,
      "AC6: nonexistent task query is identically empty");

    // Agent-only APIs refuse browser sessions without leaking metadata.
    const agentContextRoute = await import("../app/api/agents/context/task/[id]/route");
    const refused = await s.callRoute(
      agentContextRoute,
      "GET",
      await s.requestAs(world.customerA.id, `http://127.0.0.1:3000/api/agents/context/task/${world.tasks.taskA.id}`),
      { id: world.tasks.taskA.id },
    );
    assert.ok([401, 403].includes(refused.status),
      `AC6: agent-only API refuses a session-cookie request (got ${refused.status})`);
    const refusedBody = await refused.text();
    for (const sentinel of ["az-agent-a", "az-project-a", world.tasks.taskA.id]) {
      assert.equal(refusedBody.includes(sentinel), false,
        "AC6: refusal body leaks no resource metadata");
    }

    console.log(
      "authz-matrix-test: ok — AC1 owner-global + role machinery, AC2 admin guardrails (server-side, audited), " +
      "AC3 admin scope isolation (Project B undiscoverable — pages, APIs, search composition, direct URLs), " +
      "AC4 customer experience (zero agent surfaces, search-safe), " +
      "AC6 deep-link safety (no existence oracle)",
    );
  } finally {
    await s.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});