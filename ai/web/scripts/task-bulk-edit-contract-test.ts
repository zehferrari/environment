import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const controls = read("components/task-bulk-edit-controls.tsx");
const board = read("app/(app)/projects/[slug]/board-client.tsx");
const projectPage = read("app/(app)/projects/[slug]/page.tsx");
const epicTasks = read("app/(app)/projects/[slug]/epics/[epicId]/epic-tasks-client.tsx");
const epicPage = read("app/(app)/projects/[slug]/epics/[epicId]/page.tsx");
const epicActions = read("lib/epics/actions.ts");
const bulkRoles = read("lib/tasks/bulk-roles.ts");
const moveStatus = read("lib/tasks/move-status.ts");

for (const field of ["status", "assigneeId", "actingManagerId", "reporterId"]) {
  assert(
    controls.includes(`value="${field}"`),
    `bulk task editor must expose ${field}`,
  );
}
assert(controls.includes("<AvatarCombobox"), "role targets must use the searchable principal picker");

assert(board.includes("<TaskBulkEditControls"), "Board selection toolbar must render the bulk editor");
assert(board.includes("bulkUpdateTaskRole(ids, projectSlug"), "Board must persist bulk role changes");
assert(board.includes("bulkMoveSelected(value)"), "Board bulk status must use the existing transition path");
assert(
  board.includes("? [mobileBacklogLane, ...columnLanes]"),
  "mobile Backlog must render before workflow columns",
);
assert(
  board.includes("md:order-first md:block 4xl:hidden"),
  "desktop Backlog must be ordered before workflow columns",
);
assert(projectPage.includes("canManageTaskRoles={viewer.isOwner}"), "project Board roles must be owner-gated");
assert(projectPage.includes("roleOptions={viewer.isOwner ? principals.map"), "project Board must receive assignable principals");

assert(epicTasks.includes("<TaskBulkEditControls"), "Epic Tasks selection toolbar must render the bulk editor");
assert(
  epicTasks.includes("overrideEpicTaskStatuses(ids, value, projectSlug, epicId)"),
  "Epic bulk status must use the typed human-override adapter",
);
assert(epicTasks.includes("bulkUpdateTaskRole(ids, projectSlug"), "Epic Tasks must persist bulk role changes");
assert(epicPage.includes("roleOptions={viewer.isOwner ? principalOptions : []}"), "Epic Tasks must receive owner-visible principals");

assert(bulkRoles.includes("const actor = await requireOwner()"), "bulk role writes must require the owner");
assert(bulkRoles.includes("tasks.length !== requestedIds.length"), "bulk role writes must reject partial task access");
assert(bulkRoles.includes("candidate.agent?.role === \"coding\""), "bulk role targets must enforce the assignable-principal policy");
assert(epicActions.includes('intent: "override_status"'), "Epic bulk status must submit the canonical human-override command");
assert(epicActions.includes("submitWorkflowCommandInTransaction(tx"), "Epic bulk status commands must stay inside the atomic batch transaction");
assert(!moveStatus.includes("function moveTaskStatus"), "generic move-status must remain non-writing");

console.log("task bulk-edit contract tests passed");
