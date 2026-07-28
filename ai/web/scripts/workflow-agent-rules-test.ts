import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  branchNameFromWorkItemKey,
  effectiveEpicBranchName,
  effectiveTaskBranchName,
} from "../lib/work-items/branches";
import { effectiveCommitPrefix, effectiveTaskCommitPrefix } from "../lib/work-items/keys";
import { subjectHasCommitPrefix } from "../lib/work-items/commit-prefix";
import { checkStatusTransition } from "../lib/workflow";

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

// Own branch per task: an Epic child with no explicit override works on its own
// key-derived branch (not the shared Epic branch) so independent Epic tasks run
// in parallel across agents. An explicit Task branch still wins; a keyless
// legacy task falls back to the Epic branch.
const taskWithChangingEpic = {
  workItemKey: "V23-3",
  branchName: null,
  epic: { workItemKey: "V23-2", branchName: "epic-before" },
};
assert(
  effectiveTaskBranchName(taskWithChangingEpic) === "v23-3",
  "an Epic child without an override uses its own work-item branch (parallel per-task branches)",
);
taskWithChangingEpic.epic.branchName = "epic-after";
assert(
  effectiveTaskBranchName(taskWithChangingEpic) === "v23-3",
  "an Epic branch change must not move a child that owns a key-derived branch",
);
assert(
  effectiveTaskBranchName({ ...taskWithChangingEpic, branchName: "task-override" }) === "task-override",
  "an explicit Task branch must override its Epic",
);
assert(
  effectiveTaskBranchName({ workItemKey: "V23-3", branchName: null, epic: { workItemKey: "V23-2", branchName: null } }) === "v23-3",
  "an Epic child without explicit branches uses its own human-key branch",
);
assert(
  effectiveTaskBranchName({ workItemKey: "V23-3", branchName: null, epic: null }) === "v23-3",
  "a standalone Task without an explicit branch must use its human key",
);
assert(
  effectiveTaskBranchName({ workItemKey: null, branchName: null, epic: { workItemKey: "V23-2", branchName: "epic-branch" } }) === "epic-branch",
  "a legacy Task without its own key falls back to the Epic branch",
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
assert(reviewAutomation.includes('status: "Done"'), "last Epic task completion must move the Epic to Done");
assert(reviewAutomation.includes("remainingOpenTasks === 0"), "the Epic Done rollup must only happen on the last open Epic task");

const taskNotifications = readFileSync(join(root, "lib/agents/workflow/notifications/task.ts"), "utf8");
assert(taskNotifications.includes("never edit a primary checkout"), "worktree guidance must prohibit primary-checkout edits");
assert(taskNotifications.includes("tag the reporter"), "worktree failure guidance must tell agents to tag the reporter");
assert(taskNotifications.includes("do not demand splitting for small or strictly sequential/dependent work"), "reviewer split-feedback rule must preserve small/sequential exception");

// --- 2026-07 workflow overhaul (P1-P6) ---

// P1: the Review → In Progress edge is abolished; Done → Review re-open stays.
assert(
  !checkStatusTransition({ from: "Review", to: "In Progress", actor: { id: "u1", kind: "human" } }).ok,
  "Review → In Progress must be an invalid transition (P1: no Review resume)",
);
assert(
  checkStatusTransition({ from: "Done", to: "Review", actor: { id: "u1", kind: "human" } }).ok,
  "Done → Review re-open edge must remain",
);

const taskWorkflowRoute = readFileSync(join(root, "app/api/agent/tasks/[taskId]/workflow/route.ts"), "utf8");
// start = To Do → In Progress only; the Review-resume branch is deleted.
assert(taskWorkflowRoute.includes('task.status !== "To Do"'), "workflow start must be allowed from To Do only");
assert(
  !taskWorkflowRoute.includes("To Do or Review before start"),
  "the start action must not accept tasks in Review (no resume path)",
);
assert(
  taskWorkflowRoute.includes("start cannot resume a task from Review"),
  "the start rejection must explain the review_feedback → To Do front flow",
);
// P4: start runs the shared per-project WIP + branch-clash gate.
assert(
  taskWorkflowRoute.includes("findInProgressStartConflict"),
  "workflow start must run the shared WIP/branch-clash gate before transition",
);
assert(
  taskWorkflowRoute.includes("1 In Progress task per agent per project"),
  "the WIP rejection must state the per-project limit so agents know what to finish",
);
// P3: ready_for_review is rejected while open implementation sub-tasks exist.
assert(
  taskWorkflowRoute.includes("openImplementationSubtasks"),
  "ready_for_review must reject when open implementation sub-tasks exist",
);
assert(
  taskWorkflowRoute.includes("ready_for_review rejected"),
  "the sub-task gate rejection must list the open items and how to clear them",
);
// PH-124 close-the-loop: ticking the last open implementation sub-task tells
// the agent to call ready_for_review with the same reusable token AND
// dispatches a belt-and-braces fresh workflow turn.
assert(
  taskWorkflowRoute.includes("allImplementationSubtasksComplete"),
  "complete_subtask must flag when the last implementation sub-task closes",
);
assert(
  taskWorkflowRoute.includes("call action=ready_for_review NOW with this same messageId and token"),
  "complete_subtask must instruct an immediate ready_for_review with the reusable token",
);
assert(
  taskWorkflowRoute.includes('reason: "ready_for_review_available"'),
  "complete_subtask must auto-dispatch a ready_for_review_available workflow turn",
);

// P4: the shared gate lives in auto-start and is per-project.
const autoStartLib = readFileSync(join(root, "lib/tasks/auto-start.ts"), "utf8");
assert(
  autoStartLib.includes("export async function findInProgressStartConflict"),
  "auto-start must export the shared In Progress entry gate",
);
assert(
  autoStartLib.includes("projectId: args.projectId"),
  "the shared WIP gate must scope the busy check to the task's project",
);
assert(
  autoStartLib.includes("findInProgressStartConflict(tx"),
  "auto-start must consume the shared gate inside its transaction",
);

// Ack is a liveness ping only — no status transition anywhere.
const ackRoute = readFileSync(join(root, "app/api/tasks/[id]/ack/route.ts"), "utf8");
assert(!ackRoute.includes("autoTransitionOnAck"), "ack must not consult the removed auto-transition rule");
assert(!ackRoute.includes("task.update"), "ack must not write task status");
assert(ackRoute.includes("transitioned: false"), "ack must always report transitioned: false");
const workflowLib = readFileSync(join(root, "lib/workflow.ts"), "utf8");
assert(!workflowLib.includes("export function autoTransitionOnAck"), "lib/workflow must not export the ack auto-transition");

// P5: one shared Review-entry handoff, called by the agent route AND every
// human board-move surface, with the epicChild fields the verifier consumes.
const reviewHandoff = readFileSync(join(root, "lib/tasks/review-handoff.ts"), "utf8");
assert(reviewHandoff.includes("export async function runTaskReviewHandoff"), "review-handoff must export runTaskReviewHandoff");
assert(reviewHandoff.includes("epicChild"), "the verify job must carry epicChild");
assert(reviewHandoff.includes("epicBranch"), "the verify job must carry epicBranch");
assert(reviewHandoff.includes("preferUserId"), "the Review refill must prefer the freed worker");
assert(taskWorkflowRoute.includes("runTaskReviewHandoff"), "the agent workflow route must use the shared Review handoff");
for (const pagePath of [
  "app/(app)/projects/[slug]/page.tsx",
  "app/(app)/projects/[slug]/tasks/[taskId]/page.tsx",
  "app/(app)/workspaces/[slug]/page.tsx",
  "app/(app)/workspaces/(landing)/page.tsx",
]) {
  const pageSource = readFileSync(join(root, pagePath), "utf8");
  assert(pageSource.includes("runTaskReviewHandoff"), `${pagePath} must run the shared Review handoff on human moves to Review`);
  assert(pageSource.includes("human-board-move"), `${pagePath} must audit human moves with via: human-board-move`);
}

// request-workflow-turn: PM-bearer-authenticated self-service turn re-arm.
const requestTurnRoute = readFileSync(join(root, "app/api/agent/tasks/[taskId]/request-workflow-turn/route.ts"), "utf8");
assert(requestTurnRoute.includes("authorizePmChannelCallback"), "request-workflow-turn must reuse the PM-channel bearer auth");
assert(requestTurnRoute.includes("task.workflow.turn_requested"), "request-workflow-turn must log an ActivityLog row");
assert(requestTurnRoute.includes("ready_for_review_available"), "request-workflow-turn must arm ready_for_review from In Progress");
assert(taskNotifications.includes("request-workflow-turn"), "the standing workflow rules must advertise request-workflow-turn");

// P1 wording: no Review-resume instructions survive; review_feedback returns
// the task to the FRONT of To Do.
assert(
  !taskNotifications.includes("call action=start to move it back to In Progress"),
  "the standing rules must not instruct a Review resume via start",
);
assert(
  taskNotifications.includes("FRONT of To Do"),
  "review_feedback wording must send the task to the front of To Do",
);
// P6 wording: epic children commit locally and never push.
assert(taskNotifications.includes("NEVER push this branch to origin"), "epic-child commit hygiene must forbid origin pushes");

// onlyReportersCanApprovePullRequests: the Development-section approve
// actions enforce the flag server-side (reporter-only when set).
const deployActions = readFileSync(join(root, "lib/deploy/actions.ts"), "utf8");
assert(
  deployActions.includes("onlyReportersCanApprovePullRequests ? isReporter : isReporter || isReviewer"),
  "deployment PR approval must be reporter-only server-side when the project flag is set",
);

console.log("workflow-agent-rules-test passed");
