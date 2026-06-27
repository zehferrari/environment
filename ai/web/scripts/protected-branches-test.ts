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
assert(workflowRoute.includes("isProtectedBranch(task.project.agentChangeBlockedBranches, task.branchName)"), "ready_for_review must reject protected agent branches before Review hand-off");
assert(workflowRoute.includes("protectedBranches: parseProtectedBranches"), "ready_for_review rejection should expose the configured protected branch list");

const verifier = readFileSync("scripts/pm-verify-branch-pushed.ts", "utf8");
assert(verifier.includes('reason: "protected-agent-branch"'), "monitor verifier must report protected branch failures distinctly");

const settingsPage = readFileSync("app/(app)/projects/[slug]/settings/page.tsx", "utf8");
assert(settingsPage.includes("<BranchMultiCombobox"), "Project Settings deployment tab should render the branch multi-select combobox");
assert(settingsPage.includes('name="agentChangeBlockedBranch"'), "combobox inputs must post protected branch values");

console.log("protected-branches-test passed");
