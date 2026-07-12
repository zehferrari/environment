import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveEpicBranchName, effectiveEpicBranchName } from "../lib/work-items/branches";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const derived = deriveEpicBranchName({
  id: "ENV-104",
  title: "Workflow Update: Ready to Deploy / Worktrees ONLY!",
});
assert(
  derived === "env-104-workflow-update-ready-to-deploy-worktrees-only",
  `unexpected derived branch ${derived}`,
);
assert(
  effectiveEpicBranchName({ id: "cmqh9", title: "Workflow Update", branchName: "workflow-update" }) === "workflow-update",
  "existing Epic branch must win",
);
assert(
  effectiveEpicBranchName({ id: "cmqh9", title: "Workflow Update", branchName: "" }) === "cmqh9-workflow-update",
  "empty Epic branch must derive from id + title",
);

const root = process.cwd();
const workflowRoute = readFileSync(join(root, "app/api/agent/epics/[epicId]/workflow/route.ts"), "utf8");
assert(workflowRoute.includes("const branchName = effectiveEpicBranchName(epic);"), "Epic manager workflow must derive an Epic branch");
assert(workflowRoute.includes("branchName,"), "Epic-created tasks must inherit the resolved Epic branch");

const reviewAutomation = readFileSync(join(root, "lib/tasks/review-automation.ts"), "utf8");
assert(reviewAutomation.includes('status: "Ready to Deploy"'), "last Epic task completion must promote the Epic to Ready to Deploy");
assert(reviewAutomation.includes("remainingOpenTasks === 0"), "Ready to Deploy promotion must only happen on the last open Epic task");

const taskNotifications = readFileSync(join(root, "lib/agents/workflow/notifications/task.ts"), "utf8");
assert(taskNotifications.includes("never edit a primary checkout"), "worktree guidance must prohibit primary-checkout edits");
assert(taskNotifications.includes("tag the reporter"), "worktree failure guidance must tell agents to tag the reporter");
assert(taskNotifications.includes("do not demand splitting for small or strictly sequential/dependent work"), "reviewer split-feedback rule must preserve small/sequential exception");

console.log("workflow-agent-rules-test passed");
