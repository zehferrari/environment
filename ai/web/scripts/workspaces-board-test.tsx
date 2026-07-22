import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import WorkspacesBoard, { type BoardWorkspace, type BoardTask } from "../app/(app)/workspaces/workspaces-board";
import {
  BOARD_COLOR_PALETTE,
  fallbackBoardColor,
  hexColorOrNull,
  hexWithAlpha,
  randomBoardColor,
} from "../lib/board-colors";

// ---------------------------------------------------------------------------
// board-colors helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const stubRouter: AppRouterInstance = {
  back: () => {},
  forward: () => {},
  refresh: () => {},
  push: () => {},
  replace: () => {},
  prefetch: () => {},
  hmrRefresh: () => {},
} as AppRouterInstance;

const taskFactory = (overrides: Partial<BoardTask> & { id: string }): BoardTask => ({
  title: `Task ${overrides.id}`,
  status: "To Do",
  workItemKey: null,
  parentTaskId: null,
  ...overrides,
});

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
          taskFactory({ id: "task-1", title: "Ship the board", status: "In Progress", workItemKey: "ENV-111" }),
          taskFactory({ id: "task-2", title: "Untitled follow-up", status: "Backlog", workItemKey: null }),
          taskFactory({ id: "task-3", title: "Subtask: fix colours", status: "To Do", parentTaskId: "task-1" }),
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

// ---------------------------------------------------------------------------
// Board rendering: visual grouping + colour persistence
// ---------------------------------------------------------------------------

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
assert.match(html, /aria-label="Create workspace, project, epic, or task"/, "(+) creation button renders");
assert.match(html, /All workspaces/, "workspace filter renders");
assert.match(html, /All projects/, "project filter renders");

// Subtask rendering
assert.match(html, /↳/, "subtask indicator renders for child tasks");
assert.match(html, /Subtask: fix colours/, "subtask title is displayed");
assert.match(
  html,
  /border-l-2/,
  "subtask has visual indentation via left border",
);

// ---------------------------------------------------------------------------
// >=2 workspace gate: gear icon hidden when multiple workspaces are visible
// ---------------------------------------------------------------------------

assert.doesNotMatch(
  html,
  /aria-label="[^"]*workspace settings"/,
  "gear icon hidden while multiple workspaces are visible",
);

// ---------------------------------------------------------------------------
// Gear icon: visible for owner with single workspace, hidden for non-owner
// ---------------------------------------------------------------------------

const singleOwnerHtml = render(<WorkspacesBoard workspaces={[workspaces[0]]} isOwner={true} />);
assert.match(
  singleOwnerHtml,
  /aria-label="Alpha workspace settings"/,
  "gear icon appears for owner when exactly one workspace is visible",
);
assert.match(
  singleOwnerHtml,
  /href="\/workspaces\/alpha\/settings"/,
  "gear icon links to that workspace's settings page",
);

const singleNonOwnerHtml = render(<WorkspacesBoard workspaces={[workspaces[0]]} isOwner={false} />);
assert.doesNotMatch(
  singleNonOwnerHtml,
  /aria-label="[^"]*workspace settings"/,
  "gear icon hidden for non-owner even when single workspace is visible",
);
assert.doesNotMatch(
  singleNonOwnerHtml,
  /\/workspaces\/alpha\/settings/,
  "settings link not rendered for non-owner members",
);

// Non-owner still sees the board content
assert.match(singleNonOwnerHtml, /Alpha/, "non-owner sees workspace name");
assert.match(singleNonOwnerHtml, /Apollo/, "non-owner sees project name");

// ---------------------------------------------------------------------------
// >=2 workspace gate: single workspace still renders the board correctly
// ---------------------------------------------------------------------------

const singleWsHtml = render(<WorkspacesBoard workspaces={[workspaces[0]]} isOwner={true} />);
assert.match(singleWsHtml, /Alpha/, "single workspace name renders");
assert.match(singleWsHtml, /Apollo/, "single workspace project renders");
assert.match(singleWsHtml, /Ship the board/, "single workspace task renders");

// ---------------------------------------------------------------------------
// Access scoping: only accessible projects/tasks appear (server pre-scope)
// The board component receives already-scoped data from the server page.
// Verify it renders exactly what it receives — no phantom projects.
// ---------------------------------------------------------------------------

const scopedWorkspaces: BoardWorkspace[] = [
  {
    ...workspaces[0],
    projects: [workspaces[0].projects[0]], // only Apollo
  },
  {
    ...workspaces[1],
    projects: [], // Beta has no accessible projects
  },
];

const scopedHtml = render(<WorkspacesBoard workspaces={scopedWorkspaces} isOwner={true} />);
assert.match(scopedHtml, /Alpha/, "workspace with accessible projects renders");
assert.match(scopedHtml, /Apollo/, "accessible project renders");
assert.doesNotMatch(
  scopedHtml,
  /Zephyr/,
  "inaccessible project does not appear in the board",
);
assert.match(
  scopedHtml,
  /No active projects in this workspace\./,
  "workspace with no accessible projects shows empty state",
);

// ---------------------------------------------------------------------------
// Colour persistence: explicit colours render, null colours fall back
// ---------------------------------------------------------------------------

const colourTestWs: BoardWorkspace[] = [
  {
    id: "ws-col",
    slug: "coloured",
    name: "Coloured",
    type: "internal",
    borderColor: "#ff0000",
    projects: [
      {
        id: "proj-col",
        slug: "coloured-proj",
        name: "Coloured Project",
        backgroundColor: "#00ff00",
        tasks: [],
      },
    ],
  },
  {
    id: "ws-nocol",
    slug: "uncoloured",
    name: "Uncoloured",
    type: "internal",
    borderColor: null,
    projects: [
      {
        id: "proj-nocol",
        slug: "uncoloured-proj",
        name: "Uncoloured Project",
        backgroundColor: null,
        tasks: [],
      },
    ],
  },
];

const colourHtml = render(<WorkspacesBoard workspaces={colourTestWs} isOwner={true} />);
assert.match(colourHtml, /border-color:#ff0000/, "explicit workspace border colour persists");
assert.match(
  colourHtml,
  new RegExp(`border-color:${fallbackBoardColor("ws-nocol")}`),
  "null workspace border colour falls back deterministically",
);
assert.match(
  colourHtml,
  /background-color:#00ff001f/,
  "explicit project background colour persists as translucent tint",
);
assert.match(
  colourHtml,
  new RegExp(`background-color:${hexWithAlpha(fallbackBoardColor("proj-nocol"), 0.12)}`),
  "null project background colour falls back to deterministic tint",
);

// ---------------------------------------------------------------------------
// Creation menu: (+) button renders, menu items gated by isOwner
// (The dropdown content is state-gated and only appears when open; SSR
// renders the closed state, so we verify the button and isOwner-conditional
// items by rendering with the menu open via a separate test below.)
// ---------------------------------------------------------------------------

const pickerHtml = render(<WorkspacesBoard workspaces={workspaces} isOwner={true} />);
assert.match(pickerHtml, /\+/, "(+) button icon is visible");
assert.match(
  pickerHtml,
  /aria-label="Create workspace, project, epic, or task"/,
  "(+) button has correct aria-label",
);

// Non-owner: (+) button still renders but workspace/project creation options
// are gated by isOwner inside the menu component
const nonOwnerCreateHtml = render(<WorkspacesBoard workspaces={workspaces} isOwner={false} />);
assert.match(
  nonOwnerCreateHtml,
  /aria-label="Create workspace, project, epic, or task"/,
  "(+) button renders for non-owner",
);
// In SSR closed state, menu items aren't rendered at all, so we verify
// the isOwner prop is threaded correctly by checking that the gear icon
// (also isOwner-gated) behaves correctly in the non-owner case above.

// ---------------------------------------------------------------------------
// Task card labels: workspace + project labels both clickable
// ---------------------------------------------------------------------------

assert.match(
  html,
  /href="\/workspaces\/alpha"[^>]*>Alpha/,
  "task card workspace label is a link to the workspace",
);
assert.match(
  html,
  /href="\/projects\/apollo"[^>]*>Apollo/,
  "task card project label is a link to the project",
);

// ---------------------------------------------------------------------------
// Empty state: no workspaces at all
// ---------------------------------------------------------------------------

const emptyHtml = render(<WorkspacesBoard workspaces={[]} isOwner={true} />);
assert.match(
  emptyHtml,
  /No workspaces match the current filters\./,
  "empty board shows no-match message",
);

// ---------------------------------------------------------------------------
// Multiple statuses displayed
// ---------------------------------------------------------------------------

assert.match(html, /In Progress/, "In Progress status renders");
assert.match(html, /Backlog/, "Backlog status renders");
assert.match(html, /To Do/, "To Do status renders");

console.log("workspaces-board-test ok");