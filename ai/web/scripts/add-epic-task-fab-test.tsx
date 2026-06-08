import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AddEpicTaskFab, {
  type AddEpicTaskState,
  addEpicTaskDisabledReason,
} from "../app/(app)/projects/[slug]/epics/[epicId]/add-epic-task-fab";

async function createTaskAction(
  _state: AddEpicTaskState,
  _formData: FormData,
): Promise<AddEpicTaskState> {
  return { ok: false, error: "Only the Epic acting manager can create the initial Epic task breakdown." };
}

assert.equal(
  addEpicTaskDisabledReason("@manager"),
  "Only @manager can create the initial Epic task breakdown.",
  "names the acting manager when the viewer cannot create the Epic task breakdown",
);
assert.equal(
  addEpicTaskDisabledReason(null),
  "Only the Epic acting manager can create the initial Epic task breakdown.",
  "falls back to a generic acting-manager permission message",
);

const disabledHtml = renderToStaticMarkup(
  <AddEpicTaskFab
    projectSlug="project"
    epicId="epic-1"
    createTaskAction={createTaskAction}
    canCreateTask={false}
    actingManagerName="@manager"
  />,
);

assert.match(disabledHtml, /disabled=""/, "non-acting-manager FAB is disabled");
assert.match(disabledHtml, /Only @manager can create the initial Epic task breakdown\./, "disabled FAB exposes permission reason");
assert.doesNotMatch(disabledHtml, /Add task to epic/, "disabled FAB aria/title does not imply the action is available");

const enabledHtml = renderToStaticMarkup(
  <AddEpicTaskFab
    projectSlug="project"
    epicId="epic-1"
    createTaskAction={createTaskAction}
    canCreateTask={true}
    actingManagerName="@manager"
  />,
);

assert.doesNotMatch(enabledHtml, /disabled=""/, "acting manager FAB is enabled");
assert.match(enabledHtml, /Add task to epic/, "enabled FAB advertises the available action");

console.log("add-epic-task-fab-test ok");
