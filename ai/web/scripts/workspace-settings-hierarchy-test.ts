import assert from "node:assert/strict";
import { buildEffectiveProjectSettings, type WorkspaceDefaults } from "../lib/settings/effective";
import type { SystemSettingsValues } from "../lib/settings/system";
import { DEFAULT_PROFILE_IMAGE_PROMPT } from "../lib/agents/management/profile-image-options";
import { DEFAULT_DEPLOY_REVIEW_PROMPT } from "../lib/epics/deploy-review";

const system: SystemSettingsValues = {
  defaultGitUserName: "System Name",
  defaultGitUserEmail: "system@example.test",
  doneTtlDays: 10,
  binTtlDays: null,
  theme: "light",
  openRouterApiKey: null,
  hasOpenRouterApiKey: false,
  openRouterReferer: null,
  openRouterTitle: null,
  profileImagePrompt: DEFAULT_PROFILE_IMAGE_PROMPT,
  deployReviewPrompt: "system deploy review",
  integrationDefaults: JSON.stringify({ jira: { host: "system" }, shared: "system" }),
  hourlyRateCents: null,
  billingCurrency: null,
};

const workspace: WorkspaceDefaults = {
  id: "w1",
  slug: "workspace",
  name: "Workspace",
  defaultGitUserName: "Workspace Name",
  defaultGitUserEmail: "workspace@example.test",
  doneTtlDays: 20,
  deploymentProvider: "bitbucket",
  deploymentProductionBranch: "release",
  deploymentPrTargetBranch: "develop",
  deploymentMode: "pipeline",
  deploymentOnMerge: null,
  deploymentPipelineName: "workspace-pipeline",
  deploymentHost: "x1",
  deploymentEnvironment: "staging",
  deploymentBitbucketWorkspace: "bb-workspace",
  deploymentBitbucketRepoSlug: "repo",
  integrationDefaults: JSON.stringify({ jira: { host: "workspace" }, bitbucket: { workspace: "bb-workspace" } }),
};

const inherited = buildEffectiveProjectSettings({
  id: "p1",
  defaultGitUserName: null,
  defaultGitUserEmail: null,
  doneTtlDays: null,
  deploymentProductionBranch: null,
  deploymentPrTargetBranch: null,
}, workspace, system);
assert.equal(inherited.gitIdentity.name.value, "Workspace Name");
assert.equal(inherited.gitIdentity.name.source, "workspace");
assert.equal(inherited.doneTtlDays.value, 20);
assert.equal(inherited.deployment.productionBranch.value, "release");
assert.equal(inherited.deployment.prTargetBranch.value, "develop");
assert.deepEqual(inherited.integrationDefaults.value, { jira: { host: "workspace" }, shared: "system", bitbucket: { workspace: "bb-workspace" } });
assert.equal(inherited.integrationDefaults.source, "workspace");
assert.equal(inherited.deployReviewPrompt.value, "system deploy review");
assert.equal(inherited.deployReviewPrompt.source, "system");

const overridden = buildEffectiveProjectSettings({
  id: "p1",
  defaultGitUserName: "Project Name",
  defaultGitUserEmail: "project@example.test",
  doneTtlDays: 30,
  deploymentProductionBranch: "main",
  deploymentPrTargetBranch: "main",
  integrationDefaults: JSON.stringify({ jira: { host: "project" } }),
  deployReviewPrompt: "project deploy review",
}, workspace, system);
assert.equal(overridden.gitIdentity.name.value, "Project Name");
assert.equal(overridden.gitIdentity.name.source, "project");
assert.equal(overridden.doneTtlDays.value, 30);
assert.equal(overridden.deployment.productionBranch.value, "main");
assert.deepEqual(overridden.integrationDefaults.value, { jira: { host: "project" }, shared: "system", bitbucket: { workspace: "bb-workspace" } });
assert.equal(overridden.integrationDefaults.source, "project");
assert.equal(overridden.deployReviewPrompt.value, "project deploy review");
assert.equal(overridden.deployReviewPrompt.source, "project");

const fallback = buildEffectiveProjectSettings({
  defaultGitUserName: null,
  defaultGitUserEmail: null,
  doneTtlDays: null,
}, null, { ...system, defaultGitUserName: null, defaultGitUserEmail: null, doneTtlDays: null, integrationDefaults: null, deployReviewPrompt: DEFAULT_DEPLOY_REVIEW_PROMPT });
assert.equal(fallback.gitIdentity.name.value, null);
assert.equal(fallback.gitIdentity.name.source, "fallback");
assert.equal(fallback.doneTtlDays.value, 5);
assert.equal(fallback.doneTtlDays.source, "fallback");
assert.equal(fallback.deployReviewPrompt.value, DEFAULT_DEPLOY_REVIEW_PROMPT);

console.log("workspace settings hierarchy ok");
