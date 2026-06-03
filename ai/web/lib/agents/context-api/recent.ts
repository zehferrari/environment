// Recent-exchange helpers — the "what just happened" slice we inline into
// every dispatch prompt so the agent can't miss the immediate ask.
//
// The full task / epic history still lives behind the loopback read API
// (lib/agents/context-api/serialize.ts), but the latest N rows are
// cheap enough to send on every turn AND are what the agent needs to
// understand the current conversational turn. This bridges the gap
// where (a) the agent might not curl the API, and (b) even if they do,
// the recent exchange would be buried inside a 2000-row history.

import { db } from "@/lib/db";

const DEFAULT_RECENT_DISCUSSION = 5;
const DEFAULT_RECENT_COMMENTS = 8;

export interface RecentMessage {
  id: string;
  createdAt: Date;
  sender: { username: string; kind: string } | null;
  body: string;
  targetType?: string | null;
  targetLabel?: string | null;
  source: "discussion" | "comment";
}

function pickActor(u: { username: string | null; kind: string | null } | null) {
  if (!u || !u.username) return null;
  return { username: u.username, kind: u.kind ?? "human" };
}

/**
 * Last N non-deleted live discussion messages on a task or epic.
 * Returned oldest → newest so the closing item is the message
 * immediately prior to the current turn.
 */
export async function recentDiscussion(scope: { taskId?: string; epicId?: string }, n = DEFAULT_RECENT_DISCUSSION) {
  if (!scope.taskId && !scope.epicId) return [] as RecentMessage[];
  const desc = await db.agentChatMessage.findMany({
    where: {
      ...(scope.taskId ? { taskId: scope.taskId } : { epicId: scope.epicId }),
      archiveId: null,
      deletedAt: null,
      originChannel: "chat",
    },
    orderBy: { createdAt: "desc" },
    take: n,
    select: {
      id: true, createdAt: true, body: true,
      targetType: true, targetLabel: true,
      sender: { select: { username: true, kind: true } },
    },
  });
  return desc.reverse().map((m): RecentMessage => ({
    id: m.id,
    createdAt: m.createdAt,
    sender: pickActor(m.sender),
    body: m.body,
    targetType: m.targetType,
    targetLabel: m.targetLabel,
    source: "discussion",
  }));
}

/**
 * Last N non-deleted comments on a task or epic, oldest-first.
 */
export async function recentComments(scope: { taskId?: string; epicId?: string }, n = DEFAULT_RECENT_COMMENTS) {
  if (!scope.taskId && !scope.epicId) return [] as RecentMessage[];
  const desc = await db.comment.findMany({
    where: {
      ...(scope.taskId ? { taskId: scope.taskId } : { epicId: scope.epicId }),
      deletedAt: null,
    },
    orderBy: { createdAt: "desc" },
    take: n,
    select: {
      id: true, createdAt: true, body: true,
      user: { select: { username: true, kind: true } },
    },
  });
  return desc.reverse().map((c): RecentMessage => ({
    id: c.id,
    createdAt: c.createdAt,
    sender: pickActor(c.user),
    body: c.body,
    source: "comment",
  }));
}

/** Format a recent-exchange slice for inline rendering in a system prompt. */
export function formatRecentBlock(args: {
  scope: "task" | "epic";
  discussion: RecentMessage[];
  comments?: RecentMessage[];
  currentMessageId?: string;
}) {
  const lines: string[] = [];
  if (args.discussion.length > 0) {
    lines.push(`=== RECENT ${args.scope.toUpperCase()} DISCUSSION (last ${args.discussion.length} messages, oldest first) ===`);
    lines.push("These are the messages that immediately precede the CURRENT MESSAGE you are about to receive. They are the conversational hot path — read them carefully before composing your reply. The final message in this list is what the user is replying to or building on.");
    lines.push("");
    for (const m of args.discussion) {
      if (m.id === args.currentMessageId) continue;
      const who = m.sender ? `@${m.sender.username}${m.sender.kind === "agent" ? " (agent)" : ""}` : "(unknown sender)";
      const target = m.targetLabel ? ` → ${m.targetLabel}` : "";
      lines.push(`[${m.createdAt.toISOString()}] ${who}${target}`);
      lines.push(m.body);
      lines.push("");
    }
  }
  if (args.comments && args.comments.length > 0) {
    lines.push(`=== RECENT ${args.scope.toUpperCase()} COMMENTS (last ${args.comments.length}, oldest first) ===`);
    lines.push("Latest explicit human, reviewer, or manager correction wins over older agent comments. Do not repeat a known blocker unless new information changed it.");
    lines.push("");
    for (const c of args.comments) {
      if (c.id === args.currentMessageId) continue;
      const who = c.sender ? `@${c.sender.username}${c.sender.kind === "agent" ? " (agent)" : ""}` : "(unknown author)";
      lines.push(`[${c.createdAt.toISOString()}] ${who}`);
      lines.push(c.body);
      lines.push("");
    }
  }
  if (lines.length === 0) return "";
  return lines.join("\n").trimEnd();
}
