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

function renderTimelineItem(
  item: TimelineItemForBudget,
  caps: ContextCaps,
  maxBodyChars = bodyCap(item, caps),
) {
  const kind = item.kind ? ` ${item.kind}` : "";
  const clipped = clipWithMeta(item.body, Math.min(bodyCap(item, caps), maxBodyChars));
  return {
    lines: [
      `[${item.createdAt}] ${item.type}${kind} ${item.actor} (${item.id}):`,
      clipped.text,
      "",
    ],
    truncated: clipped.truncated,
  };
}

function renderTimelineSummary(items: TimelineItemForBudget[], maxChars: number) {
  if (items.length === 0) return [];

  const header = [
    "OLDER TIMELINE SUMMARY (oldest to newest):",
    `[summarized: ${items.length} older items; newest attributed excerpts are shown within the inline budget and every row remains listed in the timeline manifest]`,
  ];
  const counts = { comment: 0, chat: 0, activity: 0 };
  for (const item of items) counts[item.type] += 1;
  header.push(`Summary covers: ${counts.comment} comments, ${counts.chat} discussion messages, ${counts.activity} activity rows.`);

  const selected: string[] = [];
  let selectedChars = 0;
  const fixedChars = header.join("\n").length + 160;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    const kind = item.kind ? ` ${item.kind}` : "";
    const excerpt = summaryExcerpt(item.body, item.type === "activity" ? 240 : 360);
    const line = `- [${item.createdAt}] ${item.type}${kind} ${item.actor} (${item.id}): ${excerpt || "(empty)"}`;
    if (fixedChars + selectedChars + line.length > maxChars) break;
    selected.unshift(line);
    selectedChars += line.length + 1;
  }
  const omitted = items.length - selected.length;
  const lines = [...header];
  if (omitted > 0) {
    lines.push(`[${omitted} oldest summarized rows omitted here; use the manifest ids or scoped live context when their bodies are needed]`);
  }
  lines.push(...selected);
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
  const timelineBudget = Math.max(500, caps.maxRenderedTimelineChars);
  // Keep even the verbatim recent set bounded if an environment raises the
  // per-body cap without raising the aggregate packet budget.
  const recentBodyBudget = recent.length > 0
    ? Math.max(40, Math.floor((timelineBudget - recent.length * 180) / recent.length))
    : timelineBudget;

  const renderedRecent = recent.map((item) => renderTimelineItem(item, caps, recentBodyBudget));
  const recentChars = renderedRecent.reduce((sum, rendered) => sum + rendered.lines.join("\n").length, 0);

  if (older.length > 0) {
    const fullOlder = older.map((item) => renderTimelineItem(item, caps));
    const fullOlderChars = fullOlder.reduce((sum, rendered) => sum + rendered.lines.join("\n").length, 0);
    if (fullOlderChars + recentChars > timelineBudget) {
      lines.push(...renderTimelineSummary(older, Math.max(240, timelineBudget - recentChars - 80)));
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
