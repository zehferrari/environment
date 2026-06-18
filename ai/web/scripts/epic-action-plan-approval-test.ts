import assert from "node:assert/strict";
import { buildEpicActionPlanApprovalUpdate } from "../lib/epics/action-plan-approval";

const approvedAt = new Date("2026-06-17T11:49:46.196Z");
const actorId = "actor-1";

{
  const update = buildEpicActionPlanApprovalUpdate({ currentStatus: "Backlog", approvedAt, actorId });
  assert.equal(update.promotedToInProgress, true);
  assert.deepEqual(update.data, {
    approvedOn: approvedAt,
    approvedById: actorId,
    status: "In Progress",
    statusChangedAt: approvedAt,
  });
}

{
  const update = buildEpicActionPlanApprovalUpdate({ currentStatus: "In Progress", approvedAt, actorId });
  assert.equal(update.promotedToInProgress, false);
  assert.deepEqual(update.data, {
    approvedOn: approvedAt,
    approvedById: actorId,
  });
}

for (const currentStatus of ["Ready to Deploy", "Done"] as const) {
  const update = buildEpicActionPlanApprovalUpdate({ currentStatus, approvedAt, actorId });
  assert.equal(update.promotedToInProgress, false, currentStatus);
  assert.deepEqual(update.data, {
    approvedOn: approvedAt,
    approvedById: actorId,
  });
}

console.log("epic-action-plan-approval-test passed");
