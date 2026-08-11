// ENV-123 — the visibility contract.
//
// The task description's actual requirement is a UI one: "Operators should no
// longer need to infer execution state from comments." The detectors and
// repairs can all be correct and that requirement can still be unmet, because
// nothing renders the row. The logic suites cannot catch that — a deleted
// `<TaskExecutionStrip />` breaks no assertion in either of them.
//
// So this suite pins the wiring itself, the way scripts/board-blocker-indicator-test.ts
// pins the board's lock badge: the query selects it, the page renders it, the
// board carries it, and the agent context packet includes it.
//
// Exit 0 on success, non-zero on the first failed assertion.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  executionStateLines,
  renderExecutionState,
} from "../lib/agents/watchdog/state";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

let checks = 0;

function fail(message: string): never {
  console.error(`[workflow-watchdog-visibility] FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: unknown, label: string): asserts condition {
  checks += 1;
  if (!condition) fail(label);
}

// ------------------------------------------------------------------
// Task detail page: the four-line strip
// ------------------------------------------------------------------
const strip = read("components/task-execution-strip.tsx");
assert(
  strip.includes("renderExecutionState"),
  "the strip renders through the shared formatter rather than formatting its own lines",
);
assert(
  strip.includes("if (!executionState) return null"),
  "a task with no execution-state row renders nothing — 'never evaluated' must not read as 'idle'",
);
for (const label of ["Execution", "Reason", "Last durable action", "Recovery"]) {
  // Either a `label="…"` prop on a Row, or literal JSX text.
  const rendered =
    strip.includes(`label="${label}"`) ||
    new RegExp(`>\\s*${label}\\s*<`).test(strip);
  assert(rendered, `the strip renders the "${label}" line`);
}

const taskPage = read("app/(app)/projects/[slug]/tasks/[taskId]/page.tsx");
assert(
  taskPage.includes("import { TaskExecutionStrip }"),
  "the task page imports the execution strip",
);
assert(
  taskPage.includes("<TaskExecutionStrip executionState={task.executionState} />"),
  "the task page actually renders the strip — the whole point of the task",
);

// The page reads its task through the cached shell, so the shell must select
// the relation or `task.executionState` is silently undefined at runtime.
const cache = read("lib/tasks/cache.ts");
assert(
  cache.includes("executionState: {"),
  "getCachedTaskDetailShell selects the executionState relation",
);
assert(
  cache.includes("actionPlan: {") &&
    cache.includes("version: true") &&
    cache.includes("approvedOn: true"),
  "getCachedTaskDetailShell selects durable Action Plan status for the task banner",
);
for (const column of [
  "state: true",
  "reasonDetail: true",
  "lastDurableAction: true",
  "lastDurableActionAt: true",
  "recoveryAction: true",
]) {
  assert(cache.includes(column), `the cached shell selects ${column} for the strip`);
}

// ------------------------------------------------------------------
// Board: the compact badge
// ------------------------------------------------------------------
const board = read("app/(app)/projects/[slug]/board-client.tsx");
assert(
  board.includes("executionState: string | null"),
  "the board Task type carries the execution state",
);
assert(board.includes("function ExecutionBadge"), "the board defines the execution badge");
assert(
  board.split("<ExecutionBadge task={task} />").length - 1 === 3,
  "every card variant that paints the blocked badge also paints the execution badge",
);
// Painting "running"/"idle" on every card is noise; only actionable states.
assert(
  board.includes("EXECUTION_BADGE_TONE") &&
    board.includes("stalled:") &&
    board.includes("blocked:") &&
    !/EXECUTION_BADGE_TONE[^}]*running:/s.test(board),
  "the badge paints only the states an operator must act on",
);

for (const page of [
  "app/(app)/projects/[slug]/page.tsx",
  "app/(app)/workspaces/[slug]/page.tsx",
  "app/(app)/workspaces/(landing)/page.tsx",
]) {
  const source = read(page);
  assert(
    source.includes("executionState: { select: { state: true, reasonDetail: true } }"),
    `${page} selects the execution state for its board cards`,
  );
  assert(
    source.includes("executionState: t.executionState?.state ?? null"),
    `${page} maps the execution state onto the board task`,
  );
}

// ------------------------------------------------------------------
// Agent context packet
// ------------------------------------------------------------------
const context = read("lib/agents/context/task.ts");
assert(
  context.includes("executionStateLines") && context.includes("renderExecutionState"),
  "the agent context renders through the same shared formatter as the UI",
);
assert(
  context.split("EXECUTION STATE (PM's observation").length - 1 === 2,
  "both the standard packet and the episode brief carry the execution state",
);
assert(
  context.split("executionState: {\n        select: {").length - 1 === 2,
  "both context queries select the relation",
);

// ------------------------------------------------------------------
// Ordinary transitions keep it current
// ------------------------------------------------------------------
const route = read("app/api/agent/tasks/[taskId]/workflow/route.ts");
assert(
  route.includes("recordWorkflowActionExecutionState"),
  "every successful workflow action updates the execution strip, not just watchdog passes",
);
assert(
  route.includes("select: { status: true, projectId: true }"),
  "the post-action read supplies the project id the state row is indexed by",
);

// ------------------------------------------------------------------
// The rendered shape is exactly what the task description asked for
// ------------------------------------------------------------------
{
  const lines = executionStateLines(
    renderExecutionState({
      state: "stalled",
      reasonDetail: "no active run",
      lastDurableAction: "started",
      lastDurableActionAt: new Date(2026, 0, 1, 9, 24),
      recoveryAction: "new run queued",
    }),
  );
  const expected = [
    "Execution: stalled",
    "Reason: no active run",
    "Last durable action: started at 09:24",
    "Recovery: new run queued",
  ];
  for (const [index, line] of expected.entries()) {
    assert(lines[index] === line, `rendered line ${index + 1}: expected "${line}", got "${lines[index]}"`);
  }
}

console.log(`[workflow-watchdog-visibility] OK — ${checks} checks passed`);
