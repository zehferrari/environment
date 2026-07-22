import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import WorkspacesBoard, { type BoardWorkspace } from "../app/(app)/workspaces/workspaces-board";
import {
  BOARD_COLOR_PALETTE,
  fallbackBoardColor,
  hexColorOrNull,
  hexWithAlpha,
  randomBoardColor,
} from "../lib/board-colors";

// --- board-colors helpers ---

assert.equal(hexColorOrNull(" #2563EB "), "#2563eb", "trims and lowercases hex colours");
assert.equal(hexColorOrNull("#abc"), "#aabbcc", "expands 3-digit hex to 6-digit");
assert.equal(hexColorOrNull(""), null, "blank input canonicalizes to null");
assert.equal(hexColorOrNull(null), null, "null input stays null");
assert.equal(hexColorOrNull(undefined), null, "undefined input stays null");
assert.throws(() => hexColorOrNull("blue"), /hex value/, "rejects named colours");
assert.throws(() => hexColorOrNull("#12345"), /hex value/, "rejects malformed hex");
assert.throws(() => hexColorOrNull(42), /hex value/, "rejects non-string values");

assert.equal(hexWithAlpha("#2563eb", 0.12), "#2563eb1f", "appends alpha byte");
assert.equal(hexWithAlpha("#2563eb", 2), "#2563ebff", "clamps alpha above 1");
assert.equal(hexWithAlpha("#2563eb", -1), "#2563eb00", "clamps alpha below 0");

for (let i = 0; i < 25; i += 1) {
  assert.ok(
    (BOARD_COLOR_PALETTE as readonly string[]).includes(randomBoardColor()),
    "randomBoardColor stays inside the palette",
  );
}
assert.equal(fallbackBoardColor("seed-a"), fallbackBoardColor("seed-a"), "fallback colour is deterministic");
assert.ok(
  (BOARD_COLOR_PALETTE as readonly string[]).includes(fallbackBoardColor("anything")),
  "fallback colour comes from the palette",
);

// --- board rendering ---

const stubRouter: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  hmrRefresh: () => {},
} as AppRouterInstance;

const workspaces: BoardWorkspace[] = [
  {
    id: "ws-1",
    slug: "alpha",
    name: "Alpha",
    type: "internal",
    borderColor: "#e11d48",
    projects: [
      {
        id: "proj-1",
        slug: "apollo",
        name: "Apollo",
        backgroundColor: "#2563eb",
        tasks: [
          { id: "task-1", title: "Ship the board", status: "In Progress", workItemKey: "ENV-111" },
          { id: "task-2", title: "Untitled follow-up", status: "Backlog", workItemKey: null },
        ],
      },
    ],
  },
  {
    id: "ws-2",
    slug: "beta",
    name: "Beta",
    type: "client",
    borderColor: null,
    projects: [
      { id: "proj-2", slug: "zephyr", name: "Zephyr", backgroundColor: null, tasks: [] },
    ],
  },
];

function render(ui: React.ReactElement) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={stubRouter}>{ui}</AppRouterContext.Provider>,
  );
}

const html = render(<WorkspacesBoard workspaces={workspaces} isOwner={true} />);

assert.match(html, /border-color:#e11d48/, "workspace border uses the configured colour");
assert.match(html, /background-color:#2563eb1f/, "project background is a translucent tint of its colour");
assert.match(
  html,
  new RegExp(`border-color:${fallbackBoardColor("ws-2")}`),
  "workspace without a colour falls back deterministically",
);
assert.match(html, /href="\/workspaces\/alpha"/, "workspace label links to the workspace landing page");
assert.match(html, /href="\/projects\/apollo"/, "project label links to the project landing page");
assert.match(html, /href="\/projects\/apollo\/tasks\/task-1"/, "task card links to the task page");
assert.match(html, /ENV-111/, "task card shows the work-item key");
assert.match(html, /In Progress/, "task card shows its status");
assert.match(html, /No tasks yet\./, "empty project renders an empty state");
assert.doesNotMatch(html, /aria-label="[^"]*settings"/, "gear icon hidden while multiple workspaces are visible");
assert.match(html, /aria-label="Create workspace, project, epic, or task"/, "(+) creation button renders");
assert.match(html, /All workspaces/, "workspace filter renders");
assert.match(html, /All projects/, "project filter renders");

const singleHtml = render(<WorkspacesBoard workspaces={[workspaces[0]]} isOwner={false} />);
assert.match(
  singleHtml,
  /aria-label="Alpha workspace settings"/,
  "gear icon appears when exactly one workspace is visible",
);
assert.match(
  singleHtml,
  /href="\/workspaces\/alpha\/settings"/,
  "gear icon links to that workspace's settings page",
);

console.log("workspaces-board-test ok");
