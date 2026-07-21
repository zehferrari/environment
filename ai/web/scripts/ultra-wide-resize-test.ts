// ENV-110 ultra-wide viewport / live-resize regression test.
//
// The ultra-wide layout (shell cap, split workspace, command-deck rail,
// workflow-focus grid) is implemented entirely with CSS media and container
// queries, so its behaviour under live resize is a pure function of viewport
// width, sidebar state, and whether a task pane is open. This test parses the
// REAL class strings out of the source files (so any drift breaks the test),
// rebuilds that width function, and then:
//   1. sweeps every viewport width 320..5200px x sidebar states x pane
//      open/closed and asserts the approved invariants hold everywhere
//      (this is the live-resize guarantee: CSS re-evaluates continuously,
//      so covering every width covers every resize trajectory), and
//   2. pins down the named review checkpoints: mobile (390), 1920, 2560,
//      3440 and 5120.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function assert(condition: unknown, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

// ---------------------------------------------------------------------------
// Parse the sanctioned values from the actual sources.
// ---------------------------------------------------------------------------

const globals = read("app/globals.css");
function breakpointPx(name: string): number {
  const match = globals.match(new RegExp(`--breakpoint-${name}\\s*:\\s*([0-9.]+)rem`));
  assert(match, `globals.css must declare --breakpoint-${name} in rem`);
  return parseFloat(match![1]) * 16;
}
const BP3XL = breakpointPx("3xl");
const BP4XL = breakpointPx("4xl");
const BP5XL = breakpointPx("5xl");
assert(BP3XL === 2000 && BP4XL === 2560 && BP5XL === 3440, "ultra-wide breakpoints must be 2000/2560/3440px");

const appLayout = read("app/(app)/layout.tsx");
const shellCap = appLayout.match(/max-w-\[(\d+)px\] 3xl:max-w-\[(\d+)px\] 4xl:max-w-\[(\d+)px\]/);
assert(shellCap, "app shell must keep the progressive max-width scale");
const [CAP_BASE, CAP_3XL, CAP_4XL] = [1, 2, 3].map((i) => parseInt(shellCap![i], 10));

const sidebarNav = read("components/sidebar-nav.tsx");
assert(/hidden[^"`]*md:flex/.test(sidebarNav), "sidebar must stay hidden below md");
assert(sidebarNav.includes('collapsed ? "w-16" : "w-64"'), "sidebar widths must be w-16 collapsed / w-64 expanded");
const SIDEBAR_EXPANDED = 256;
const SIDEBAR_COLLAPSED = 64;

const deck = read("components/command-deck.tsx");
const rail = deck.match(/hidden w-\[([0-9.]+)rem\][^"]*5xl:block/);
assert(rail, "command-deck rail must be hidden below 5xl and use a fixed rem width");
const RAIL_W = parseFloat(rail![1]) * 16;

const projectLayout = read("app/(app)/projects/[slug]/layout.tsx");
assert(projectLayout.includes("@container/ws"), "project layout must define the @container/ws measure");
assert(projectLayout.includes("@container/board"), "project layout must define the @container/board measure");
const splitAt = projectLayout.match(/@min-\[([0-9.]+)rem\]\/ws:flex/);
assert(splitAt, "split workspace must activate via an @min container query on /ws");
const SPLIT_AT = parseFloat(splitAt![1]) * 16;
assert(/group-has-\[\[data-ws-open\]\]\/ws:hidden/.test(projectLayout), "board must hide under the pane below the split threshold");
assert(/@min-\[[0-9.]+rem\]\/ws:group-has-\[\[data-ws-open\]\]\/ws:block/.test(projectLayout), "board must stay visible beside the pane above the split threshold");
assert(/@min-\[[0-9.]+rem\]\/ws:gap-4/.test(projectLayout), "split workspace gap must be gap-4");
const SPLIT_GAP = 16;

const pane = read("components/workspace-pane.tsx");
const paneNarrow = pane.match(/@min-\[([0-9.]+)rem\]\/ws:w-\[([0-9.]+)rem\]/);
const paneWide = pane.match(/@min-\[([0-9.]+)rem\]\/ws:w-\[([0-9.]+)rem\][^"]*@min-\[([0-9.]+)rem\]\/ws:w-\[([0-9.]+)rem\]/);
assert(paneNarrow && paneWide, "workspace pane must size via /ws container queries");
const PANE_NARROW_AT = parseFloat(paneWide![1]) * 16;
const PANE_NARROW_W = parseFloat(paneWide![2]) * 16;
const PANE_WIDE_AT = parseFloat(paneWide![3]) * 16;
const PANE_WIDE_W = parseFloat(paneWide![4]) * 16;

const boardClient = read("app/(app)/projects/[slug]/board-client.tsx");
const focusGrid = boardClient.match(
  /grid gap-2 [^"]*@min-\[([0-9.]+)rem\]\/board:grid-cols-\[repeat\(auto-fill,minmax\((\d+)px,1fr\)\)\] @min-\[([0-9.]+)rem\]\/board:grid-cols-6/,
);
assert(focusGrid, "workflow-focus grid must use /board container queries: auto-fill minmax then fixed six columns");
const FOCUS_FILL_AT = parseFloat(focusGrid![1]) * 16;
const TRACK_MIN = parseInt(focusGrid![2], 10);
const FOCUS_SIX_AT = parseFloat(focusGrid![3]) * 16;
const FOCUS_GAP = 8; // gap-2

// The wide grid bands must not key off the viewport any more.
assert(!/4xl:grid-cols|5xl:grid-cols/.test(boardClient), "board-client must not size wide grid bands off viewport breakpoints");

// Threshold arithmetic contracts from the approved design.
const BOARD_MIN = 1200;
assert(TRACK_MIN === 284, "approved minimum focus track width is 284px");
assert(SPLIT_AT === BOARD_MIN + SPLIT_GAP + PANE_NARROW_W, `split threshold must equal board min + gap + pane (${BOARD_MIN}+${SPLIT_GAP}+${PANE_NARROW_W})`);
assert(PANE_NARROW_AT === SPLIT_AT, "pane narrow width must engage exactly at the split threshold");
assert(FOCUS_SIX_AT === 6 * TRACK_MIN + 5 * FOCUS_GAP, "fixed six-column grid must only engage once six 284px tracks plus gaps fit");
assert(PANE_WIDE_AT === PANE_WIDE_W + SPLIT_GAP + FOCUS_SIX_AT, "pane wide threshold must keep six 284px tracks beside the widened pane");
assert(FOCUS_FILL_AT >= 4 * TRACK_MIN + 3 * FOCUS_GAP, "auto-fill band must not engage before four 284px tracks fit");

// Live resize must be pure CSS: no JS viewport measurements in the sizing path.
for (const path of ["app/(app)/projects/[slug]/layout.tsx", "components/workspace-pane.tsx"]) {
  const source = read(path);
  assert(!/window\.innerWidth|matchMedia|ResizeObserver/.test(source), `${path} must size purely via CSS container queries (live-resize safe)`);
}

// ---------------------------------------------------------------------------
// Width model (mirrors the CSS exactly).
// ---------------------------------------------------------------------------

type State = { viewport: number; sidebarCollapsed: boolean; paneOpen: boolean };

function mainPadding(viewport: number) {
  if (viewport >= 1024) return 64; // lg:px-page-x-lg (2rem each side)
  if (viewport >= 640) return 48; // sm:px-page-x (1.5rem each side)
  return 32; // px-4
}

function shellCapFor(viewport: number) {
  if (viewport >= BP4XL) return CAP_4XL;
  if (viewport >= BP3XL) return CAP_3XL;
  return CAP_BASE;
}

// Width of the @container/ws content area.
function wsWidth({ viewport, sidebarCollapsed }: State) {
  const sidebar = viewport >= 768 ? (sidebarCollapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED) : 0;
  const railW = viewport >= BP5XL ? RAIL_W : 0;
  const available = viewport - sidebar - railW - mainPadding(viewport);
  return Math.min(available, shellCapFor(viewport));
}

function layoutFor(state: State) {
  const ws = wsWidth(state);
  const splitActive = ws >= SPLIT_AT;
  const paneW = state.paneOpen ? (ws >= PANE_WIDE_AT ? PANE_WIDE_W : PANE_NARROW_W) : 0;
  let board: number;
  if (!state.paneOpen) {
    board = ws;
  } else if (splitActive) {
    board = ws - paneW - SPLIT_GAP;
  } else {
    board = 0; // board hidden; pane takes the full content width
  }
  return { ws, splitActive, paneW, board };
}

function focusColumns(board: number) {
  if (board >= FOCUS_SIX_AT) return 6;
  if (board >= FOCUS_FILL_AT) {
    return Math.max(1, Math.floor((board + FOCUS_GAP) / (TRACK_MIN + FOCUS_GAP)));
  }
  return null; // narrow bands use fixed viewport column counts (md/xl/3xl)
}

function focusTrackWidth(board: number) {
  const cols = focusColumns(board);
  if (cols === null) return null;
  return (board - (cols - 1) * FOCUS_GAP) / cols;
}

// ---------------------------------------------------------------------------
// 1. Full-sweep invariants (every width = every live-resize position).
// ---------------------------------------------------------------------------

for (let viewport = 320; viewport <= 5200; viewport += 1) {
  for (const sidebarCollapsed of [false, true]) {
    for (const paneOpen of [false, true]) {
      const state = { viewport, sidebarCollapsed, paneOpen };
      const { splitActive, board } = layoutFor(state);
      const label = `viewport=${viewport} sidebar=${sidebarCollapsed ? "collapsed" : "expanded"} pane=${paneOpen ? "open" : "closed"}`;
      if (paneOpen && splitActive) {
        assert(board >= BOARD_MIN, `${label}: split active but board ${board.toFixed(1)}px < ${BOARD_MIN}px minimum`);
      }
      if (board > 0) {
        const track = focusTrackWidth(board);
        if (track !== null) {
          assert(track >= TRACK_MIN, `${label}: focus track ${track.toFixed(1)}px < ${TRACK_MIN}px minimum (board ${board.toFixed(1)}px)`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Named review checkpoints.
// ---------------------------------------------------------------------------

// Mobile 390: no sidebar, no rail, no split; pane (task route) takes over.
{
  const closed = layoutFor({ viewport: 390, sidebarCollapsed: false, paneOpen: false });
  const open = layoutFor({ viewport: 390, sidebarCollapsed: false, paneOpen: true });
  assert(!closed.splitActive && closed.board === 358, `mobile board must be full content width (got ${closed.board})`);
  assert(open.board === 0 && open.paneW > 0, "mobile open task must hide the board behind the pane");
}

// 1920 (protected baseline): shell capped at 1480, no split ever.
{
  const s = layoutFor({ viewport: 1920, sidebarCollapsed: false, paneOpen: true });
  assert(s.ws === CAP_BASE, `1920 content width must cap at ${CAP_BASE} (got ${s.ws})`);
  assert(!s.splitActive, "1920 must never activate the split workspace");
}

// 2560 expanded sidebar: only 2240px available — split must NOT activate
// (this is the reviewer's 1104px-board failure case under the old viewport
// gating). Collapsing the sidebar frees enough width for a legal split.
{
  const expanded = layoutFor({ viewport: 2560, sidebarCollapsed: false, paneOpen: true });
  assert(expanded.ws === 2240, `2560 expanded content width must be 2240 (got ${expanded.ws})`);
  assert(!expanded.splitActive, "2560 with expanded sidebar must not split (board would drop below 1200px)");
  const collapsed = layoutFor({ viewport: 2560, sidebarCollapsed: true, paneOpen: true });
  assert(collapsed.splitActive && collapsed.board >= BOARD_MIN, `2560 collapsed sidebar must split with board >= ${BOARD_MIN} (got ${collapsed.board})`);
}

// 3440 expanded sidebar + rail: split active, board 1624px, auto-fill gives
// five >=284px tracks (the reviewer's six-251px-tracks failure case).
{
  const s = layoutFor({ viewport: 3440, sidebarCollapsed: false, paneOpen: true });
  assert(s.splitActive, "3440 must activate the split workspace");
  assert(s.ws === 3440 - SIDEBAR_EXPANDED - RAIL_W - 64, `3440 content width must subtract sidebar+rail+padding (got ${s.ws})`);
  assert(s.board === s.ws - PANE_NARROW_W - SPLIT_GAP, "3440 board must sit beside the 70rem pane");
  const cols = focusColumns(s.board);
  const track = focusTrackWidth(s.board)!;
  assert(cols === 5 && track >= TRACK_MIN, `3440 focus grid must fall back to 5 tracks >= ${TRACK_MIN}px (got ${cols} @ ${track.toFixed(1)}px)`);
}

// 5120: wide pane engages, six fixed tracks all comfortably >= 284px.
{
  const s = layoutFor({ viewport: 5120, sidebarCollapsed: false, paneOpen: true });
  assert(s.splitActive && s.paneW === PANE_WIDE_W, `5120 must use the ${PANE_WIDE_W}px pane`);
  const cols = focusColumns(s.board);
  const track = focusTrackWidth(s.board)!;
  assert(cols === 6 && track >= TRACK_MIN, `5120 focus grid must run six tracks >= ${TRACK_MIN}px (got ${cols} @ ${track.toFixed(1)}px)`);
}

console.log("ultra-wide resize regression ok (sweep 320..5200 x sidebar x pane + checkpoints 390/1920/2560/3440/5120)");
