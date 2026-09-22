import assert from "node:assert/strict";
import {
  canApproveActionPlanForActor,
  epicAllowsAgentAction,
  resolveReviewOwnerId,
  resolvePlanApproverId,
  canSetTaskDoneForActor,
} from "../lib/tasks/workflow-actors";
import {
  canApplySubmittedEpicStatus,
  epicStatusRevision,
} from "../lib/epics/status-concurrency";

const baseTask = {
  actingManagerId: null,
  reporterId: "reporter",
  project: null,
  epic: { status: "To Do", actingManagerId: "epic-manager" },
};

assert.equal(resolveReviewOwnerId(baseTask), "epic-manager", "To Do Epic manager reviews the first child plan");
assert.equal(
  resolveReviewOwnerId({ ...baseTask, epic: { ...baseTask.epic, status: "In Progress" } }),
  "epic-manager",
  "In Progress Epic manager remains the review owner",
);
assert.equal(
  resolveReviewOwnerId({ ...baseTask, epic: { ...baseTask.epic, status: "Backlog" } }),
  "reporter",
  "non-actionable Epic falls back to the reporter",
);
assert.equal(
  resolveReviewOwnerId({ ...baseTask, actingManagerId: "task-reviewer" }),
  "task-reviewer",
  "task reviewer remains first priority",
);
assert.equal(canApproveActionPlanForActor(baseTask, "epic-manager"), true);
const approvedEpicTask = {
  ...baseTask,
  assigneeId: "worker",
  project: { onlyReportersCanApproveActionPlans: true, onlyReportersCanSetTasksDone: true },
  epic: { ...baseTask.epic, approvedOn: new Date() },
};
assert.equal(canApproveActionPlanForActor(approvedEpicTask, "epic-manager"), true);
assert.equal(resolvePlanApproverId(approvedEpicTask), "epic-manager");
assert.equal(canApproveActionPlanForActor(approvedEpicTask, "reporter"), true);
assert.equal(canApproveActionPlanForActor(approvedEpicTask, "worker"), false);
assert.equal(canSetTaskDoneForActor(approvedEpicTask, "epic-manager"), false, "plan delegation does not delegate completion");
for (const task of [
  { ...approvedEpicTask, epic: null },
  { ...approvedEpicTask, epic: { ...approvedEpicTask.epic, approvedOn: null } },
  ...["Backlog", "Review", "Done"].map(status => ({ ...approvedEpicTask, epic: { ...approvedEpicTask.epic, status } })),
  { ...approvedEpicTask, assigneeId: "epic-manager" },
]) {
  assert.equal(canApproveActionPlanForActor(task, "epic-manager"), false);
  assert.equal(resolvePlanApproverId(task), "reporter");
}
assert.equal(epicAllowsAgentAction({ epic: { status: "To Do" } }), true);
assert.equal(epicAllowsAgentAction({ epic: { status: "Backlog" } }), false);

const firstRevisionAt = new Date("2026-07-30T05:15:49.705Z");
const laterRevisionAt = new Date("2026-07-30T05:27:56.000Z");
assert.equal(epicStatusRevision(firstRevisionAt), "2026-07-30T05:15:49.705Z");
assert.equal(
  canApplySubmittedEpicStatus({
    submittedRevision: epicStatusRevision(firstRevisionAt),
    currentStatusChangedAt: firstRevisionAt,
  }),
  true,
  "current editor may change status",
);
assert.equal(
  canApplySubmittedEpicStatus({
    submittedRevision: epicStatusRevision(firstRevisionAt),
    currentStatusChangedAt: laterRevisionAt,
  }),
  false,
  "stale editor cannot overwrite a newer status",
);
assert.equal(
  canApplySubmittedEpicStatus({ submittedRevision: null, currentStatusChangedAt: firstRevisionAt }),
  false,
  "status writes require a revision token",
);

console.log("epic-workflow-guards-test passed");
