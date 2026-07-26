import assert from "node:assert/strict";
import { buildEpicActionPlanApprovalUpdate } from "../lib/epics/action-plan-approval";

const approvedAt = new Date("2026-06-17T11:49:46.196Z");
const actorId = "actor-1";

{
  // Approving a Backlog epic's plan promotes it to To Do (approved to execute),
  // NOT straight to In Progress — the epic flips to In Progress only when a
  // child task actually starts.
  const update = buildEpicActionPlanApprovalUpdate({ currentStatus: "Backlog", approvedAt, actorId });
  assert.equal(update.promoted, true);
  assert.deepEqual(update.data, {
    approvedOn: approvedAt,
    approvedById: actorId,
    status: "To Do",
    statusChangedAt: approvedAt,
  });
}

for (const currentStatus of ["To Do", "In Progress", "Done"] as const) {
  const update = buildEpicActionPlanApprovalUpdate({ currentStatus, approvedAt, actorId });
  assert.equal(update.promoted, false, currentStatus);
  assert.deepEqual(update.data, {
    approvedOn: approvedAt,
    approvedById: actorId,
  });
}

console.log("epic-action-plan-approval-test passed");
