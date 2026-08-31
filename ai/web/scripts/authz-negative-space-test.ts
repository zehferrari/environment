// ENV-169 — Negative-space payload scrubbing (AC5) + count/pagination equality.
//
// Every Customer-visible payload is swept recursively for agent identifiers
// derived from the seeded cast (agentIdentifierSentinels), so the suite cannot
// drift from the harness fixtures. The visible set is defined by the REAL
// access predicates and services — nothing here re-implements policy — and
// Customer payloads are taken through the same projection path the pages use
// (actor-visibility projectors + the free-text agent redactor), never raw rows.
//
// Recorded disposition: the schema has no Notification model to sweep; unread
// counters exist only on agent-chat surfaces (absent by predicate and by
// navigation); and the agent-chat + viewer-stream routes resolve sessions via
// headers()/auth() — the request-ALS class the harness documents as undrivable
// in-process, whose boundary refusal is proven on the drivable agent-only API
// class by the matrix suite (AC6). The stream's frame contract is asserted
// here directly against the real stream factory.

import assert from "node:assert/strict";
import { setupAuthzScenario, agentIdentifierSentinels } from "./lib/authz-scenario-harness";

async function main(): Promise<void> {
  const s = await setupAuthzScenario();
  const { db, world, modules } = s;
  const { permissions, workspacesService, contentPolicy, actorVisibility, redactAgents } = modules;
  try {
    const customerA = await s.mustViewer(world.customerA.id);
    const sentinels = agentIdentifierSentinels(world);
    const visibility = await actorVisibility.getActorVisibility(customerA);
    const redactBody = redactAgents.buildAgentRedactor(visibility.agentIdentities, visibility.maskAgents);

    const sweep = (label: string, payload: unknown): void => {
      const json = JSON.stringify(payload) ?? "null";
      for (const sentinel of sentinels) {
        assert.equal(
          json.includes(sentinel),
          false,
          `${label}: customer-visible payload must not contain agent sentinel "${sentinel}"`,
        );
      }
    };
    const failures: string[] = [];
    const section = async (label: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        failures.push(`${label}: ${(error as Error).message}`);
      }
    };

    // 1. Workspaces JSON (API + serialized page-data surface).
    const workspaces = await workspacesService.listWorkspaces(false, customerA);
    assert.equal(workspaces.length, 1, "customer sees exactly their granted workspace");
    sweep("listWorkspaces(customer)", workspaces);
    const visibleWorkspace = workspaces[0] as { slug?: string; agentSlugs?: unknown };
    assert.equal(visibleWorkspace.slug, "az-workspace-a", "permitted workspace is the granted one");
    assert.deepEqual(visibleWorkspace.agentSlugs ?? [], [], "customer workspace payload carries no agent slugs");

    // 2. Comments: visible set is exactly the two human rows (the
    //    agent-authored comment addressed to the Customer is absent, never
    //    re-attributed); the payload runs through the page's own projection
    //    (author projector + free-text redactor) before the sweep.
    await section("comments", async () => {
      const visibleComments = await db.comment.findMany({
        where: permissions.accessibleCommentWhere(customerA, { taskId: world.tasks.taskA.id }),
        include: { user: true },
      });
      assert.deepEqual(
        visibleComments.map((c) => c.id).sort(),
        [world.comments.humanOnTaskA.id, world.comments.humanNamingAgent.id].sort(),
        "customer comment set is exactly the two human rows — agent comment addressed to the Customer absent, not re-attributed",
      );
      const payload = visibleComments.map((c) => ({
        id: c.id,
        body: redactBody(c.body),
        author: actorVisibility.serializeVisibleActor(c.user, visibility),
      }));
      sweep("customer comment payload (projected author + redacted body)", payload);
      const mentionRow = payload.find((p) => p.id === world.comments.humanNamingAgent.id);
      assert.ok(mentionRow, "humanNamingAgent row present for redaction check");
      assert.ok(mentionRow.body.includes("@agent"), "agent @mention collapses to the neutral token");
      assert.equal(mentionRow.body.includes("az-agent-a"), false, "redacted body carries no real agent slug");
    });

    // 3. Hidden-comment complement: agent-authored, generated, and
    //    addressed-to-customer rows all fail the accessible predicate.
    await section("hidden-comment-complement", async () => {
      const agentCommentIds = [
        world.comments.agentOnTaskA.id,
        world.comments.agentAddressedToCustomer.id,
        world.comments.generatedOnTaskA.id,
      ];
      const leaked = await db.comment.findMany({
        where: {
          AND: [
            permissions.accessibleCommentWhere(customerA, { taskId: world.tasks.taskA.id }),
            { id: { in: agentCommentIds } },
          ],
        },
        select: { id: true },
      });
      assert.deepEqual(leaked, [], "no agent-authored or generated comment passes the accessible predicate");
    });

    // 4. Activities: page composition is accessibleActivityWhere AND the
    //    content-policy record guard. For a hidden viewer that excludes the
    //    task.move machinery kind as well as every agent-authored row, so the
    //    visible set is exactly the one human project row.
    const activityWhere = {
      AND: [
        await permissions.accessibleActivityWhere(customerA, {}),
        contentPolicy.visibleActivityRecordWhere(customerA),
      ],
    };
    await section("activities", async () => {
      const visibleActivities = await db.activityLog.findMany({
        where: activityWhere,
        include: { user: true },
      });
      assert.deepEqual(
        visibleActivities.map((a) => a.id).sort(),
        [world.activities.humanOnProjectA.id],
        "customer activity set is exactly the human project row — workflow machinery and agent activity hidden",
      );
      sweep("customer activity rows", visibleActivities);
      const projected = actorVisibility.visibleActivityRows(visibleActivities, visibility);
      sweep("customer activity payload (projected)", projected);
      for (const id of [
        world.activities.humanOnTaskA.id,
        world.activities.agentOnTaskA.id,
        world.activities.agentOnProjectB.id,
      ]) {
        const leaked = await db.activityLog.count({ where: { AND: [activityWhere, { id }] } });
        assert.equal(leaked, 0, `activity ${id.slice(-6)} sits in the hidden complement`);
      }
    });

    // 5. Attachments metadata: exactly the human Project A attachment.
    await section("attachments", async () => {
      const visibleAttachments = await db.attachment.findMany({
        where: permissions.accessibleAttachmentWhere(customerA, {}),
      });
      assert.deepEqual(
        visibleAttachments.map((a) => a.id).sort(),
        [world.attachments.humanOnTaskA.id],
        "customer attachment set is exactly the human Project A attachment",
      );
      sweep("customer attachment metadata", visibleAttachments);
    });

    // 6. Users universe: humans visible, zero agent principals.
    await section("users", async () => {
      const visibleUsers = await db.user.findMany({ where: permissions.accessibleUserWhere(customerA) });
      assert.equal(visibleUsers.some((u) => u.id === world.owner.id), true, "human users stay visible");
      assert.equal(
        visibleUsers.some((u) => u.id === world.agents.agentA.userId || u.id === world.agents.agentB.userId),
        false,
        "agent principals are absent from the Customer user universe",
      );
      sweep("customer user universe", visibleUsers);
    });

    // 7. Tasks + counts/pagination equality with the filtered set. The swept
    //    payload runs through the real actor projectors: the permitted task
    //    with an agent assignee stays visible but its assignee projects to
    //    null — the row itself is evidence, the identity is not.
    await section("tasks-counts-pagination", async () => {
      const visibleTasks = await db.task.findMany({
        where: permissions.accessibleTaskWhere(customerA, { deletedAt: null }),
        include: { assignee: { include: { agent: true } }, reporter: true },
        orderBy: { id: "asc" },
      });
      assert.equal(visibleTasks.length, 25, "count equals the filtered result set");
      const customerTaskPayload = visibleTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: actorVisibility.serializeVisibleActorAs(t.assignee, "assignee", visibility),
        reporter: actorVisibility.serializeVisibleActor(t.reporter, visibility),
      }));
      sweep("customer task payload (projected actors)", customerTaskPayload);
      const taskAPayload = customerTaskPayload.find((t) => t.id === world.tasks.taskA.id);
      assert.ok(taskAPayload, "permitted task with agent assignee is visible");
      assert.equal(taskAPayload.assignee, null, "agent assignee projects to null — no agent identity in the payload");
      const pageSize = 10;
      const pagedIds: string[] = [];
      for (let offset = 0; offset < visibleTasks.length; offset += pageSize) {
        const page = await db.task.findMany({
          where: permissions.accessibleTaskWhere(customerA, { deletedAt: null }),
          orderBy: { id: "asc" },
          take: pageSize,
          skip: offset,
          select: { id: true },
        });
        for (const t of page) pagedIds.push(t.id);
      }
      assert.equal(pagedIds.length, visibleTasks.length, "pagination total equals the filtered-set count");
      assert.deepEqual(pagedIds, visibleTasks.map((t) => t.id), "pagination union is exactly the filtered set");
    });

    // 8. Chat absence: the real chat visibility predicate yields no row set
    //    at all for a hidden viewer.
    await section("chat-absence", async () => {
      const chatRows = await db.agentChatMessage.findMany({
        where: contentPolicy.visibleAgentChatMessageWhere(customerA),
      });
      assert.equal(chatRows.length, 0, "agent chat is entirely absent from the Customer universe");
    });

    // 9. Viewer policy stream: the real stream factory, wired exactly as the
    //    route wires it (the route itself resolves sessions through
    //    headers()/auth() — the request-ALS class the harness documents as
    //    undrivable in-process). The channel contract is the AC5 surface:
    //    epoch integers only, through connect and change.
    await section("viewer-policy-stream", async () => {
      let epoch = 7;
      const stream = modules.viewerPolicyStream.createViewerPolicyStream({
        viewerId: world.customerA.id,
        initialEpoch: epoch,
        readEpoch: async () => epoch,
        resolveViewer: () => s.viewer(world.customerA.id),
        heartbeatMs: 50,
      });
      const reader = stream.getReader();
      let sseText = "";
      const deadline = Date.now() + 5000;
      let bumped = false;
      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done) break;
        sseText += Buffer.from(value).toString("utf8");
        if (!bumped && sseText.includes("policy-version")) {
          bumped = true;
          epoch = 8;
        }
        if (sseText.includes("policy-changed")) break;
      }
      await reader.cancel().catch(() => undefined);
      assert.ok(sseText.includes("policy-version"), "policy stream emitted the initial epoch frame");
      assert.ok(sseText.includes("policy-changed"), "policy stream announced the epoch change");
      sweep("viewer policy stream frames", sseText);
    });

    // 10. Rendered customer navigation HTML (proven matrix render pattern).
    await section("rendered-html", async () => {
      const React = (await import("react")).default;
      const { renderToStaticMarkup } = await import("react-dom/server");
      const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
      const { PathnameContext, SearchParamsContext } = await import(
        "next/dist/shared/lib/hooks-client-context.shared-runtime"
      );
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
      const html = renderToStaticMarkup(
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
      sweep("rendered customer navigation HTML", html);
    });

    assert.deepEqual(
      failures,
      [],
      `AC5 sections failed:\n- ${failures.join("\n- ")}`,
    );

    console.log(
      "authz-negative-space-test: ok — AC5 zero agent identifiers across workspaces/comments (projected+redacted)/" +
      "hidden complement/activities/attachments/users/tasks+pagination (projected actors)/chat absence/" +
      "policy stream frames (epoch-only)/rendered HTML; counts and pagination totals equal the filtered set",
    );
  } finally {
    await s.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});