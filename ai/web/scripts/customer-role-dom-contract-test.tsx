import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  PathnameContext,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import Board from "../app/(app)/projects/[slug]/board-client";
import ChatRoom from "../components/chat-room";
import RoleVisibleTabPanel from "../components/role-visible-tab-panel";
import SidebarNav from "../components/sidebar-nav";
import { TabsNav, TabsProvider } from "../components/task-tabs";
import {
  customerSafeWorkflowLabel,
  epicDetailTabsForRole,
  taskDetailTabsForRole,
  viewerExperienceForRole,
} from "../lib/auth/roles";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const router = {
  back() {},
  forward() {},
  refresh() {},
  hmrRefresh() {},
  push() {},
  replace() {},
  prefetch: async () => undefined,
};

function withNavigation(children: React.ReactNode, pathname = "/workspaces/client") {
  return (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={pathname}>
        <SearchParamsContext.Provider value={new URLSearchParams()}>
          {children}
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

const customerSidebar = renderToStaticMarkup(withNavigation(
  <SidebarNav
    isOwner={false}
    pendingProposalCount={12}
    canViewAgents={false}
    canManageCustomerAccess={false}
    customerSafe
    agents={[{ slug: "internal", name: "Internal Agent", role: "coding", avatarSrc: null, status: "busy", unread: true }]}
    projects={[{ slug: "alpha", name: "Alpha", completion: 50 }]}
    workspaces={[{
      slug: "client",
      name: "Client workspace",
      logoSrc: null,
      projects: [{ slug: "alpha", name: "Alpha", completion: 50 }],
      agentSlugs: ["internal"],
    }]}
    meName="Client user"
    meKind="human"
    userId="customer-1"
    userAvatarVersion={null}
    signOutAction={async () => undefined}
  />,
));
assert.match(customerSidebar, /Client workspace/, "Customer navigation renders permitted workspace links");
assert.match(customerSidebar, />Workspace</, "Customer shell uses human-facing branding");
assert.doesNotMatch(customerSidebar, /Mission Control|Agents|Internal Agent|Unread messages|Customer access|Logs &amp; Activity|Settings/, "Customer navigation omits internal and administrative nodes from rendered DOM");
assert.doesNotMatch(customerSidebar, /Proposals|\/proposals/, "Owner proposal counts and links stay out of customer navigation");

const ownerSidebar = renderToStaticMarkup(withNavigation(
  <SidebarNav isOwner pendingProposalCount={2} canViewAgents canManageCustomerAccess customerSafe={false}
    agents={[]} projects={[]} workspaces={[]} meName="Owner" meKind="human" userId="owner"
    userAvatarVersion={null} signOutAction={async () => undefined} />,
  "/proposals",
));
assert.match(ownerSidebar, /href="\/proposals"/, "Owner has a direct proposal review destination");
assert.ok((ownerSidebar.match(/href="\/proposals"/g) ?? []).length >= 2, "Proposal navigation is rendered for desktop and mobile");
assert.match(ownerSidebar, /Proposals \(2\)/, "Pending count makes work awaiting review visible");

const adminSidebar = renderToStaticMarkup(withNavigation(
  <SidebarNav
    isOwner={false}
    canViewAgents={false}
    canManageCustomerAccess
    customerSafe={false}
    agents={[]}
    projects={[]}
    workspaces={[]}
    meName="Admin user"
    meKind="human"
    userId="admin-1"
    userAvatarVersion={null}
    signOutAction={async () => undefined}
  />,
));
assert.match(adminSidebar, /Customer access/, "Admin navigation retains scoped Customer access");
assert.doesNotMatch(adminSidebar, />Agents<|All agents/, "Admin navigation does not gain global agent operations");

function renderedTabs(tabs: string[]) {
  return renderToStaticMarkup(withNavigation(
    <TabsProvider defaultTab="Description">
      <TabsNav tabs={tabs} badges={{ "Action Plan": 7 }} />
    </TabsProvider>,
    "/projects/alpha/tasks/task-1",
  ));
}

const customerTaskTabs = renderedTabs(taskDetailTabsForRole("customer", true));
assert.match(customerTaskTabs, /Description.*Attachments.*Comments/s, "Customer Task keeps human-facing tabs");
assert.doesNotMatch(customerTaskTabs, /Action Plan|Sub-Tasks|Activities|Development|Changes|>7</, "Customer Task DOM contains no internal tabs or unread badge");

const customerEpicTabs = renderedTabs(epicDetailTabsForRole("customer", true));
assert.match(customerEpicTabs, /Description.*Tasks.*Attachments.*Comments/s, "Customer Epic keeps human-facing tabs");
assert.doesNotMatch(customerEpicTabs, /Action Plan|Activities|Development|Changes|>7</, "Customer Epic DOM contains no internal tabs or unread badge");

const adminTaskTabs = renderedTabs(taskDetailTabsForRole("admin", true));
assert.match(adminTaskTabs, /Action Plan.*Activities.*Development.*Changes/s, "Admin retains project-scoped workflow context");

const customerTaskPanels = renderToStaticMarkup(
  <TabsProvider defaultTab="Description">
    <RoleVisibleTabPanel
      name="Sub-Tasks"
      visible={viewerExperienceForRole("customer").canViewProjectWorkflow}
    >
      <div>Internal checklist item · review · 37 minutes</div>
    </RoleVisibleTabPanel>
  </TabsProvider>,
);
assert.doesNotMatch(
  customerTaskPanels,
  /Internal checklist item|review|37 minutes/,
  "Customer rendered Task panels omit the Sub-Tasks payload instead of mounting it hidden",
);

const adminTaskPanels = renderToStaticMarkup(
  <TabsProvider defaultTab="Sub-Tasks">
    <RoleVisibleTabPanel
      name="Sub-Tasks"
      visible={viewerExperienceForRole("admin").canViewProjectWorkflow}
    >
      <div>Internal checklist item</div>
    </RoleVisibleTabPanel>
  </TabsProvider>,
);
assert.match(adminTaskPanels, /Internal checklist item/, "Admin retains project-scoped Task checklist context");

const internalActor = {
  id: "agent-user-1",
  username: "internal-agent",
  kind: "agent",
  agent: { slug: "internal", name: "Internal Agent", avatar: null },
};
const adminActionPlan = renderToStaticMarkup(withNavigation(
  <ChatRoom
    readOnly
    projectSlug="alpha"
    taskId="task-1"
    messages={[{
      id: "message-1",
      body: "Scoped workflow context",
      createdAt: "2026-08-31T00:00:00.000Z",
      allowDescriptionEdit: false,
      editGrantUsedAt: null,
      sender: internalActor,
    }]}
    pendingAgents={[{ slug: "internal", username: "Internal Agent" }]}
    latestMessageId="message-1"
    currentUserId="admin-1"
  />,
));
assert.match(adminActionPlan, /Scoped workflow context/, "Admin retains read-only project Action Plan context");
assert.match(adminActionPlan, /Read-only/, "Admin Action Plan identifies its non-mutating mode");
assert.doesNotMatch(
  adminActionPlan,
  /Approve Plan|New Discussion|Message action plan|Send|Delete message|Stop and edit/,
  "Admin Action Plan DOM omits Owner-only approval, messaging, and moderation controls",
);

const customerBoard = renderToStaticMarkup(withNavigation(
  <Board
    projectSlug="alpha"
    boardStreamUrl={null}
    customerSafe
    columns={[
      { id: "To Do", label: "To Do" },
      { id: "In Progress", label: "In Progress" },
      { id: "Review", label: "Review" },
      { id: "Done", label: "Done" },
    ]}
    tasks={[{
      id: "task-1",
      workItemKey: "ENV-1",
      title: "Customer-visible task",
      status: "Review",
      rank: 1,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      statusChangedAt: "2026-08-31T00:00:00.000Z",
      approvedOn: "2026-08-31T00:00:00.000Z",
      deploymentStatus: "ready",
      epicId: null,
      reporter: internalActor,
      assignee: internalActor,
      reviewer: internalActor,
      manager: internalActor,
      createdBy: internalActor,
      updatedBy: internalActor,
      epicTitle: null,
      subtaskImplTotal: 3,
      subtaskImplDone: 2,
      subtaskReviewTotal: 2,
      subtaskReviewDone: 1,
      subtaskMinutes: 25,
      blockedByKeys: ["ENV-0"],
      executionState: "stalled",
      executionReason: "workflow dispatch stalled",
      ownerAcceptancePending: true,
      hasActiveBlocker: true,
      activeBlockerCommentId: "comment-1",
      activeWorking: true,
      hideInternalActors: true,
      project: { slug: "alpha", name: "Alpha" },
    }]}
    deleteTaskAction={async () => undefined}
  />,
));
assert.match(customerBoard, />Ready</, "Customer board renames the Review lane");
assert.doesNotMatch(customerBoard, /Workflow board|>Review<|Attention|Backlog|Internal Agent|stalled|workflow dispatch|sub-tasks done|review topics|Unread|Move task to bin|Awaiting owner acceptance/, "Customer board DOM omits internal workflow copy, actors, checklists, blockers, and mutation nodes");
assert.equal(customerSafeWorkflowLabel("Review", true), "Ready");

for (const relative of [
  "app/(app)/projects/[slug]/tasks/[taskId]/page.tsx",
  "app/(app)/projects/[slug]/epics/[epicId]/page.tsx",
]) {
  const source = readFileSync(path.join(process.cwd(), relative), "utf8");
  assert.match(source, /experience\.customerSafe && comment\.user\.kind === "agent"/, `${relative} must remove agent-authored comments before Customer render`);
  assert.match(source, /experience\.customerSafe \? null : syntheticRoleMeta\(commentAuthor\)/, `${relative} must omit reviewer\/assignee badges from Customer comments`);
}

console.log("customer-role-dom-contract-test: ok");
