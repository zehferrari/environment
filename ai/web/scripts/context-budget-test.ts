import { strict as assert } from "node:assert";
import { CODE_CAPS, MONITOR_CAPS, directChatContextMessages } from "../lib/agents/context/caps";
import { renderBudgetedTimeline, type TimelineItemForBudget } from "../lib/agents/context/budget";

function item(n: number, body = `body ${n}`): TimelineItemForBudget {
  return {
    type: n % 3 === 0 ? "activity" : n % 2 === 0 ? "chat" : "comment",
    id: `item-${n}`,
    actor: n % 2 === 0 ? "@agent (agent)" : "@human",
    body,
    createdAt: `2026-06-16T00:${String(n).padStart(2, "0")}:00.000Z`,
    kind: n % 3 === 0 ? "task.update" : undefined,
  };
}

{
  const caps = { ...MONITOR_CAPS, maxRenderedTimelineChars: 900, recentTimelineVerbatimItems: 3 };
  const timeline = Array.from({ length: 8 }, (_, i) => item(i, `message ${i} ${"x".repeat(260)}`));
  const rendered = renderBudgetedTimeline(timeline, caps);
  const text = rendered.lines.join("\n");
  assert.equal(rendered.summarizedItems, 5);
  assert.match(text, /OLDER TIMELINE SUMMARY/);
  assert.match(text, /oldest summarized rows omitted here/);
  assert.match(text, /RECENT TIMELINE VERBATIM/);
  assert.match(text, /\[2026-06-16T00:07:00.000Z\] comment @human \(item-7\):/);
  assert(text.length <= caps.maxRenderedTimelineChars + 250, "timeline rendering must remain close to its aggregate hard budget");
}

{
  const caps = { ...CODE_CAPS, maxRenderedTimelineChars: 100_000, recentTimelineVerbatimItems: 24, maxTimelineBody: 40 };
  const rendered = renderBudgetedTimeline([item(1, "a".repeat(80))], caps);
  assert.equal(rendered.summarizedItems, 0);
  assert.equal(rendered.truncatedBodies, 1);
  assert.match(rendered.lines.join("\n"), /\[truncated: 40 more chars\]/);
}

assert(CODE_CAPS.maxRenderedTimelineChars <= 150_000, "coding packets must preserve tool-loop context headroom");
assert(MONITOR_CAPS.maxRenderedTimelineChars <= 100_000, "monitor packets must remain smaller than coding packets");

{
  const original = process.env.PM_DIRECT_CHAT_CONTEXT_MESSAGES;
  process.env.PM_DIRECT_CHAT_CONTEXT_MESSAGES = "999";
  assert.equal(directChatContextMessages(), 40);
  process.env.PM_DIRECT_CHAT_CONTEXT_MESSAGES = "2";
  assert.equal(directChatContextMessages(), 6);
  if (original === undefined) delete process.env.PM_DIRECT_CHAT_CONTEXT_MESSAGES;
  else process.env.PM_DIRECT_CHAT_CONTEXT_MESSAGES = original;
}

console.log("context budget tests passed");
