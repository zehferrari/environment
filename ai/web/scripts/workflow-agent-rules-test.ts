import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchNameFromWorkItemKey,
  effectiveEpicBranchName,
  effectiveTaskBranchName,
} from "../lib/work-items/branches";
import { effectiveCommitPrefix, effectiveTaskCommitPrefix } from "../lib/work-items/keys";
import { subjectHasCommitPrefix } from "../lib/work-items/commit-prefix";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  branchNameFromWorkItemKey("V23-3") === "v23-3",
  "work-item branch fallback must preserve the human key and normalize its case",
);
assert(
  effectiveEpicBranchName({ workItemKey: "V23-2", branchName: "workflow-update" }) === "workflow-update",
  "existing Epic branch must win",
);
assert(
  effectiveEpicBranchName({ workItemKey: "V23-2", branchName: "" }) === "v23-2",
  "empty Epic branch must fall back to its human work-item key",
);
assert(
  effectiveEpicBranchName({ workItemKey: null, branchName: "" }) === null,
  "legacy Epics without a human key must not leak their database id into a branch",
);

const taskWithChangingEpic = {
  workItemKey: "V23-3",
  branchName: null,
  epic: { workItemKey: "V23-2", branchName: "epic-before" },
};
assert(
  effectiveTaskBranchName(taskWithChangingEpic) === "epic-before",
  "an Epic child without an override must inherit the explicit Epic branch",
);
taskWithChangingEpic.epic.branchName = "epic-after";
assert(
  effectiveTaskBranchName(taskWithChangingEpic) === "epic-after",
  "an Epic branch change must propagate while the child override stays null",
);
assert(
  effectiveTaskBranchName({ ...taskWithChangingEpic, branchName: "task-override" }) === "task-override",
  "an explicit Task branch must override its Epic",
);
assert(
  effectiveTaskBranchName({ workItemKey: "V23-3", branchName: null, epic: { workItemKey: "V23-2", branchName: null } }) === "v23-2",
  "an Epic child without explicit branches must inherit the Epic human-key branch",
);
assert(
  effectiveTaskBranchName({ workItemKey: "V23-3", branchName: null, epic: null }) === "v23-3",
  "a standalone Task without an explicit branch must use its human key",
);
assert(
  effectiveTaskBranchName({ workItemKey: "V23-3", branchName: null, epic: { workItemKey: null, branchName: null } }) === "v23-3",
  "a Task must use its own human key when its legacy Epic has no usable branch key",
);

assert(
  effectiveTaskCommitPrefix({ workItemKey: "V23-3", commitPrefix: "TASK", epic: { commitPrefix: "EPIC" } }) === "TASK",
  "an explicit Task commit prefix must win",
);
assert(
  effectiveTaskCommitPrefix({ workItemKey: "V23-3", commitPrefix: null, epic: { commitPrefix: "EPIC" } }) === "EPIC",
  "an Epic child without an override must inherit the explicit Epic commit prefix",
);
assert(
  effectiveTaskCommitPrefix({ workItemKey: "V23-3", commitPrefix: null, epic: { commitPrefix: null } }) === "V23-3",
  "a Task without an explicit Task or Epic prefix must use its human key",
);
assert(
  effectiveTaskCommitPrefix({ workItemKey: null, commitPrefix: null, epic: { commitPrefix: null } }) === null,
  "legacy Tasks without a human key must not use their database id as a prefix",
);
assert(
  effectiveCommitPrefix({ commitPrefix: null, workItemKey: "V23-2" }) === "V23-2",
  "an Epic commit prefix must fall back to its human key",
);
assert(subjectHasCommitPrefix("V23-3 Add GreenID client", "V23-3"), "a space-delimited human key must match");
assert(subjectHasCommitPrefix("V23-3: Add GreenID client", "V23-3"), "a colon-delimited human key must match");
assert(!subjectHasCommitPrefix("V23-30 Add another task", "V23-3"), "a longer human key must not satisfy a shorter prefix");

const root = process.cwd();
const workflowRoute = readFileSync(join(root, "app/api/agent/epics/[epicId]/workflow/route.ts"), "utf8");
assert(!workflowRoute.includes("effectiveEpicBranchName(epic)"), "Epic manager workflow must not persist a generated branch");
assert(workflowRoute.includes("branchName: null"), "Epic-created Tasks must keep a null branch override");
assert(workflowRoute.includes("commitPrefix: null"), "Epic-created Tasks must keep a null commit-prefix override");

const proposalApply = readFileSync(join(root, "lib/work-items/apply.ts"), "utf8");
assert(!proposalApply.includes("inheritedBranchName"), "proposal-created Tasks must not copy an Epic branch");
assert(!proposalApply.includes("inheritedCommitPrefix"), "proposal-created Tasks must not copy an Epic prefix");
assert(proposalApply.includes("branchName: null"), "proposal-created Tasks must retain a null branch override");
assert(proposalApply.includes("commitPrefix: null"), "proposal-created Tasks must retain a null prefix override");

const epicActions = readFileSync(join(root, "lib/epics/actions.ts"), "utf8");
assert(!epicActions.includes("effectiveEpicBranchName(epic)"), "UI-created Epic Tasks must not persist a generated Epic branch");
assert(epicActions.includes("branchName: null"), "UI-created Epic Tasks must retain a null branch override");
assert(epicActions.includes("commitPrefix: null"), "UI-created Epic Tasks must retain a null prefix override");

const projectPage = readFileSync(join(root, "app/(app)/projects/[slug]/page.tsx"), "utf8");
assert(projectPage.includes("branchName: null"), "board-created Tasks must retain a null branch override");
assert(projectPage.includes("commitPrefix: null"), "board-created Tasks must retain a null prefix override");

const taskPage = readFileSync(join(root, "app/(app)/projects/[slug]/tasks/[taskId]/page.tsx"), "utf8");
assert(taskPage.includes("data.branchName = newBranch"), "clearing a Task branch override must persist null, not a copied fallback");
assert(taskPage.includes("data.commitPrefix = newCommitPrefix"), "clearing a Task prefix override must persist null, not a copied fallback");
assert(taskPage.includes('defaultValue={task.branchName ?? ""}'), "the Task form must not submit an inherited branch as an override");
assert(taskPage.includes('defaultValue={task.commitPrefix ?? ""}'), "the Task form must not submit an inherited prefix as an override");

const reviewAutomation = readFileSync(join(root, "lib/tasks/review-automation.ts"), "utf8");
assert(reviewAutomation.includes('status: "Ready to Deploy"'), "last Epic task completion must promote the Epic to Ready to Deploy");
assert(reviewAutomation.includes("remainingOpenTasks === 0"), "Ready to Deploy promotion must only happen on the last open Epic task");

const taskNotifications = readFileSync(join(root, "lib/agents/workflow/notifications/task.ts"), "utf8");
assert(taskNotifications.includes("never edit a primary checkout"), "worktree guidance must prohibit primary-checkout edits");
assert(taskNotifications.includes("tag the reporter"), "worktree failure guidance must tell agents to tag the reporter");
assert(taskNotifications.includes("do not demand splitting for small or strictly sequential/dependent work"), "reviewer split-feedback rule must preserve small/sequential exception");

console.log("workflow-agent-rules-test passed");
