import assert from "node:assert/strict";
import { addDeploymentCount, deploymentRollupsByProject, emptyDeploymentRollup, mergeDeploymentRollup } from "@/lib/workspaces/deployment-rollup";

function run() {
  const rollup = emptyDeploymentRollup();
  addDeploymentCount(rollup, "Deployment Approved", 2);
  addDeploymentCount(rollup, "Successfully Deployed", 1);
  addDeploymentCount(rollup, "Unknown", 99);
  addDeploymentCount(rollup, "Deployment Error", 0);

  assert.equal(rollup.total, 3, "known positive deployment statuses count toward the total");
  assert.equal(rollup.counts["Deployment Approved"], 2);
  assert.equal(rollup.counts["Successfully Deployed"], 1);
  assert.equal(rollup.counts["Deployment Error"], 0);

  const projectRollups = deploymentRollupsByProject(["p1", "p2"], [
    { projectId: "p1", deploymentStatus: "Not Required", _count: { _all: 4 } },
    { projectId: "p1", deploymentStatus: "Deployment Error", _count: { _all: 1 } },
    { projectId: "p2", deploymentStatus: "Deployment Approved", _count: { _all: 3 } },
    { projectId: "outside", deploymentStatus: "Successfully Deployed", _count: { _all: 7 } },
  ]);

  assert.equal(projectRollups.get("p1")?.total, 5, "project p1 aggregates its visible deployment rows");
  assert.equal(projectRollups.get("p1")?.counts["Not Required"], 4);
  assert.equal(projectRollups.get("p1")?.counts["Deployment Error"], 1);
  assert.equal(projectRollups.get("p2")?.total, 3, "project p2 aggregates independently");
  assert.equal(projectRollups.get("p2")?.counts["Deployment Approved"], 3);

  const workspace = mergeDeploymentRollup(emptyDeploymentRollup(), projectRollups.get("p1")!);
  mergeDeploymentRollup(workspace, projectRollups.get("p2")!);
  assert.equal(workspace.total, 8, "workspace rollup sums project rollups");
  assert.equal(workspace.counts["Not Required"], 4);
  assert.equal(workspace.counts["Deployment Approved"], 3);
  assert.equal(workspace.counts["Deployment Error"], 1);
}

run();
console.log("workspace-deployment-rollup-test passed");
