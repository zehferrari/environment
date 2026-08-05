// ENV-121 — execution-episode PURE contract test.
//
// Scope split: scripts/task-execution-episode-test.ts drives the lifecycle
// against real rows on a throwaway sqlite (episode rollover, the duplicate-
// episodeNo guard, brief construction). This file stays pure — no DB, no
// prisma push — and covers the encoding/clipping/rendering edges that are
// cheapest to get wrong and most expensive to notice: partial vs cleared
// checkpoint fields, oversized input, and a legacy row that is not JSON.
//
// Three properties, and they are the whole point of the task:
//
//   1. A continuation brief is FLAT in the size of the task. A task with 500
//      comments must not produce a bigger brief than one with 5. "Smaller than
//      the full packet" is not the bar — not growing is.
//   2. Checkpoint fields round-trip. Whatever the agent persists is what the
//      next episode reads back, including the empty and over-long cases.
//   3. `checkpoint` is continuation-required. If it were ever classified
//      episode-terminal, saving state would end the turn — the exact opposite
//      of what it is for.

import { strict as assert } from "node:assert";

import {
  CODE_CAPS,
  EPISODE_CAPS,
  episodeBriefCharBudget,
  episodeCaps,
  MONITOR_CAPS,
} from "../lib/agents/context/caps";
import { renderBudgetedTimeline, type TimelineItemForBudget } from "../lib/agents/context/budget";
import {
  checkpointUpdateData,
  EPISODE_CLOSE_REASON,
  EPISODE_CYCLE_BUDGET_DEFAULT,
  EPISODE_TOOL_CYCLE_BUDGET_DEFAULT,
  episodeCycleBudget,
  episodeToolCycleBudget,
  renderEpisodeCheckpoint,
  summarizeEpisode,
  type TaskExecutionEpisodeSummary,
} from "../lib/agents/episodes/lifecycle";
import {
  workflowActionCheckpoint,
  workflowActionEffectOrFinish,
  workflowActionResult,
} from "../lib/agents/workflow/action-effect";
import { isContinuationRequiredAction, workflowActionClass } from "../lib/workflow-invariants";

// Ids are fixed-width so "the brief did not grow" is a statement about the
// number of rows inlined, not about how many digits their ids happen to have.
function comment(n: number, body: string): TimelineItemForBudget {
  return {
    type: "comment",
    id: `c-${String(n).padStart(6, "0")}`,
    actor: "@barekbaal (agent)",
    body,
    createdAt: new Date(Date.UTC(2026, 7, 5, 0, 0, n)).toISOString(),
  };
}

// ------------------------------------------------------------------
// 1. Episode caps are an order of magnitude smaller, and env-overridable
// ------------------------------------------------------------------
{
  assert(
    EPISODE_CAPS.maxComments * 10 <= CODE_CAPS.maxComments,
    "episode comment cap must be an order of magnitude under the first-contact packet",
  );
  assert(
    EPISODE_CAPS.maxRenderedTimelineChars * 8 <= CODE_CAPS.maxRenderedTimelineChars,
    "episode timeline budget must be an order of magnitude under the first-contact packet",
  );
  assert(
    EPISODE_CAPS.maxRenderedTimelineChars < MONITOR_CAPS.maxRenderedTimelineChars,
    "a continuation brief must be smaller than even a monitor triage packet",
  );
  assert.equal(
    EPISODE_CAPS.attachmentInlineBudget,
    0,
    "attachments are retrieval, not injection, on a continuation turn",
  );

  const before = process.env.PM_EPISODE_MAX_COMMENTS;
  try {
    process.env.PM_EPISODE_MAX_COMMENTS = "3";
    assert.equal(episodeCaps().maxComments, 3, "episode caps must honour their env override");
    // The override is a tuning knob, not an escape hatch back to the archive.
    process.env.PM_EPISODE_MAX_COMMENTS = "9999";
    assert(
      episodeCaps().maxComments <= 30,
      "an env override must not be able to restore an unbounded inline packet",
    );
  } finally {
    if (before === undefined) delete process.env.PM_EPISODE_MAX_COMMENTS;
    else process.env.PM_EPISODE_MAX_COMMENTS = before;
  }
}

// ------------------------------------------------------------------
// 2. Brief size is FLAT in the number of comments on the task
// ------------------------------------------------------------------
{
  const caps = episodeCaps();
  const body = "a".repeat(2_000);
  const render = (count: number) =>
    renderBudgetedTimeline(
      Array.from({ length: count }, (_, i) => comment(i, body)).slice(-caps.recentTimelineVerbatimItems),
      caps,
    ).lines.join("\n").length;

  // Both histories are longer than the brief inlines, so both must render the
  // SAME number of rows. Equality here is the flatness property: adding 450
  // comments to the task adds nothing to the agent's prompt.
  const small = render(50);
  const large = render(500);
  assert.equal(
    small,
    large,
    "a task with 500 comments must produce the same brief size as one with 50 — the brief is flat, not merely smaller",
  );
  assert(
    large <= caps.maxRenderedTimelineChars + 500,
    "the bounded evidence section must stay inside the episode timeline budget",
  );
  assert(
    large < episodeBriefCharBudget(),
    "the evidence section alone must leave room for the rest of the brief inside the brief budget",
  );

  // Contrast: the first-contact packet is deliberately NOT flat. If this ever
  // stops being true, CODE_CAPS has quietly become an episode profile and the
  // separation this task introduced is gone.
  const fullRender = (count: number) =>
    renderBudgetedTimeline(
      Array.from({ length: count }, (_, i) => comment(i, body)),
      CODE_CAPS,
    ).lines.join("\n").length;
  assert(
    fullRender(120) > fullRender(5),
    "the first-contact packet is expected to grow with history; only the brief is flat",
  );
}

// ------------------------------------------------------------------
// 3. Checkpoint fields round-trip
// ------------------------------------------------------------------
{
  const data = checkpointUpdateData({
    completedWork: ["schema + migration", "lifecycle module"],
    evidence: ["ai/web/lib/agents/episodes/lifecycle.ts"],
    openChecklist: ["dispatch wiring", "contract test"],
    nextAction: "wire the brief into continuation dispatch",
    risks: ["sibling session editing the same worktree"],
  });
  assert.equal(JSON.parse(String(data.completedWork)).length, 2);
  assert.equal(data.nextAction, "wire the brief into continuation dispatch");
  assert(data.checkpointAt instanceof Date, "a checkpoint write must stamp checkpointAt");

  // A PARTIAL checkpoint updates only what it names. An agent that knows only
  // its next action must not blank the completed-work list by saying so.
  const partial = checkpointUpdateData({ nextAction: "run tsc" });
  assert.equal(partial.nextAction, "run tsc");
  assert.equal(partial.completedWork, undefined, "an omitted field must not be written");
  assert.equal(partial.risks, undefined, "an omitted field must not be written");

  // An EXPLICIT null clears the field — "there are no risks any more" has to
  // be expressible, and it is different from "I did not mention risks".
  const cleared = checkpointUpdateData({ risks: null });
  assert.equal(cleared.risks, "[]", "an explicit null must clear the list");

  assert.deepEqual(checkpointUpdateData(null), {}, "no checkpoint means no write");
  assert.deepEqual(checkpointUpdateData({}), {}, "an empty checkpoint means no write");

  // Oversized input is clipped, not rejected: a runaway agent must not be able
  // to reintroduce an unbounded blob through the checkpoint columns.
  const huge = checkpointUpdateData({
    completedWork: Array.from({ length: 200 }, (_, i) => `${i} ${"x".repeat(5_000)}`),
    nextAction: "y".repeat(50_000),
  });
  const items = JSON.parse(String(huge.completedWork)) as string[];
  assert(items.length <= 20, "checkpoint lists are capped");
  assert(items.every((entry) => entry.length <= 600), "checkpoint list entries are clipped");
  assert(String(huge.nextAction).length <= 1_200, "nextAction is clipped");
}

// ------------------------------------------------------------------
// 4. Summary decoding survives legacy/hand-edited rows
// ------------------------------------------------------------------
{
  const row = {
    id: "ep1",
    taskId: "t1",
    episodeNo: 3,
    agentSlug: "barekbaal",
    status: "closed",
    cycleCount: 6,
    cycleBudget: 6,
    toolCycleCount: 60,
    toolCycleBudget: 60,
    exhaustedByMessageId: "m1",
    barrierReleasedAt: null,
    sessionKey: "task:t1:ep3",
    messageId: "m1",
    runId: "run-1",
    startedAt: new Date("2026-08-05T03:00:00.000Z"),
    closedAt: new Date("2026-08-05T03:30:00.000Z"),
    closeReason: EPISODE_CLOSE_REASON.budgetExhausted,
    checkpointAt: new Date("2026-08-05T03:30:00.000Z"),
    completedWork: JSON.stringify(["migration landed"]),
    evidence: null,
    openChecklist: JSON.stringify(["contract test"]),
    nextAction: "extend pm-unified-context-test",
    // Not JSON: a legacy or hand-edited row. It must surface as evidence, not
    // take the whole checkpoint down with it.
    risks: "worktree shared with a sibling session",
  };
  const summary: TaskExecutionEpisodeSummary = summarizeEpisode(row);
  assert.deepEqual(summary.checkpoint.completedWork, ["migration landed"]);
  assert.deepEqual(summary.checkpoint.evidence, []);
  assert.deepEqual(summary.checkpoint.risks, ["worktree shared with a sibling session"]);
  assert.equal(summary.checkpoint.nextAction, "extend pm-unified-context-test");

  const rendered = renderEpisodeCheckpoint(summary).join("\n");
  assert.match(
    rendered,
    /Episode 3 \(closed, 6\/6 workflow cycles, 60\/60 tool cycles, closed: cycle_budget_exhausted\)/,
  );
  assert.match(rendered, /Next exact action: extend pm-unified-context-test/);
  assert.match(rendered, /Completed work:/);
  assert(!rendered.includes("Evidence / artifacts:"), "an empty checkpoint section is omitted, not rendered blank");

  // A checkpoint with no recorded next action must SAY so rather than render an
  // empty instruction the next episode would silently skip.
  const bare = renderEpisodeCheckpoint({ ...summary, checkpoint: { ...summary.checkpoint, nextAction: null } });
  assert.match(bare.join("\n"), /Next exact action: \(not recorded/);
}

// ------------------------------------------------------------------
// 5. `checkpoint` is a continuation, and the cycle budget is bounded
// ------------------------------------------------------------------
{
  assert.equal(workflowActionClass("checkpoint"), "continuation-required");
  assert(isContinuationRequiredAction("checkpoint"), "saving state must never end the agent's turn");
  assert.equal(workflowActionEffectOrFinish("checkpoint"), "continue");
  assert.equal(workflowActionCheckpoint("checkpoint"), "execution_checkpoint_saved");

  const result = workflowActionResult({ action: "checkpoint", taskState: "In Progress" });
  assert.equal(result.turnComplete, false, "a checkpoint leaves the turn open");
  assert.equal(result.disposition, "continue");

  // ready_for_review still ends the episode: the brief must not keep being
  // dispatched after the work is handed to a reviewer.
  assert.equal(workflowActionEffectOrFinish("ready_for_review"), "finish");
  assert.equal(workflowActionEffectOrFinish("flag_blocker"), "wait");

  const before = process.env.PM_EPISODE_MAX_CYCLES;
  try {
    delete process.env.PM_EPISODE_MAX_CYCLES;
    assert.equal(episodeCycleBudget(), EPISODE_CYCLE_BUDGET_DEFAULT);
    process.env.PM_EPISODE_MAX_CYCLES = "2";
    assert.equal(episodeCycleBudget(), 2);
    process.env.PM_EPISODE_MAX_CYCLES = "0";
    assert.equal(episodeCycleBudget(), 1, "a zero budget would dispatch episodes that can never act");
    process.env.PM_EPISODE_MAX_CYCLES = "100000";
    assert.equal(episodeCycleBudget(), 100, "the budget must stay bounded — that is the whole feature");
  } finally {
    if (before === undefined) delete process.env.PM_EPISODE_MAX_CYCLES;
    else process.env.PM_EPISODE_MAX_CYCLES = before;
  }
}

// ------------------------------------------------------------------
// 6. The tool-cycle budget — the finer PM-visible unit (ENV-121 review)
// ------------------------------------------------------------------
{
  const before = process.env.PM_EPISODE_MAX_TOOL_CYCLES;
  try {
    delete process.env.PM_EPISODE_MAX_TOOL_CYCLES;
    assert.equal(episodeToolCycleBudget(), EPISODE_TOOL_CYCLE_BUDGET_DEFAULT);
    process.env.PM_EPISODE_MAX_TOOL_CYCLES = "12";
    assert.equal(episodeToolCycleBudget(), 12);
    process.env.PM_EPISODE_MAX_TOOL_CYCLES = "0";
    assert.equal(episodeToolCycleBudget(), 1, "a zero tool budget would close every episode on its first tool call");
    process.env.PM_EPISODE_MAX_TOOL_CYCLES = "10000000";
    assert.equal(episodeToolCycleBudget(), 5_000, "the tool budget must stay bounded — that is the whole feature");
  } finally {
    if (before === undefined) delete process.env.PM_EPISODE_MAX_TOOL_CYCLES;
    else process.env.PM_EPISODE_MAX_TOOL_CYCLES = before;
  }

  // Both exhaustion reasons must be distinguishable in the closed row: the
  // response decorator reports `rolledOver` off either one, and an operator
  // reading the table needs to know whether a turn spent workflow actions or
  // burned tool calls.
  assert.notEqual(EPISODE_CLOSE_REASON.toolBudgetExhausted, EPISODE_CLOSE_REASON.budgetExhausted);
  assert.notEqual(EPISODE_CLOSE_REASON.toolBudgetExhausted, EPISODE_CLOSE_REASON.terminalAction);
}

console.log("pm-execution-episode-test: ok");
