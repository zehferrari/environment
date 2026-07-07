import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DeploymentTab, { canShowDeploymentAction, canShowDeploymentTab } from "../components/deployment-tab";
import { checkDeploymentStatusWrite, deploymentStatusIcon } from "../lib/deploy/deployment-status";

assert.equal(canShowDeploymentTab("epic"), true, "Epic shows Deployment tab");
assert.equal(canShowDeploymentTab({ epicId: null, parentTaskId: null }), true, "top-level Task shows Deployment tab");
assert.equal(canShowDeploymentTab({ epicId: "epic-1", parentTaskId: null }), false, "Epic child Task hides Deployment tab");
assert.equal(canShowDeploymentTab({ epicId: null, parentTaskId: "child-of-task" }), false, "sub-task hides Deployment tab");


assert.equal(deploymentStatusIcon("Not Required"), "—", "not-required deployment icon");
assert.equal(deploymentStatusIcon("Deployment Approved"), "🟠", "approved deployment icon");
assert.equal(deploymentStatusIcon("Successfully Deployed"), "🟢", "deployed deployment icon");
assert.equal(deploymentStatusIcon("Deployment Error"), "🔴", "deployment error icon");
assert.equal(checkDeploymentStatusWrite({ actor: { kind: "agent" }, from: "Not Required", to: "Deployment Approved" }).ok, false, "agents cannot approve deployment");
assert.equal(checkDeploymentStatusWrite({ actor: { kind: "human" }, from: "Not Required", to: "Deployment Approved" }).ok, true, "humans can approve deployment");
assert.equal(checkDeploymentStatusWrite({ actor: { kind: "agent" }, actorAgentRole: "coding", from: "Deployment Approved", to: "Successfully Deployed" }).ok, false, "coding agents cannot set deployed");
assert.equal(checkDeploymentStatusWrite({ actor: { kind: "agent" }, actorAgentRole: "monitor", from: "Deployment Approved", to: "Successfully Deployed" }).ok, true, "monitor agent can set deployed");

assert.equal(canShowDeploymentAction({
  provider: "bitbucket",
  viewerKind: "human",
  viewerId: "reporter-1",
  reporterId: "reporter-1",
}), true, "Bitbucket reporter gets actions");
assert.equal(canShowDeploymentAction({
  provider: "github",
  viewerKind: "human",
  viewerId: "reporter-1",
  reporterId: "reporter-1",
}), false, "unsupported provider hides actions");
assert.equal(canShowDeploymentAction({
  provider: "bitbucket",
  viewerKind: "agent",
  viewerId: "reporter-1",
  reporterId: "reporter-1",
}), false, "agents do not get reporter-only actions");
assert.equal(canShowDeploymentAction({
  provider: "bitbucket",
  viewerKind: "human",
  viewerId: "other-user",
  reporterId: "reporter-1",
}), false, "non-reporters do not get actions");
assert.equal(canShowDeploymentAction({
  provider: "bitbucket",
  viewerKind: "human",
  viewerId: "reviewer-1",
  reporterId: "reporter-1",
  reviewerId: "reviewer-1",
}), true, "reviewer gets actions when reporter-only policy is disabled");
assert.equal(canShowDeploymentAction({
  provider: "bitbucket",
  viewerKind: "human",
  viewerId: "reviewer-1",
  reporterId: "reporter-1",
  reviewerId: "reviewer-1",
  onlyReportersCanApprovePullRequests: true,
}), false, "reviewer actions hide when reporter-only PR policy is enabled");

// Terminal statuses render from the ROW's own state (the monitor's actual
// vocabulary), never from the scope-level rollup — a deployed sibling must
// not show "Waiting for merge" because another row errored.
const html = renderToStaticMarkup(
  <DeploymentTab
    mode="epic"
    title="Deployments"
    deploymentStatus="Deployment Error"
    rows={[{
      id: "pr-1",
      provider: "bitbucket",
      providerPrId: "42",
      url: "https://bitbucket.org/example/repo/pull-requests/42",
      sourceBranch: "pm-deployments",
      targetBranch: "main",
      latestCommitSha: "abcdef1234567890",
      status: "deployed",
      deploymentExitCode: 0,
      updatedAt: new Date("2026-06-04T00:00:00Z"),
      task: { workItemKey: "ENV-17", title: "Deployment tab UI" },
    }, {
      id: "pr-2",
      provider: "bitbucket",
      providerPrId: "43",
      url: "https://bitbucket.org/example/repo/pull-requests/43",
      sourceBranch: "pm-deployments-2",
      targetBranch: "main",
      latestCommitSha: "1234567890abcdef",
      status: "deployment_error",
      deploymentExitCode: 7,
      deploymentStderr: "prisma migrate deploy failed: P2022",
      updatedAt: new Date("2026-06-04T00:00:00Z"),
      task: { workItemKey: "ENV-18", title: "Broken deploy" },
    }]}
    canAct={() => true}
    approveLocalChangesAction={async () => {}}
    approveAndMergeAction={async () => {}}
  />,
);

for (const expected of [
  "Epic child PR rollup",
  "ENV-17: Deployment tab UI",
  "pm-deployments",
  "main",
  "abcdef123456",
  "Approved",
  "Merged",
  "Deploy script succeeded",
  "Deploy script failed",
  "Exit code 7",
  "prisma migrate deploy failed: P2022",
  "No action",
]) {
  assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `renders ${expected}`);
}
assert.doesNotMatch(html, /Waiting for merge/, "terminal rows never show Waiting for merge");
assert.doesNotMatch(html, /Approve\/Merge/, "terminal rows expose no Approve/Merge button");

const openHtml = renderToStaticMarkup(
  <DeploymentTab
    mode="task"
    title="Open PR task"
    deploymentStatus="Deployment Approved"
    rows={[{
      id: "pr-open",
      provider: "bitbucket",
      providerPrId: "44",
      url: "https://bitbucket.org/example/repo/pull-requests/44",
      sourceBranch: "feature/open",
      targetBranch: "main",
      latestCommitSha: "feedbeef12345678",
      status: "open",
      updatedAt: new Date("2026-06-04T00:00:00Z"),
    }]}
    canAct={() => true}
    approveLocalChangesAction={async () => {}}
    approveAndMergeAction={async () => {}}
  />,
);
for (const expected of ["Waiting for merge", "Pending merge", "Approve/Merge"]) {
  assert.match(openHtml, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `open row renders ${expected}`);
}

const pendingHtml = renderToStaticMarkup(
  <DeploymentTab
    mode="task"
    title="Dirty task"
    deploymentStatus="Deployment Approved"
    rows={[{
      id: "pr-local",
      provider: "bitbucket",
      providerPrId: "pending-local:task:task1:task1",
      url: "",
      sourceBranch: "feature/dirty",
      targetBranch: "main",
      latestCommitSha: "abcdef1234567890",
      status: "local_changes_pending_approval",
      localChangeSummary: " M ai/web/app/page.tsx",
      updatedAt: new Date("2026-06-04T00:00:00Z"),
    }]}
    canAct={() => true}
    approveLocalChangesAction={async () => {}}
    approveAndMergeAction={async () => {}}
  />,
);
for (const expected of [
  "Local commit approval needed",
  "Waiting for local commit approval",
  "Uncommitted local changes",
  "Approve local commit",
]) {
  assert.match(pendingHtml, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `renders ${expected}`);
}

// No rows → an honest empty state, never a synthetic PR row with live buttons.
const taskHtml = renderToStaticMarkup(
  <DeploymentTab
    mode="task"
    title="Top-level task"
    deploymentStatus="Deployment Approved"
    rows={[]}
    canAct={() => false}
  />,
);
assert.match(taskHtml, /Top-level task PR/, "renders task single-row mode");
assert.match(taskHtml, /No deployment PRs yet/, "renders the empty state when no PR exists yet");
assert.doesNotMatch(taskHtml, /work branch pending/, "no fabricated mock row");
assert.doesNotMatch(taskHtml, /Approve\/Merge/, "empty state exposes no action button");

const notRequiredHtml = renderToStaticMarkup(
  <DeploymentTab
    mode="epic"
    title="Docs epic"
    deploymentStatus="Not Required"
    rows={[]}
    canAct={() => false}
  />,
);
assert.match(notRequiredHtml, /deployment is not required for this Epic/, "renders the not-required empty state");

console.log("deployment-tab-test ok");
