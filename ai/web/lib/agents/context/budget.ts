import type { ContextCaps } from "@/lib/agents/context/caps";

export type TimelineItemForBudget = {
  type: "comment" | "chat" | "activity";
  id: string;
  actor: string;
  body: string;
  createdAt: string;
  kind?: string;
};

export type ClipResult = { text: string; truncated: boolean; omittedChars: number };

export function clipWithMeta(value: string | null | undefined, max = 4000): ClipResult {
  const text = (value ?? "").trim();
  if (text.length <= max) return { text, truncated: false, omittedChars: 0 };
  const omittedChars = text.length - max;
  return {
    text: `${text.slice(0, max).trimEnd()}\n[truncated: ${omittedChars} more chars]`,
    truncated: true,
    omittedChars,
  };
}

export function clip(value: string | null | undefined, max = 4000) {
  return clipWithMeta(value, max).text;
}

function bodyCap(item: TimelineItemForBudget, caps: ContextCaps) {
  return item.type === "activity" ? caps.maxActivityBody : caps.maxTimelineBody;
}

function summaryExcerpt(value: string, max: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max).trimEnd()}…`;
}

function renderTimelineItem(item: TimelineItemForBudget, caps: ContextCaps) {
  const kind = item.kind ? ` ${item.kind}` : "";
  const clipped = clipWithMeta(item.body, bodyCap(item, caps));
  return {
    lines: [
      `[${item.createdAt}] ${item.type}${kind} ${item.actor} (${item.id}):`,
      clipped.text,
      "",
    ],
    truncated: clipped.truncated,
  };
}

function renderTimelineSummary(items: TimelineItemForBudget[]) {
  if (items.length === 0) return [];

  const lines = [
    "OLDER TIMELINE SUMMARY (oldest to newest):",
    `[summarized: ${items.length} older items replaced with attributed timestamped excerpts to keep the context packet within budget]`,
  ];
  const counts = { comment: 0, chat: 0, activity: 0 };
  for (const item of items) counts[item.type] += 1;
  lines.push(`Included in summary: ${counts.comment} comments, ${counts.chat} discussion messages, ${counts.activity} activity rows.`);

  for (const item of items) {
    const kind = item.kind ? ` ${item.kind}` : "";
    const excerpt = summaryExcerpt(item.body, item.type === "activity" ? 240 : 360);
    lines.push(`- [${item.createdAt}] ${item.type}${kind} ${item.actor} (${item.id}): ${excerpt || "(empty)"}`);
  }
  lines.push("");
  return lines;
}

export function renderBudgetedTimeline(
  timeline: TimelineItemForBudget[],
  caps: ContextCaps,
): { lines: string[]; truncatedBodies: number; summarizedItems: number } {
  if (timeline.length === 0) {
    return { lines: ["(none)"], truncatedBodies: 0, summarizedItems: 0 };
  }

  const recentCount = Math.max(0, Math.min(caps.recentTimelineVerbatimItems, timeline.length));
  const recent = recentCount > 0 ? timeline.slice(-recentCount) : [];
  const older = recentCount > 0 ? timeline.slice(0, -recentCount) : timeline;
  const lines: string[] = [];
  let truncatedBodies = 0;

  const renderedRecent = recent.map((item) => renderTimelineItem(item, caps));
  const recentChars = renderedRecent.reduce((sum, rendered) => sum + rendered.lines.join("\n").length, 0);

  if (older.length > 0) {
    const fullOlder = older.map((item) => renderTimelineItem(item, caps));
    const fullOlderChars = fullOlder.reduce((sum, rendered) => sum + rendered.lines.join("\n").length, 0);
    if (fullOlderChars + recentChars > caps.maxRenderedTimelineChars) {
      lines.push(...renderTimelineSummary(older));
    } else {
      for (const rendered of fullOlder) {
        if (rendered.truncated) truncatedBodies += 1;
        lines.push(...rendered.lines);
      }
    }
  }

  if (older.length > 0 && lines.length > 0 && recent.length > 0) {
    lines.push("RECENT TIMELINE VERBATIM (oldest to newest):");
  }
  for (const rendered of renderedRecent) {
    if (rendered.truncated) truncatedBodies += 1;
    lines.push(...rendered.lines);
  }

  const summarizedItems = lines.some((line) => line.startsWith("[summarized:")) ? older.length : 0;
  return { lines, truncatedBodies, summarizedItems };
}
