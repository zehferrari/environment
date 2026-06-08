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
      status: "failed",
      updatedAt: new Date("2026-06-04T00:00:00Z"),
      task: { workItemKey: "ENV-17", title: "Deployment tab UI" },
    }]}
    canAct={() => true}
  />,
);

for (const expected of [
  "Epic child PR rollup",
  "ENV-17: Deployment tab UI",
  "pm-deployments",
  "main",
  "abcdef123456",
  "Approved",
  "Waiting for merge",
  "Deploy script failed",
  "Deployment failed",
  "Approve",
  "Merge",
]) {
  assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `renders ${expected}`);
}

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
assert.match(taskHtml, /work branch pending/, "renders mocked pending record fields when no PR exists yet");

console.log("deployment-tab-test ok");
