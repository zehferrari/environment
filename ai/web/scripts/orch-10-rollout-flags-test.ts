import assert from "node:assert/strict";
import {
  isV2MutationAdmissionEnabledForProject,
  orchestratorV2MutationProjects,
} from "@/lib/tasks/orchestrator/flags";

delete process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS;
assert.equal(orchestratorV2MutationProjects().size, 0);
assert.equal(isV2MutationAdmissionEnabledForProject("project"), false);
process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = "alpha,beta";
assert.equal(isV2MutationAdmissionEnabledForProject("alpha"), true);
assert.equal(isV2MutationAdmissionEnabledForProject("gamma"), false);
process.env.PM_ORCHESTRATOR_V2_MUTATION_PROJECTS = "*";
assert.equal(isV2MutationAdmissionEnabledForProject("any-project"), true);

console.log("[orch-10-rollout-flags] retained admission flag checks passed");
