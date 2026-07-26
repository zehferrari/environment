// Source-level regression contract for the project/workspace workflow-board
// chrome and its viewport-bounded desktop lanes. The width/sticky behavior is
// CSS-driven while lane height uses the grid's live viewport position, so this
// test reads the real JSX contract without assuming class ordering or local
// implementation details beyond that measurement boundary.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { boardAvailableHeight, boardStickyTop } from "../lib/board-chrome";

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), "utf8");
}

function occurrences(source: string, value: string) {
  return source.split(value).length - 1;
}

function attributeOccurrences(source: string, attribute: string) {
  return [...source.matchAll(new RegExp(`${attribute}(?=[\\s=>])`, "g"))].length;
}

function openingTagWithMarker(source: string, marker: string, label: string) {
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1, `${label} must render ${marker}`);
  const tagStart = source.lastIndexOf("<", markerIndex);
  const tagEnd = source.indexOf(">", markerIndex);
  assert(tagStart >= 0 && tagEnd > markerIndex, `${label} must put ${marker} on an opening JSX tag`);
  return {
    end: tagEnd,
    start: tagStart,
    tag: source.slice(tagStart, tagEnd + 1),
  };
}

function classTokens(tag: string, label: string) {
  const classMatch =
    tag.match(/className\s*=\s*"([^"]*)"/s) ??
    tag.match(/className\s*=\s*'([^']*)'/s) ??
    tag.match(/className\s*=\s*\{`([^`]*)`\}/s);
  assert(classMatch, `${label} must use a statically inspectable className`);
  return new Set(classMatch[1]!.split(/\s+/).filter(Boolean));
}

function openingTags(source: string) {
  return [...source.matchAll(/<[a-z][^>]*>/gis)].map((match) => match[0]);
}

function hasClass(tag: string, token: string) {
  try {
    return classTokens(tag, "candidate tag").has(token);
  } catch {
    return false;
  }
}

function assertClasses(tokens: Set<string>, required: readonly string[], label: string) {
  for (const token of required) {
    assert(tokens.has(token), `${label} must include ${token}`);
  }
}

function assertSharedSlotWiring(source: string, label: string) {
  assert(source.includes("boardChromeSlotId"), `${label} must use the shared boardChromeSlotId helper`);
  for (const slot of ["summary", "controls"] as const) {
    const call = new RegExp(`boardChromeSlotId\\(\\s*[^,\\n]+,\\s*["']${slot}["']\\s*\\)`);
    assert(call.test(source), `${label} must derive its ${slot} slot from boardChromeSlotId`);

    // When a slot id is assigned to a local, require it to be consumed as
    // well as declared. Inline id/prop usage remains valid too.
    const assignment = source.match(
      new RegExp(`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*boardChromeSlotId\\(\\s*[^,\\n]+,\\s*["']${slot}["']\\s*\\)`),
    );
    if (assignment) {
      assert(
        occurrences(source, assignment[1]!) >= 2,
        `${label} must expose or consume its ${slot} slot id`,
      );
    }
  }
}

function assertStickyToolbar(source: string, label: string) {
  assert.equal(attributeOccurrences(source, "data-board-toolbar"), 1, `${label} must render one board toolbar wrapper`);
  const toolbar = openingTagWithMarker(source, "data-board-toolbar", label);
  const outerClasses = classTokens(toolbar.tag, `${label} toolbar wrapper`);
  assertClasses(outerClasses, ["sticky", "top-0"], `${label} toolbar wrapper`);
  assert(
    ![...outerClasses].some((token) => /^overflow(?:-x)?-(?:auto|scroll|hidden|clip)$/.test(token)),
    `${label} sticky wrapper must not be its own horizontal scroll container`,
  );

  const innerScroller = openingTags(source.slice(toolbar.end + 1)).find((tag) =>
    hasClass(tag, "overflow-x-auto") || hasClass(tag, "overflow-x-scroll"),
  );
  assert(innerScroller, `${label} must keep horizontal overflow on an inner nav/scroller`);
}

function markerPositions(source: string, marker: string) {
  return [...source.matchAll(new RegExp(marker, "g"))].map((match) => match.index);
}

function assertToolbarName(source: string, label: string) {
  assert.equal(
    attributeOccurrences(source, "data-board-toolbar-name"),
    1,
    `${label} must render its workspace/project name once in the sticky toolbar`,
  );
  const toolbarIndex = source.indexOf("data-board-toolbar");
  const nameIndex = source.indexOf("data-board-toolbar-name");
  const stuckGateIndex = source.lastIndexOf("{toolbarStuck ? (", nameIndex);
  const navIndex = source.indexOf("<nav", nameIndex);
  assert(
    toolbarIndex >= 0 && nameIndex > toolbarIndex && navIndex > nameIndex,
    `${label} name must appear at the beginning of the toolbar, before its tabs`,
  );
  assert(
    stuckGateIndex > toolbarIndex && stuckGateIndex < nameIndex,
    `${label} name must only appear while the toolbar is actually stuck`,
  );
}

const boardChrome = read("lib/board-chrome.ts");
const boardToolbarGeometry = read("lib/use-board-toolbar-geometry.ts");
const globalStyles = read("app/globals.css");
const projectLayout = read("app/(app)/projects/[slug]/layout.tsx");
const projectTabs = read("app/(app)/projects/[slug]/project-tabs.tsx");
const projectTaskPane = read("app/(app)/projects/[slug]/@workspace/(.)tasks/[taskId]/page.tsx");
const projectTasksPage = read("app/(app)/projects/[slug]/tasks/page.tsx");
const epicPage = read("app/(app)/projects/[slug]/epics/[epicId]/page.tsx");
const workspacePage = read("app/(app)/workspaces/[slug]/page.tsx");
const workspaceLayout = read("app/(app)/workspaces/[slug]/layout.tsx");
const workspaceTabs = read("app/(app)/workspaces/[slug]/workspace-tabs.tsx");
const workspaceTaskPane = read(
  "app/(app)/workspaces/[slug]/@workspace/(...)projects/[projectSlug]/tasks/[taskId]/page.tsx",
);
const workspaceTaskDefault = read("app/(app)/workspaces/[slug]/@workspace/default.tsx");
const workspacePane = read("components/workspace-pane.tsx");
const closeTaskButton = read("components/close-task-button.tsx");
const stickyViewportSurface = read("components/sticky-viewport-surface.tsx");
const taskTabs = read("components/task-tabs.tsx");
const taskQuickAdd = read("components/task-quick-add-fab.tsx");
const boardClient = read("app/(app)/projects/[slug]/board-client.tsx");
const taskPage = read("app/(app)/projects/[slug]/tasks/[taskId]/page.tsx");
const addTaskFab = read("app/(app)/projects/[slug]/add-task-fab.tsx");
const addProjectFab = read("app/(app)/projects/add-project-fab.tsx");
const newEpicFab = read("app/(app)/projects/[slug]/epics/new-epic-fab.tsx");
const attachmentFab = read("components/attachment-upload-fab.tsx");
const commentFab = read("components/comment-composer-fab.tsx");
const decomposedChatRoom = read("components/chat-room-decomposed.tsx");
const legacyChatRoom = read("components/legacy-chat-room.tsx");
const paneTag = openingTagWithMarker(workspacePane, "data-ws-open", "task workspace pane");

assert.match(
  boardChrome,
  /export\s+function\s+boardChromeSlotId\s*\(/,
  "board chrome slot ids must come from one shared helper",
);
const projectChrome = `${projectLayout}\n${projectTabs}`;
const workspaceChrome = `${workspaceLayout}\n${workspaceTabs}`;
assertSharedSlotWiring(projectChrome, "project layout/tabs");
assertSharedSlotWiring(workspaceChrome, "workspace layout/tabs");
assertSharedSlotWiring(boardClient, "board client");
assert(/\bid\s*=\s*\{/.test(projectChrome), "project layout/tabs must render the board chrome targets");
assert(/\bid\s*=\s*\{/.test(workspaceChrome), "workspace layout/tabs must render its board chrome targets");
assert(
  workspacePage.includes("chromeSlotScope={boardChromeScope}"),
  "workspace board must connect to the shared layout chrome scope",
);
assert(
  boardClient.includes("createPortal") && boardClient.includes("document.getElementById"),
  "board client must portal summary and controls into the shared chrome targets",
);

// Workspace task cards keep their canonical project URL so Next can match the
// cross-tree intercepted route. Soft navigation fills the workspace parallel
// slot; a reload of that canonical URL still lands on the normal project task
// page. The intercepted page must adapt the destination's projectSlug back to
// the existing TaskPage contract instead of duplicating task-detail behavior.
const workspaceSlotBinding = workspaceLayout.match(/workspace\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*params/);
assert(workspaceSlotBinding, "workspace layout must accept the @workspace parallel slot");
assert.match(
  workspaceLayout,
  /workspace\s*:\s*React\.ReactNode/,
  "workspace layout must type the @workspace parallel slot",
);
assert(
  workspaceLayout.includes(`{${workspaceSlotBinding![1]}}`),
  "workspace layout must render the @workspace parallel slot beside its children",
);
assert.match(
  workspacePage,
  /project:\s*\{\s*slug:\s*t\.project\.slug,\s*name:\s*t\.project\.name\s*\}/,
  "workspace board tasks must retain their real project slug for canonical task links",
);
assert.match(
  boardClient,
  /return `\/projects\/\$\{taskProjectSlug\(task, fallbackProjectSlug\)\}\/tasks\/\$\{task\.id\}`;/,
  "board task links must remain canonical project task URLs",
);
assert.match(
  boardClient,
  /return task\.project\?\.slug \?\? fallbackProjectSlug;/,
  "aggregated workspace tasks must prefer their own project slug",
);
assert(
  boardClient.includes('import Link from "next/link"') &&
    boardClient.includes("href={taskHref(task, projectSlug)}"),
  "task-card navigation must use Next Link so the workspace interceptor can preserve the board",
);
assert.match(
  workspaceTaskPane,
  /import TaskPage from "@\/app\/\(app\)\/projects\/\[slug\]\/tasks\/\[taskId\]\/page";/,
  "workspace interceptor must reuse the canonical project task page",
);
assert.match(
  workspaceTaskPane,
  /params:\s*Promise<\{\s*slug:\s*string;\s*projectSlug:\s*string;\s*taskId:\s*string\s*\}>/,
  "workspace interceptor must retain both workspace and destination project params",
);
assert.match(
  workspaceTaskPane,
  /params=\{Promise\.resolve\(\{\s*slug:\s*projectSlug,\s*taskId\s*\}\)\}/s,
  "workspace interceptor must pass the destination project slug to TaskPage",
);
assert(
  workspaceTaskPane.includes("accessibleTaskWhere") &&
    workspaceTaskPane.includes("workspaceAccessWhere") &&
    workspaceTaskPane.includes("archivedAt: null") &&
    workspaceTaskPane.includes("deletedAt: null") &&
    workspaceTaskPane.includes("slug: projectSlug") &&
    workspaceTaskPane.includes("slug: workspaceSlug"),
  "workspace interceptor must restrict the task to an active project in the current accessible workspace",
);
assert.match(
  workspaceTabs,
  /interceptedTaskActive\s*=\s*\/\^\\\/projects/,
  "workspace Board tab must remain active while an intercepted project task is open",
);
assert.match(
  workspaceTaskPane,
  /closeHref=\{`\/workspaces\/\$\{workspaceSlug\}`\}/,
  "workspace task pane must close back to the workspace board",
);
assert.match(
  projectTaskPane,
  /closeHref=\{`\/projects\/\$\{slug\}`\}/,
  "project task pane must still close back to the project board",
);
assert.match(
  projectTaskPane,
  /<TaskPage[\s\S]*?\bcontained\s*\/>/,
  "project task interceptor must mark its reused detail surface as pane-contained",
);
assert.match(
  workspaceTaskPane,
  /<TaskPage[\s\S]*?\bcontained\s*\/>/,
  "workspace task interceptor must mark its reused detail surface as pane-contained",
);
assert.match(
  workspaceTaskDefault,
  /return\s+null\s*;/,
  "workspace parallel slot must have an empty default for unmatched routes",
);
assert.match(workspacePane, /closeHref:\s*string/, "shared task pane must accept a context-specific close URL");
assert(
  workspacePane.includes("<TaskCloseHrefContext.Provider value={closeHref}>"),
  "shared task pane must publish its context-specific close URL to the task header",
);
assert(
  closeTaskButton.includes("useTaskCloseHref(`/projects/${slug}`)") &&
    closeTaskButton.includes("router.push(closeHref)"),
  "the task close button must return to the hosting board and fall back to the project board",
);
assert(
  workspacePane.includes("usePathname()") && workspacePane.includes("if (!open) return null;") &&
    workspacePane.includes("data-ws-open"),
  "shared task pane must hide stale parallel-route content after leaving a task URL",
);

assertStickyToolbar(projectTabs, "project toolbar");
assertStickyToolbar(workspaceTabs, "workspace toolbar");
assertToolbarName(projectTabs, "project toolbar");
assertToolbarName(workspaceTabs, "workspace toolbar");
assert.equal(attributeOccurrences(projectLayout, "data-board-layout"), 1, "project layout must scope sticky board CSS variables");
assert.equal(attributeOccurrences(workspaceLayout, "data-board-layout"), 1, "workspace layout must scope sticky board CSS variables");
for (const [layoutSource, label] of [
  [projectLayout, "project layout"],
  [workspaceLayout, "workspace layout"],
] as const) {
  const layoutTag = openingTagWithMarker(layoutSource, "data-board-layout", label);
  assertClasses(
    classTokens(layoutTag.tag, label),
    [
      "[--page-available-height:calc(100dvh-5.5rem)]",
      "[--page-sticky-top:4.5rem]",
      "[--board-available-height:var(--page-available-height)]",
      "[--board-sticky-top:var(--page-sticky-top)]",
    ],
    label,
  );
}
for (const [tabsSource, label] of [
  [projectTabs, "project toolbar"],
  [workspaceTabs, "workspace toolbar"],
] as const) {
  assert(
    tabsSource.includes("useBoardToolbarGeometry(toolbarRef)"),
    `${label} must publish its measured sticky floor and remaining viewport height`,
  );
}
assert(
  boardToolbarGeometry.includes("boardStickyTop({") &&
    boardToolbarGeometry.includes("window.visualViewport?.height ?? window.innerHeight") &&
    boardToolbarGeometry.includes('setProperty("--page-sticky-top"') &&
    boardToolbarGeometry.includes('setProperty("--page-available-height"'),
  "outer toolbar geometry must publish page sticky variables from the live viewport",
);
assert(
  boardToolbarGeometry.includes("new ResizeObserver(measure)") &&
    boardToolbarGeometry.includes("observer?.observe(toolbar)"),
  "outer toolbar geometry must react when the sticky tab row changes height",
);
assert(
  boardClient.includes('closest("[data-board-layout]")') ||
    boardClient.includes("closest('[data-board-layout]')"),
  "board measurement must publish shared sticky geometry on its project/workspace layout",
);
assert(
  boardClient.includes('setProperty("--board-sticky-top"') &&
    boardClient.includes('setProperty("--board-available-height"'),
  "board measurement must publish both the sticky floor and remaining viewport height",
);

assert.equal(attributeOccurrences(boardClient, "data-board-surface"), 1, "desktop board must render one sticky surface");
assert.equal(attributeOccurrences(boardClient, "data-board-sticky-track"), 1, "desktop board must render one sticky travel track");
const trackTag = openingTagWithMarker(boardClient, "data-board-sticky-track", "desktop board sticky track");
const trackClasses = classTokens(trackTag.tag, "desktop board sticky track");
assert(
  trackClasses.has("4xl:min-h-[calc(100dvh-var(--board-sticky-top))]"),
  "ultrawide sticky track must provide enough parent height for the board and task pane to travel",
);
assert.match(
  globalStyles,
  /@media\s*\(min-width:\s*160rem\)[\s\S]*?main:has\(\[data-board-sticky-track\]\)[\s\S]*?padding-bottom:\s*0/,
  "ultrawide board routes must remove shell padding that would scroll beyond the sticky track",
);
const surfaceTag = openingTagWithMarker(boardClient, "data-board-surface", "desktop board surface");
const surfaceClasses = classTokens(surfaceTag.tag, "desktop board surface");
assert(
  [...surfaceClasses].some((token) => /(?:^|:)sticky$/.test(token)),
  "ultrawide board surface must remain sticky beneath the toolbar",
);
assert(
  [...surfaceClasses].some((token) => /(?:^|:)top-\[var\(--board-sticky-top(?:,[^)]+)?\)\]$/.test(token)),
  "ultrawide board surface must use the measured toolbar floor as its sticky top",
);
assertClasses(
  surfaceClasses,
  ["4xl:h-[var(--board-available-height)]", "4xl:max-h-[var(--board-available-height)]", "min-h-0"],
  "desktop board surface",
);
assert(
  !surfaceClasses.has("h-[var(--board-available-height)]") &&
    !surfaceClasses.has("max-h-[var(--board-available-height)]"),
  "viewport-bounded board height must remain scoped to ultrawide screens",
);

assert.equal(attributeOccurrences(boardClient, "data-board-columns"), 1, "desktop board must render one marked column grid");
const columnsTag = openingTagWithMarker(boardClient, "data-board-columns", "desktop board columns");
const columnsClasses = classTokens(columnsTag.tag, "desktop board columns");
assertClasses(columnsClasses, ["grid", "4xl:h-full", "4xl:min-h-0"], "desktop board columns");
const usesMeasuredHeight = surfaceClasses.has("4xl:h-[var(--board-available-height)]") &&
  surfaceClasses.has("4xl:max-h-[var(--board-available-height)]");
if (usesMeasuredHeight) {
  const surfaceRef = surfaceTag.tag.match(/ref=\{([A-Za-z_$][\w$]*)\}/)?.[1];
  assert(surfaceRef, "measured board height must attach a ref to the sticky board surface");
  assert(boardClient.includes(`${surfaceRef}.current`), "measured board height must read the sticky board surface ref");
  assert(boardClient.includes("getBoundingClientRect()"), "measured board height must use the grid's on-screen top");
  assert(boardClient.includes("window.innerHeight"), "measured board height must use the current viewport height");
  assert(
    boardClient.includes('setProperty("--board-available-height"'),
    "measured board height must publish the result to the grid CSS variable",
  );

  // Supplied 3413×1295 reference: a lane beginning around y=210 must end
  // inside the viewport on first paint, then expand once the 50px toolbar
  // sticks at the top while retaining the 16px bottom breathing room.
  assert.equal(
    boardStickyTop({
      toolbarHeight: 50,
      toolbarMargin: 20,
      obstructionStickyTop: 64,
      obstructionHeight: 54,
      obstructionMargin: 16,
    }),
    134,
    "selection controls must move the shared board/task sticky floor below themselves",
  );
  assert.equal(
    boardAvailableHeight({
      viewportHeight: 1295,
      columnsTop: 210,
      toolbarHeight: 50,
      toolbarBottom: 170,
      toolbarMargin: 20,
    }),
    1069,
    "reference-size board must fit below its actual initial top",
  );
  assert.equal(
    boardAvailableHeight({
      viewportHeight: 1295,
      columnsTop: 70,
      toolbarHeight: 50,
      toolbarBottom: 50,
      toolbarMargin: 20,
    }),
    1209,
    "board must expand to the viewport space below the sticky toolbar",
  );
  assert.equal(
    boardAvailableHeight({
      viewportHeight: 1295,
      columnsTop: 1100,
      toolbarHeight: 50,
      toolbarBottom: 50,
      toolbarMargin: 20,
    }),
    179,
    "a short remaining viewport must not be inflated by a minimum lane height",
  );
  assert.equal(
    boardAvailableHeight({
      viewportHeight: 1295,
      columnsTop: 100,
      toolbarHeight: 50,
      toolbarBottom: 50,
      toolbarMargin: 20,
      obstructionStickyTop: 64,
      obstructionHeight: 54,
      obstructionBottom: 118,
      obstructionMargin: 16,
    }),
    1145,
    "a sticky selection toolbar must reduce the lanes' available height",
  );
}

assert.equal(attributeOccurrences(boardClient, "data-board-lane"), 1, "desktop lane must render one marked lane wrapper");
assert.equal(attributeOccurrences(boardClient, "data-board-lane-scroll"), 1, "desktop lane must render one marked scroll body");
assert(
  boardClient.includes("data-board-selection-toolbar") && boardClient.includes("obstructionStickyTop"),
  "the viewport measurement must account for the sticky selection toolbar",
);

const laneTag = openingTagWithMarker(boardClient, "data-board-lane", "desktop board lane");
const laneClasses = classTokens(laneTag.tag, "desktop board lane");
assertClasses(
  laneClasses,
  ["flex", "min-h-[30rem]", "flex-col", "4xl:h-full", "4xl:min-h-0", "4xl:overflow-hidden"],
  "desktop board lane",
);

const laneScrollTag = openingTagWithMarker(boardClient, "data-board-lane-scroll", "desktop board lane scroll body");
const laneScrollClasses = classTokens(laneScrollTag.tag, "desktop board lane scroll body");
assertClasses(
  laneScrollClasses,
  ["min-h-0", "flex-1", "4xl:overflow-y-auto", "4xl:overscroll-contain"],
  "desktop board lane scroll body",
);

// The Tasks grid and canonical Epic/Task views share one viewport surface.
// It sticks immediately below the outer project tabs on ultrawide screens,
// measures the remaining viewport at runtime, and owns the vertical scrollbar.
// An intercepted Task reuses the same component in contained mode inside the
// already positioned project/workspace pane without publishing competing
// outer geometry.
assert.equal(
  attributeOccurrences(stickyViewportSurface, "data-sticky-viewport-track"),
  1,
  "shared sticky viewport must render one travel track",
);
assert.equal(
  attributeOccurrences(stickyViewportSurface, "data-sticky-viewport-surface"),
  1,
  "shared sticky viewport must render one bounded surface",
);
for (const [marker, label] of [
  ["data-tasks-grid-surface", "Tasks grid"],
  ["data-epic-detail-surface", "Epic detail"],
  ["data-task-detail-surface", "Task detail"],
] as const) {
  assert.equal(
    attributeOccurrences(stickyViewportSurface, marker),
    1,
    `${label} must have an explicit shared-surface marker`,
  );
}
for (const token of [
  "min-w-0",
  "[--detail-header-height:70px]",
  "[--detail-sticky-top:var(--page-sticky-top)]",
  "[--detail-tabs-height:2.75rem]",
] as const) {
  assert(
    stickyViewportSurface.includes(token),
    `shared sticky viewport surface must include ${token}`,
  );
}
for (const token of [
  "4xl:sticky",
  "4xl:top-[var(--page-sticky-top)]",
  "4xl:h-[var(--sticky-viewport-height)]",
  "4xl:max-h-[var(--page-available-height)]",
  "4xl:overflow-y-auto",
  "4xl:overflow-y-visible",
] as const) {
  assert(
    stickyViewportSurface.includes(token),
    `non-contained sticky viewport surface must include ${token}`,
  );
}
for (const token of [
  "4xl:h-full",
  "4xl:min-h-0",
  "4xl:max-h-full",
  "4xl:overflow-y-auto",
  "4xl:overscroll-contain",
] as const) {
  assert(
    stickyViewportSurface.includes(token),
    `contained sticky viewport surface must include ${token}`,
  );
}
assert(
  /const overflowClass = contained\s*\? ""\s*:\s*viewportScrollActive\s*\? "4xl:overflow-y-auto"\s*:\s*"4xl:overflow-y-visible";/s.test(stickyViewportSurface),
  "non-contained surface must keep document scrolling before stick and enable its own scrollbar afterward",
);
assert(
  /const detailStickyOriginClass = contained \|\| viewportScrollActive\s*\? "4xl:\[--detail-sticky-top:0px\]"\s*:\s*"";/s.test(stickyViewportSurface),
  "detail sticky offsets must stay page-relative until a non-contained surface reaches its sticky floor",
);
assert(
  /const viewportClass = contained\s*\? "4xl:h-full 4xl:min-h-0 4xl:max-h-full 4xl:overflow-y-auto 4xl:overscroll-contain"\s*:\s*"4xl:sticky 4xl:top-\[var\(--page-sticky-top\)\] 4xl:h-\[var\(--sticky-viewport-height\)\] 4xl:max-h-\[var\(--page-available-height\)\]";/s.test(stickyViewportSurface),
  "contained surface must always own its bounded vertical scrollbar",
);
assert(
  stickyViewportSurface.includes("${detailStickyOriginClass} ${viewportClass} ${overflowClass}"),
  "shared viewport surface must consume its sticky-origin, viewport, and overflow class decisions",
);
assert(
  stickyViewportSurface.includes("[--sticky-viewport-height:var(--page-available-height)]") &&
    stickyViewportSurface.includes("4xl:min-h-[calc(100dvh-var(--page-sticky-top))]"),
  "non-contained sticky viewport track must default to the page height and provide sticky travel",
);
assert(
  stickyViewportSurface.includes("surface.getBoundingClientRect().top") &&
    stickyViewportSurface.includes("boardAvailableHeight({") &&
    stickyViewportSurface.includes('track.style.setProperty("--sticky-viewport-height"'),
  "non-contained sticky viewport must derive its live height from its on-screen top",
);
assert(
  stickyViewportSurface.includes("const [viewportScrollActive, setViewportScrollActive] = useState(false)") &&
    stickyViewportSurface.includes("const surfaceTop = surface.getBoundingClientRect().top") &&
    stickyViewportSurface.includes("const next = surfaceTop <= stickyTop + 0.5") &&
    stickyViewportSurface.includes("setViewportScrollActive((current) =>"),
  "non-contained surface must activate viewport scrolling only after reaching the outer tab floor",
);
assert(
  stickyViewportSurface.includes("if (contained || !layout) return;") &&
    stickyViewportSurface.includes('data-sticky-viewport-contained={contained ? "true" : undefined}'),
  "contained detail surfaces must not overwrite their host board/list geometry",
);
assert(
  stickyViewportSurface.includes('surface.querySelector("[data-detail-header]")') &&
    stickyViewportSurface.includes('surface.style.setProperty("--detail-header-height"') &&
    stickyViewportSurface.includes("observer?.observe(detailHeader)"),
  "detail surfaces must measure wrapping editor headers for the inner tab offset",
);
assert(
  stickyViewportSurface.includes('surface.querySelector("[data-detail-tabs]")') &&
    stickyViewportSurface.includes('surface.style.setProperty("--detail-tabs-height"') &&
    stickyViewportSurface.includes("observer?.observe(detailTabs)") &&
    stickyViewportSurface.includes('surface.style.removeProperty("--detail-tabs-height")'),
  "detail surfaces must measure and clean up the inner tab-row height",
);
assert.equal(
  occurrences(projectTasksPage, '<StickyViewportSurface kind="tasks-grid">'),
  1,
  "Tasks tab must use the shared sticky viewport surface",
);
assert.equal(
  occurrences(epicPage, '<StickyViewportSurface kind="epic-detail">'),
  1,
  "Epic detail must use the shared sticky viewport surface",
);
assert.equal(
  occurrences(taskPage, '<StickyViewportSurface kind="task-detail" contained={contained}>'),
  1,
  "Task detail must switch the shared sticky viewport between canonical and contained modes",
);
assert.match(taskPage, /contained\s*=\s*false/, "canonical Task detail must default to a non-contained surface");

assert.equal(attributeOccurrences(workspacePane, "data-task-pane-scroll"), 1, "task workspace must render one bounded pane body");
const paneClasses = classTokens(paneTag.tag, "task workspace pane");
assert(
  [...paneClasses].some((token) => /(?:^|:)sticky$/.test(token)),
  "ultrawide task workspace must stick beneath the board toolbar",
);
assert(
  [...paneClasses].some((token) => /(?:^|:)top-\[var\(--board-sticky-top(?:,[^)]+)?\)\]$/.test(token)),
  "ultrawide task workspace must share the board toolbar sticky floor",
);
assert(
  paneClasses.has("4xl:h-[var(--board-available-height)]"),
  "ultrawide task workspace must fill the available viewport height",
);
assert(
  paneClasses.has("4xl:max-h-[var(--board-available-height)]"),
  "ultrawide task workspace must not exceed the available viewport height",
);
assert(
  [...paneClasses].some((token) => /(?:^|:)overflow-hidden$/.test(token)),
  "bounded task workspace must keep scrolling on its inner body",
);
const paneScrollTag = openingTagWithMarker(workspacePane, "data-task-pane-scroll", "task workspace scroll body");
const paneScrollClasses = classTokens(paneScrollTag.tag, "task workspace scroll body");
for (const token of ["min-h-0", "flex-1", "overflow-hidden"] as const) {
  assert(
    paneScrollClasses.has(`4xl:${token}`),
    `task workspace scroll body must include ${token} at its split breakpoint`,
  );
}
assert(
  !paneScrollClasses.has("4xl:overflow-y-auto") && !paneScrollClasses.has("4xl:overscroll-contain"),
  "task workspace body must delegate vertical scrolling to its contained detail surface",
);
assert.equal(attributeOccurrences(taskPage, "data-task-header"), 1, "task detail must render one marked editor header");
const taskHeaderTag = openingTagWithMarker(taskPage, "data-task-header", "task editor header");
assert.equal(attributeOccurrences(taskPage, "data-detail-header"), 1, "task detail must expose one measurable editor header");
assertClasses(
  classTokens(taskHeaderTag.tag, "task editor header"),
  ["sticky", "top-[var(--detail-sticky-top)]", "z-20"],
  "task editor header",
);
assert.equal(attributeOccurrences(epicPage, "data-epic-header"), 1, "Epic detail must render one marked editor header");
assert.equal(attributeOccurrences(epicPage, "data-detail-header"), 1, "Epic detail must expose one measurable editor header");
const epicHeaderTag = openingTagWithMarker(epicPage, "data-epic-header", "Epic editor header");
assertClasses(
  classTokens(epicHeaderTag.tag, "Epic editor header"),
  ["sticky", "top-[var(--detail-sticky-top)]", "z-20"],
  "Epic editor header",
);
assert(
  taskTabs.includes("sticky top-[calc(var(--detail-sticky-top)+var(--detail-header-height))] z-10"),
  "Task/Epic inner tabs must stick immediately below the measured editor header",
);
assert.equal(
  attributeOccurrences(taskTabs, "data-detail-tabs"),
  1,
  "shared Task/Epic tabs must expose one measurable sticky-row marker",
);
assert(
  taskTabs.includes('data-detail-tabs={sticky ? "" : undefined}'),
  "only sticky Task/Epic tab rows must participate in detail geometry",
);
assert(
  !taskTabs.includes("top-[70px]"),
  "Task/Epic inner tabs must not retain the old fixed viewport offset",
);
const detailSidebarTop = "xl:top-[calc(var(--detail-sticky-top)+var(--detail-header-height)+var(--detail-tabs-height)+1rem)]";
for (const [detailSource, label] of [
  [taskPage, "Task detail sidebar"],
  [epicPage, "Epic detail sidebar"],
] as const) {
  assert.equal(
    occurrences(detailSource, detailSidebarTop),
    1,
    `${label} must render once below the complete sticky detail chrome`,
  );
  const sidebarTag = openingTags(detailSource).find((tag) => hasClass(tag, detailSidebarTop));
  assert(sidebarTag, `${label} must put its calculated top on the sidebar element`);
  assertClasses(
    classTokens(sidebarTag, label),
    ["xl:sticky", detailSidebarTop, "xl:self-start"],
    label,
  );
}

// The bounded, nested scrollers are a desktop-only enhancement. Mobile keeps
// its existing details groups and document-level vertical scrolling.
assert(boardClient.includes("isMobileBoard ?"), "board must retain its separate mobile rendering branch");
assert(
  openingTags(boardClient).some((tag) => hasClass(tag, "md:hidden")),
  "mobile board groups must remain visible below md",
);
assert(
  openingTags(boardClient).some((tag) => hasClass(tag, "md:block")),
  "desktop board columns must remain hidden below md",
);
const mobileGroup = boardClient.slice(
  boardClient.indexOf("function MobileStatusGroup"),
  boardClient.indexOf("function MobileTaskCard"),
);
assert(!mobileGroup.includes("data-board-lane"), "mobile groups must not inherit desktop lane scroll markers");
assert(!mobileGroup.includes("overflow-y-auto"), "mobile groups must keep document-level vertical scrolling");

// Task-detail sidebar widgets keep their information dense and scan-friendly
// in both the canonical task route and the shared project/workspace pane.
// Explicit markers make the contract resilient to copy and styling changes
// while still pinning down grid shape, visual order, and actor/date order.
assert.equal(attributeOccurrences(taskPage, "data-task-dates"), 1, "task detail must render one dates widget");
const datesTag = openingTagWithMarker(taskPage, "data-task-dates", "task dates widget");
const datesClasses = classTokens(datesTag.tag, "task dates widget");
// One stacked row per date: label, actor avatar, actor name, then the
// timestamp pushed to the right edge.
assertClasses(datesClasses, ["space-y-2"], "task dates widget");
assert.equal(attributeOccurrences(taskPage, "data-task-date"), 3, "task dates widget must always render three date cells");
const datePositions = markerPositions(taskPage, "data-task-date(?=[\\s=>])");
const datesRegionEnd = taskPage.indexOf("</dl>", datesTag.start);
assert(datesRegionEnd > datesTag.start, "task dates widget must close its list");
assert(
  taskPage.indexOf("data-task-roles") < datesTag.start,
  "the roles widget must precede the dates widget in the task sidebar",
);
const dateLabels = ["Created", "Last updated", "Completed"] as const;
datePositions.forEach((start, index) => {
  const end = datePositions[index + 1] ?? datesRegionEnd;
  const cell = taskPage.slice(start, end);
  assert(cell.includes(dateLabels[index]!), `task date cell ${index + 1} must be ${dateLabels[index]}`);
  const avatarIndex = cell.indexOf("<MessageAvatar");
  const timeIndex = cell.indexOf("<time");
  assert(avatarIndex >= 0, `${dateLabels[index]} date must retain its actor avatar`);
  assert(timeIndex > avatarIndex, `${dateLabels[index]} avatar must render to the left of its date`);
});
assert(
  !taskPage.slice(datesTag.start, datesRegionEnd).includes("Approved"),
  "Approved date must stay out of the dates widget",
);
assert(
  taskPage.includes("const doneActivity = allActivity.find") &&
    taskPage.includes("const updatedActivity = allActivity.find"),
  "Done and Updated actors must derive from raw activity before safe identity projection",
);
assert(
  taskPage.includes("const doneAt = doneActivity?.createdAt") &&
    taskPage.includes("serializeVisibleActor(doneActivity?.user"),
  "Done history must keep its matching date and safely projected actor after a task is reopened",
);

assert.equal(attributeOccurrences(taskPage, "data-task-roles"), 1, "task detail must render one roles widget");
const rolesTag = openingTagWithMarker(taskPage, "data-task-roles", "task roles widget");
const rolesClasses = classTokens(rolesTag.tag, "task roles widget");
assertClasses(rolesClasses, ["grid", "grid-cols-2"], "task roles widget");
assert.equal(attributeOccurrences(taskPage, "data-task-role"), 4, "task roles widget must render four cells");
const rolePositions = markerPositions(taskPage, "data-task-role(?=[\\s=>])");
const sourceControlStart = taskPage.indexOf("data-task-source-control", rolePositions.at(-1));
assert(sourceControlStart > rolePositions.at(-1)!, "task source-control widget must follow the roles widget");
const roleLabels = ["Reported by", "Assignee", "Reviewer", "Approved date"] as const;
rolePositions.forEach((start, index) => {
  const end = rolePositions[index + 1] ?? sourceControlStart;
  assert(
    taskPage.slice(start, end).includes(roleLabels[index]!),
    `task role cell ${index + 1} must be ${roleLabels[index]}`,
  );
});
const rolesRegion = taskPage.slice(rolesTag.start, sourceControlStart);
assert(!rolesRegion.includes("DeploymentStatusSelect"), "deployment status must not remain in the roles widget");
assert.equal(attributeOccurrences(rolesRegion, "data-task-approved"), 1, "Approved date must follow Reviewer once");
const approvedStart = rolesRegion.indexOf("data-task-approved");
const approvedRegion = rolesRegion.slice(approvedStart);
assert(approvedRegion.includes("<time"), "Approved date must render as a date after Reviewer");
assert(
  approvedRegion.includes("showApproverAvatar && visibleApprover"),
  "Approved date must only render its approver avatar when the reviewer differs",
);
assert(
  taskPage.includes("task.approvedById !== task.actingManagerId"),
  "approver/reviewer avatar suppression must compare their raw identities",
);

assert.equal(attributeOccurrences(taskPage, "data-task-source-control"), 1, "task detail must render one source-control widget");
assert.equal(attributeOccurrences(taskPage, "data-task-commit-deployment"), 1, "commit and deployment controls must share one row");
const commitDeploymentTag = openingTagWithMarker(taskPage, "data-task-commit-deployment", "commit/deployment row");
assertClasses(classTokens(commitDeploymentTag.tag, "commit/deployment row"), ["grid", "grid-cols-2"], "commit/deployment row");
const sourceControlEnd = taskPage.indexOf("{/* Blocked by", sourceControlStart);
const sourceControlRegion = taskPage.slice(sourceControlStart, sourceControlEnd);
const commitPrefixIndex = sourceControlRegion.indexOf("Commit prefix");
const deploymentIndex = sourceControlRegion.indexOf("DeploymentStatusSelect");
assert(
  commitPrefixIndex >= 0 && deploymentIndex > commitPrefixIndex,
  "Deployment status must render after Commit Prefix in the shared two-column row",
);

// Every board surface renders one card layout — there is no density switch and
// no per-surface variant. The card is a two-column grid: a 42px identity rail
// (select box, primary avatar, Done-only reviewer avatar) beside explicitly
// placed content rows (meta strip, title, scope links, epic, progress).
assert.equal(occurrences(boardClient, "<BoardCardBody"), 2, "desktop and mobile cards must share one card body");
assert.equal(attributeOccurrences(boardClient, "data-board-card-grid"), 1, "the shared card body must define one card grid");
const cardGridTag = openingTagWithMarker(boardClient, "data-board-card-grid", "board card grid");
assertClasses(
  classTokens(cardGridTag.tag, "board card grid"),
  ["grid", "grid-cols-[2.625rem_minmax(0,1fr)]"],
  "board card grid",
);
assert(
  !boardClient.includes("pm.board.compact.") && !boardClient.includes("DensityIcon"),
  "the board must not keep a compact/comfortable density preference",
);
const cardBodyRegion = boardClient.slice(
  boardClient.indexOf("function BoardCardBody"),
  boardClient.indexOf("function BoardAvatar"),
);
for (const [marker, rowStart, label] of [
  ["data-board-card-avatar", "row-start-2", "identity rail"],
  ["data-board-card-scope", "row-start-3", "workspace/project scope links"],
] as const) {
  assert.equal(attributeOccurrences(boardClient, marker), 1, `board card must render one ${label} slot`);
  const tag = openingTagWithMarker(cardBodyRegion, marker, `board card ${label}`);
  assert(
    classTokens(tag.tag, `board card ${label}`).has(rowStart),
    `board card ${label} must stay on its fixed row (${rowStart})`,
  );
}
// Both identities share the rail cell: the reviewer badges the builder's
// avatar rather than claiming a row of its own.
assert.equal(attributeOccurrences(boardClient, "data-board-card-reviewer"), 1, "board card must render one reviewer badge");
const reviewerTag = openingTagWithMarker(cardBodyRegion, "data-board-card-reviewer", "board card reviewer badge");
assertClasses(
  classTokens(reviewerTag.tag, "board card reviewer badge"),
  ["absolute", "rounded-full"],
  "board card reviewer badge",
);
assert(
  cardBodyRegion.indexOf("data-board-card-avatar") < cardBodyRegion.indexOf("data-board-card-reviewer") &&
    cardBodyRegion.indexOf("data-board-card-reviewer") < cardBodyRegion.indexOf("data-board-card-scope"),
  "the reviewer badge must live inside the identity rail, above the scope line",
);
// The epic shares the scope row when there is one, and only claims its own
// row on a project board (which serialises no scope at all).
assert.equal(attributeOccurrences(boardClient, "data-board-card-epic"), 2, "each epic branch must mark itself once");
assert(
  cardBodyRegion.includes("{epicNode}") && cardBodyRegion.includes("const hasScope ="),
  "the epic must be rendered from one node reused by both the scope row and its standalone row",
);
assert(
  cardBodyRegion.includes('task.status === "Done" ? task.reviewer ?? task.manager ?? task.reporter : null'),
  "only Done cards may credit a reviewer, resolved reviewer → epic manager → reporter",
);
assert(
  cardBodyRegion.includes("const workspaceSlug = task.project?.workspace?.slug ?? null") &&
    cardBodyRegion.includes("const scopeProjectSlug = task.project?.slug ?? null"),
  "scope links must be derived from the serialized project/workspace, so a project board renders none",
);
assert(
  cardBodyRegion.includes("href={`/workspaces/${workspaceSlug}`}") &&
    cardBodyRegion.includes("href={`/projects/${scopeProjectSlug}`}") &&
    cardBodyRegion.includes("href={`/projects/${cardProjectSlug}/epics/${task.epicId}`}"),
  "workspace, project and epic labels must link to their hub pages",
);
// Selection and drag are hover-revealed on pointer devices (like the bin
// button) but always visible on touch, where there is no hover.
assert(
  /const hoverOnly = selected\s*\?\s*"opacity-100"\s*:\s*"opacity-100 md:opacity-0 md:group-hover\/card:opacity-100 md:focus-visible:opacity-100";/s.test(cardBodyRegion),
  "card checkbox and drag handle must reveal on card hover while staying visible on touch and when selected",
);
assert.equal(occurrences(cardBodyRegion, "${hoverOnly}"), 2, "exactly the checkbox and drag handle may be hover-revealed");
assert(
  boardClient.includes("<MessageAvatar actor={actor} size={size}") &&
    boardClient.includes('size?: "lg" | "sm" | "xs"') &&
    boardClient.includes("h-[2.625rem] w-[2.625rem]"),
  "board identity avatars must default to the fixed 42px size with smaller badge variants",
);
assert(
  boardClient.includes("group/avatar") && boardClient.includes("group-hover/avatar:block"),
  "board avatars must reveal the actor name on hover",
);
assert.equal(
  attributeOccurrences(boardClient, "data-board-card-progress"),
  1,
  "the card progress bar must have one renderer",
);
assert(
  boardClient.includes("const percent = Math.round((d / n) * 100)") &&
    boardClient.includes("{percent}% · {d}/{n}"),
  "the card progress bar must read as a percentage plus its raw count",
);
assert(
  boardClient.includes('fill: "var(--status-progress)"') && boardClient.includes('fill: "var(--status-review)"'),
  "the card progress bar must take its fill from the phase's status colour",
);

assert.equal(attributeOccurrences(taskPage, "data-task-actions"), 1, "task detail must group archive and danger actions");
const actionsTag = openingTagWithMarker(taskPage, "data-task-actions", "task action widgets");
const actionsClasses = classTokens(actionsTag.tag, "task action widgets");
assertClasses(actionsClasses, ["grid", "grid-cols-2"], "task action widgets");
const actionsRegion = taskPage.slice(actionsTag.start);
assert(
  actionsRegion.indexOf("Archive") >= 0 && actionsRegion.indexOf("Danger zone") > actionsRegion.indexOf("Archive"),
  "task action row must place Archive before Danger zone",
);

// One task-wide quick-add menu owns every bottom-corner creation action. It is
// mounted outside the kept-mounted/hidden TabPanels and portals into a pane-
// anchored slot on ultrawide project and workspace boards.
assert.equal(attributeOccurrences(workspacePane, "data-task-fab-slot"), 1, "task workspace must expose one FAB portal target");
const fabSlotTag = openingTagWithMarker(workspacePane, "data-task-fab-slot", "task workspace FAB slot");
assertClasses(
  classTokens(fabSlotTag.tag, "task workspace FAB slot"),
  ["pointer-events-none", "fixed", "z-40", "4xl:absolute"],
  "task workspace FAB slot",
);
assert.equal(occurrences(taskPage, "<TaskQuickAddFab"), 1, "task detail must mount one unified quick-add menu");
assert(
  taskPage.lastIndexOf("</TabPanel>") < taskPage.indexOf("<TaskQuickAddFab"),
  "task quick-add menu must be mounted outside every hidden task tab panel",
);
assert(taskQuickAdd.includes("createPortal(content, paneSlot)"), "task quick-add menu must portal into the open pane slot");
assert(
  taskQuickAdd.includes('document.querySelector<HTMLElement>("[data-task-fab-slot]")'),
  "task quick-add menu must resolve the task workspace portal target",
);
for (const marker of [
  'aria-haspopup="menu"',
  "aria-expanded={menuOpen}",
  'role="menu"',
  'aria-label="Add to Mission Control"',
] as const) {
  assert(taskQuickAdd.includes(marker), `task quick-add menu must include ${marker}`);
}
for (const label of ["New project", "New epic", "New task", "Attachments", "Comment"] as const) {
  assert(taskQuickAdd.includes(`label="${label}"`), `task quick-add menu must expose ${label}`);
}
assert(taskQuickAdd.includes('href="/projects?newProject=1"'), "New project must hand off to the established project creator");
assert(taskQuickAdd.includes("/epics?newEpic=1"), "New epic must hand off to the current project's creator");
assert(taskQuickAdd.includes("?newTask=1"), "New task must hand off to the current project's creator");
assert(addProjectFab.includes('params.get("newProject") !== "1"'), "project creator must consume the quick-add handoff");
assert(newEpicFab.includes('params.get("newEpic") !== "1"'), "epic creator must consume the quick-add handoff");
assert(addTaskFab.includes('params.get("newTask") !== "1"'), "task creator must consume the quick-add handoff");
assert(taskQuickAdd.includes("<AttachmentUploadFab") && taskQuickAdd.includes("hideTrigger"), "attachment dialog must be controlled by the unified menu");
assert(taskQuickAdd.includes("<CommentComposerFab"), "comment dialog must be controlled by the unified menu");
assert(!taskPage.includes("<AttachmentUploadFab"), "attachment dialog must not remain inside the hidden Attachments panel");
assert(!taskPage.includes("<CommentComposerFab"), "comment dialog must not remain inside the hidden Comments panel");
assert(attachmentFab.includes("open: controlledOpen") && attachmentFab.includes("targets: targetOptions"), "attachment dialog must support controlled opening and scoped targets");
assert(commentFab.includes("open: controlledOpen"), "comment dialog must support controlled opening from any active tab");
assert(addTaskFab.includes("!taskOpen && !hideTrigger ? ("), "the project New task FAB must yield to the task-wide menu on task routes and to the shared board (+) speed-dial");
assert(!addTaskFab.includes("getClientRects()"), "quick-add layout must not depend on hidden-tab geometry");
for (const [source, label] of [
  [decomposedChatRoom, "action-plan composer"],
  [legacyChatRoom, "legacy action-plan composer"],
] as const) {
  assert.equal(attributeOccurrences(source, "data-task-quick-action"), 1, `${label} must register with the unified menu`);
}
assert(globalStyles.includes('[data-task-quick-add-context] [data-task-quick-action="action-plan"]'), "the legacy task action-plan FAB must be visually consolidated into quick-add");

console.log("board layout contract ok");
