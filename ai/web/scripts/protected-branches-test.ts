import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isProtectedBranch,
  normalizeBranchList,
  parseProtectedBranches,
  serializeProtectedBranches,
} from "../lib/projects/protected-branches";

assert.deepEqual(normalizeBranchList([" main ", "MAIN", "release/stable", ""]), ["main", "release/stable"]);
assert.equal(serializeProtectedBranches(["main", "release/stable"]), '["main","release/stable"]');
assert.equal(serializeProtectedBranches([" "]), null);
assert.deepEqual(parseProtectedBranches('["main","release/stable"]'), ["main", "release/stable"]);
assert.deepEqual(parseProtectedBranches("not json"), []);
assert.equal(isProtectedBranch('["main"]', "MAIN"), true);
assert.equal(isProtectedBranch('["main"]', "feature/env-106"), false);
assert.throws(() => normalizeBranchList(["../main"]), /Protected branches/);

const workflowRoute = readFileSync("app/api/agent/tasks/[taskId]/workflow/route.ts", "utf8");
assert(workflowRoute.includes("isProtectedBranch(task.project.agentChangeBlockedBranches, branchName)"), "ready_for_review must reject protected effective branches before Review hand-off");
assert(workflowRoute.includes("protectedBranches: parseProtectedBranches"), "ready_for_review rejection should expose the configured protected branch list");

const verifier = readFileSync("scripts/pm-verify-branch-pushed.ts", "utf8");
assert(verifier.includes('reason: "protected-agent-branch"'), "monitor verifier must report protected branch failures distinctly");
assert(verifier.includes("validateOriginBase"), "monitor verifier must validate task branches against the resolved base");
assert(verifier.includes("baseValidation.ok"), "base-branch validation must be part of the monitor review gate");
assert(verifier.includes("baseValidation.baseBranch"), "monitor output must identify the resolved base branch");
assert(verifier.includes("origin/${baseBranch}..origin/${branch}"), "commit-prefix verification must only scan feature commits after the resolved base");
assert(!verifier.includes('"-n", "20"'), "shared Epic branches must not lose older child commits to a fixed log cap");
assert(verifier.includes("const state = await localState(job);"), "a missing remote branch must not prevent the monitor from checking/pushing a clean local branch");

const branchBase = readFileSync("lib/deploy/branch-base.ts", "utf8");
assert(branchBase.includes('"merge-base", `origin/${baseBranch}`'), "monitor verifier must compare against the resolved base branch");
assert(branchBase.includes('addCandidate(candidates, "master")'), "legacy jobs must safely fall back to master when main is absent");

assert(workflowRoute.includes("baseBranch,"), "ready_for_review jobs must snapshot the effective project PR target branch");

const settingsPage = readFileSync("app/(app)/projects/[slug]/settings/page.tsx", "utf8");
assert(settingsPage.includes("<BranchMultiCombobox"), "Project Settings deployment tab should render the branch multi-select combobox");
assert(settingsPage.includes('name="agentChangeBlockedBranch"'), "combobox inputs must post protected branch values");

console.log("protected-branches-test passed");
