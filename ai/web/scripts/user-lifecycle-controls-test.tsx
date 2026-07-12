import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UserLifecycleControls from "../app/(app)/system/users/user-lifecycle-controls";

function renderControls(props: {
  protectedAccount: boolean;
  removable: boolean;
}) {
  return renderToStaticMarkup(
    <UserLifecycleControls
      userId="user-1"
      username="member"
      status="active"
      {...props}
    />,
  );
}

const protectedAccount = renderControls({ protectedAccount: true, removable: false });
assert.match(protectedAccount, /Updates this account(?:&#x27;|')s password immediately\./, "owner password form is direct");
assert.doesNotMatch(protectedAccount, /Temporary password|must rotate/i, "owner password form does not present a temporary-password flow");
assert.doesNotMatch(protectedAccount, /Disable account/, "unavailable disable control is omitted");
assert.doesNotMatch(protectedAccount, /Remove account/, "unavailable remove control is omitted");

const historyAccount = renderControls({ protectedAccount: false, removable: false });
assert.match(historyAccount, /Disable account/, "available disable control remains visible");
assert.doesNotMatch(historyAccount, /Remove account/, "unavailable remove control is omitted for accounts with history");

const removableAccount = renderControls({ protectedAccount: false, removable: true });
assert.match(removableAccount, /Disable account/, "removable accounts can still be disabled");
assert.match(removableAccount, /Remove account/, "removable accounts retain the removal control");

console.log("user-lifecycle-controls-test: ok");
