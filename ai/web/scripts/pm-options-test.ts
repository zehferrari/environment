import assert from "node:assert/strict";
import { findPmOptionResolution, isPmOptionsTargetedAtCurrentUser, parsePmOptions } from "../lib/pm-options";

const parsed = parsePmOptions("Please choose:\n\n```pm-options\nid | label\nyes | Yes, ship it\nno | No \\| revise\n```\n");
assert.equal(parsed.body, "Please choose:");
assert.deepEqual(parsed.options, [
  { id: "yes", label: "Yes, ship it" },
  { id: "no", label: "No | revise" },
]);

const ignoredMiddleFence = parsePmOptions("```pm-options\nyes | Yes\n```\n\nNot trailing");
assert.equal(ignoredMiddleFence.options.length, 0);
assert.equal(ignoredMiddleFence.body, "```pm-options\nyes | Yes\n```\n\nNot trailing");

assert.equal(
  findPmOptionResolution(parsed.options, ["Something else", "No | revise\n\nThanks"])?.id,
  "no",
);
assert.equal(findPmOptionResolution(parsed.options, ["unknown"]), null);

assert.equal(isPmOptionsTargetedAtCurrentUser({ currentUserId: "u1", targetType: "user", targetValue: "user:u1" }), true);
assert.equal(isPmOptionsTargetedAtCurrentUser({ currentUserId: "u1", targetType: "user", targetValue: "user:u2" }), false);
assert.equal(isPmOptionsTargetedAtCurrentUser({ currentUserId: "u1", targetType: "multi", targetValue: JSON.stringify(["agent:a", "user:u1"]) }), true);
assert.equal(isPmOptionsTargetedAtCurrentUser({ currentUserId: "u1", targetType: "agent", targetValue: "agent:a" }), false);

console.log("pm-options parser tests passed");
