import assert from "node:assert/strict";
import {
  DEFAULT_EPIC_BOARD_STATUSES,
  parseEpicBoardStatuses,
} from "@/lib/epics/status-filter";

assert.deepEqual(
  DEFAULT_EPIC_BOARD_STATUSES,
  ["In Progress", "Ready to Deploy"],
  "the default Epic view focuses on active and deploy-ready work",
);

assert.deepEqual(
  parseEpicBoardStatuses(undefined, undefined),
  ["In Progress", "Ready to Deploy"],
  "an Epic URL without a status query uses the focused defaults",
);

assert.deepEqual(
  parseEpicBoardStatuses("Backlog,Done", undefined),
  ["Backlog", "Done"],
  "an explicit multi-status URL is preserved",
);

assert.deepEqual(
  parseEpicBoardStatuses("", undefined),
  [],
  "an explicitly empty status selection remains empty",
);

assert.deepEqual(
  parseEpicBoardStatuses(undefined, "backlog"),
  ["Backlog"],
  "the legacy singular status URL remains supported",
);

console.log("epic-status-filter-test ok");
