// ENV-164 — UI flow coverage for the combined role+access invitation/edit
// flow (app/(app)/system/users/access-forms.tsx). Mirrors the static-render
// pattern of user-lifecycle-controls-test.tsx: role copy must explain what
// each role can see and do, Admins get no role selector, and high-impact
// changes render an explicit confirmation summary.

import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import InviteUsersForm, { AccessChangeSummary, EditAccessForm } from "../app/(app)/system/users/access-forms";

const projects = [
  { id: "p1", name: "Alpha", slug: "alpha", archivedAt: null },
  { id: "p2", name: "Beta", slug: "beta", archivedAt: null },
];

const ownerInvite = renderToStaticMarkup(
  <InviteUsersForm projects={projects} canAssignRoles={true} />,
);
assert.match(ownerInvite, /name="role"/, "owner invite form offers the role selector");
assert.match(
  ownerInvite,
  /Customers see only the projects they are granted/,
  "role copy explains what Customers can see",
);
assert.match(
  ownerInvite,
  /Admins manage Customers and project access inside their own projects/,
  "role copy explains what Admins can do",
);

const adminInvite = renderToStaticMarkup(
  <InviteUsersForm projects={projects} canAssignRoles={false} />,
);
assert.doesNotMatch(adminInvite, /name="role"/, "admin invite form has no role selector");
assert.match(adminInvite, /New users join as/, "admin invite form explains the fixed Customer role");

const grantOnly = renderToStaticMarkup(
  <EditAccessForm
    user={{ id: "u1", username: "pat", displayName: "Pat", role: "customer", projectIds: ["p1"] }}
    projects={projects}
    canAssignRoles={true}
  />,
);
assert.match(grantOnly, /name="userId"/, "edit form carries the target user id");
assert.doesNotMatch(
  grantOnly,
  /Confirm this high-impact change/,
  "grant-only edits do not demand confirmation",
);

const summary = renderToStaticMarkup(
  <AccessChangeSummary
    username="pat"
    role={{ from: "customer", to: "admin" }}
    addedProjectNames={["Beta"]}
    removedProjectNames={["Alpha"]}
  />,
);
assert.match(summary, /Confirm this high-impact change for @pat/, "summary names the affected user");
assert.match(summary, /customer → admin/, "summary shows the role change");
assert.match(summary, /Revokes access to:.*Alpha/s, "summary lists revoked projects");
assert.match(summary, /Grants access to:.*Beta/s, "summary lists granted projects");

console.log("access-flow-test: ok");
