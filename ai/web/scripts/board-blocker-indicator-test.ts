import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeFormalBlockerTaskIds } from "../lib/tasks/formal-blocker";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const occurrences = (source: string, value: string) => source.split(value).length - 1;

const activeBlockers = activeFormalBlockerTaskIds([
  { taskId: "cleared", kind: "task.blocker.cleared" },
  { taskId: "active", kind: "task.blocker" },
  { taskId: "extra", kind: "task.extra_work.blocker" },
  { taskId: "cleared", kind: "task.blocker" },
  { taskId: "generic-alert", kind: "task.alert_reporter" },
]);
assert.deepEqual(
  [...activeBlockers].sort(),
  ["active", "extra"],
  "only unresolved formal blocker lifecycles may paint the board icon",
);

for (const [path, label] of [
  ["app/(app)/projects/[slug]/page.tsx", "project board"],
  ["app/(app)/workspaces/[slug]/page.tsx", "workspace board"],
  ["app/(app)/workspaces/(landing)/page.tsx", "workspace landing board"],
] as const) {
  const source = read(path);
  assert(
    source.includes("activeFormalBlockerTaskIds(taskActivityRows)") &&
      source.includes("hasActiveBlocker: activeFormalBlockers.has(t.id)"),
    `${label} must serialize the formal blocker state`,
  );
}

const board = read("app/(app)/projects/[slug]/board-client.tsx");
assert.equal(occurrences(board, "data-active-task-blocker"), 1, "the board must define one shared active-blocker icon");
assert.equal(occurrences(board, "data-board-card-blocker-slot"), 1, "the shared card body must define one blocker-icon slot");
assert(
  /data-board-card-blocker-slot[\s\S]*?className="[^"]*col-start-1[^"]*row-start-5[^"]*"/.test(board),
  "the task-card blocker icon must occupy the bottom-left identity-rail cell",
);
assert.equal(occurrences(board, "<ActiveBlockerIcon"), 3, "main, focus, and backlog board representations must show the blocker icon");
assert(
  board.includes("task.blockedByKey || task.hasActiveBlocker") &&
    board.includes("task.hasActiveBlocker ||\n    task.status"),
  "formal blockers must contribute to the Blocked count and Needs attention filter",
);

console.log("board blocker indicator contract passed");
