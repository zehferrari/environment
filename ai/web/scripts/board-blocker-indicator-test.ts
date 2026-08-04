import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeFormalBlockersByTask,
  activeFormalBlockerTaskIds,
  blockerPermissionGrantForComment,
} from "../lib/tasks/formal-blocker";

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
const blockerMetadata = activeFormalBlockersByTask([
  {
    taskId: "permission",
    kind: "task.blocker",
    payload: JSON.stringify({
      commentId: "comment-1",
      permissionRequest: {
        kind: "reporter_approval",
        scope: "Allow the assignee to run the named live verification.",
      },
    }),
  },
]);
assert.equal(blockerMetadata.get("permission")?.commentId, "comment-1", "the active blocker must retain its exact comment id");
assert.equal(blockerMetadata.get("permission")?.permissionRequest?.kind, "reporter_approval", "structured reporter permission must survive lifecycle parsing");
assert.equal(
  activeFormalBlockersByTask(
    [{ taskId: "legacy", kind: "task.blocker", createdAt: 1_000 }],
    [{ id: "legacy-comment", taskId: "legacy", createdAt: 1_000 }],
  ).get("legacy")?.commentId,
  "legacy-comment",
  "already-open legacy blockers must resolve their matching generated comment",
);
assert.deepEqual(
  blockerPermissionGrantForComment([
    {
      kind: "task.blocker.permission.granted",
      payload: JSON.stringify({ blockerCommentId: "comment-1", authorizationCommentId: "comment-2" }),
    },
  ], "comment-1"),
  { authorizationCommentId: "comment-2" },
  "permission grants must be associated with the blocker comment id",
);

for (const [path, label] of [
  ["app/(app)/projects/[slug]/page.tsx", "project board"],
  ["app/(app)/workspaces/[slug]/page.tsx", "workspace board"],
  ["app/(app)/workspaces/(landing)/page.tsx", "workspace landing board"],
] as const) {
  const source = read(path);
  assert(
    source.includes("activeFormalBlockersByTask(taskActivityRows, legacyBlockerComments)") &&
      source.includes("hasActiveBlocker: activeFormalBlockers.has(t.id)") &&
      source.includes("activeBlockerCommentId: activeFormalBlockers.get(t.id)?.commentId ?? null"),
    `${label} must serialize the formal blocker state and exact comment id`,
  );
}

const board = read("app/(app)/projects/[slug]/board-client.tsx");
assert.equal(occurrences(board, "data-active-task-blocker"), 1, "the board must define one shared active-blocker button");
assert.equal(occurrences(board, "data-board-card-blocker-slot"), 1, "the shared card body must define one blocker-icon slot");
assert(
  /data-board-card-blocker-slot[\s\S]*?className="[^"]*col-start-1[^"]*row-start-5[^"]*"/.test(board),
  "the task-card blocker icon must occupy the bottom-left identity-rail cell",
);
assert.equal(occurrences(board, "<ActiveBlockerButton"), 3, "main, focus, and backlog board representations must expose the blocker action");
assert(
  board.includes("?tab=comments") && board.includes("comment=${encodeURIComponent(task.activeBlockerCommentId)}"),
  "the blocker action must open Comments and identify the exact blocker comment",
);
const taskPage = read("app/(app)/projects/[slug]/tasks/[taskId]/page.tsx");
assert(
  taskPage.includes("<FocusTaskComment commentId={focusedCommentId}") &&
    taskPage.includes("data-blocker-permission-action") &&
    taskPage.includes("Grant requested permission") &&
    taskPage.includes("task.blocker.permission.granted"),
  "task comments must focus deep-linked blockers and expose the audited reporter permission action",
);
assert(
  board.includes("task.blockedByKey || task.hasActiveBlocker") &&
    board.includes("task.hasActiveBlocker ||\n    task.status"),
  "formal blockers must contribute to the Blocked count and Needs attention filter",
);

console.log("board blocker indicator contract passed");
