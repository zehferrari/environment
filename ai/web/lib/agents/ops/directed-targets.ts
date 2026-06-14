// Directed-message resolver.
//
// A PM message (task comment, task chat, or epic chat) is either a broadcast
// (everyone with a role on the item, or "All Coders") or directed at a
// specific agent or set of agents. The native PM-channel turn carries this
// descriptor into the agent's system prompt; the prompt then instructs every
// recipient that is NOT in the directed set to reply with the silent token
// instead of posting a visible comment.
//
// Workflow turns (start / ready_for_review / review_* / triage_to_todo) are
// inherently role-directed and do NOT carry a descriptor — they always
// expect a visible reply from the addressed assignee/reviewer.
//
// Discussion rows store targeting in (targetType, targetValue, targetLabel),
// where targetValue uses the `agent:<slug>` / `user:<id>` shape produced by
// targetValueForPrincipal() in lib/agents/chat-actions.ts. Comments derive
// targeting from @-mentions in the body via extractMentions() in
// lib/markdown.tsx.
//
// Used by: lib/agents/context/task.ts (buildTaskNativeChannelPrompt),
// lib/agents/context/epic.ts (buildEpicNativeChannelPrompt), the dispatch
// sites in lib/agents/chat-actions.ts (discussion) and
// lib/agents/workflow/notifications/task.ts (sendTaskCommentNotifications).

import { PM_SILENT_REPLY_TOKEN } from "@/lib/agents/ops/pm-silence";

export type DirectedDescriptor = {
  directedAgentSlugs: string[];
  isBroadcast: boolean;
  label: string;
};

export function broadcastDescriptor(label = "everyone with a role on this item"): DirectedDescriptor {
  return { directedAgentSlugs: [], isBroadcast: true, label };
}

export function resolveDirectedFromDiscussionRow(args: {
  targetType: string | null;
  targetValue: string | null;
  targetLabel: string | null;
  activeAgentSlugs: ReadonlySet<string>;
}): DirectedDescriptor {
  const { targetType, targetValue, targetLabel, activeAgentSlugs } = args;
  const labelClean = targetLabel?.trim() ?? "";

  if (!targetType || targetType === "all-coders") {
    return broadcastDescriptor(labelClean || "All Coders");
  }

  if (targetType === "agent") {
    const raw = (targetValue ?? "").trim();
    const slug = raw.startsWith("agent:") ? raw.slice("agent:".length) : raw;
    if (slug && activeAgentSlugs.has(slug)) {
      return {
        directedAgentSlugs: [slug],
        isBroadcast: false,
        label: labelClean || `@${slug}`,
      };
    }
    return broadcastDescriptor(labelClean || slug || "unknown agent target");
  }

  if (targetType === "user") {
    // Directed at a human reviewer — from any agent's perspective, no agent
    // is in the directed set. Treat as a broadcast so the dispatched agent
    // (assignee / reviewer / mentioned) still replies normally.
    return broadcastDescriptor(labelClean || "a human reviewer");
  }

  if (targetType === "multi") {
    try {
      const parsed = JSON.parse(targetValue ?? "[]") as unknown;
      if (Array.isArray(parsed)) {
        const slugs: string[] = [];
        for (const v of parsed) {
          if (typeof v !== "string") continue;
          if (!v.startsWith("agent:")) continue;
          const slug = v.slice("agent:".length);
          if (activeAgentSlugs.has(slug) && !slugs.includes(slug)) slugs.push(slug);
        }
        if (slugs.length > 0) {
          return {
            directedAgentSlugs: slugs,
            isBroadcast: false,
            label: labelClean || slugs.map((s) => `@${s}`).join(", "),
          };
        }
      }
    } catch {
      // fall through to broadcast
    }
    return broadcastDescriptor(labelClean || "multiple recipients");
  }

  return broadcastDescriptor(labelClean || targetType);
}

export function resolveDirectedFromComment(args: {
  body: string;
  mentionableAgents: ReadonlyArray<{ username: string; agentSlug: string }>;
}): DirectedDescriptor {
  if (!args.body.trim()) {
    return broadcastDescriptor("everyone with a role on this task");
  }
  const usernameToSlug = new Map(args.mentionableAgents.map((m) => [m.username, m.agentSlug]));
  const seen = new Set<string>();
  const slugs: string[] = [];
  const re = /(^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,64})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args.body)) !== null) {
    const username = m[2]!;
    const slug = usernameToSlug.get(username);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  }
  if (slugs.length === 0) {
    return broadcastDescriptor("everyone with a role on this task");
  }
  return {
    directedAgentSlugs: slugs,
    isBroadcast: false,
    label: slugs.map((s) => `@${s}`).join(", "),
  };
}

export function renderDirectedSilenceRule(args: {
  descriptor: DirectedDescriptor;
  recipientAgentSlug: string;
}): string {
  if (args.descriptor.isBroadcast) {
    return [
      "DIRECTED-MESSAGE RULE:",
      `This message is a broadcast (${args.descriptor.label}). Reply per the usual visible-contribution rules.`,
    ].join("\n");
  }

  const inSet = args.descriptor.directedAgentSlugs.includes(args.recipientAgentSlug);
  if (inSet) {
    return [
      "DIRECTED-MESSAGE RULE:",
      `This message is directed to: ${args.descriptor.label}. You are @${args.recipientAgentSlug} and you ARE in the directed set — reply per the usual visible-contribution rules.`,
    ].join("\n");
  }

  return [
    "DIRECTED-MESSAGE RULE:",
    `This message is directed to: ${args.descriptor.label}. You are @${args.recipientAgentSlug} and you are NOT in the directed set.`,
    "Read the content for your own awareness. Do NOT post a visible reply even if you are the assignee, reviewer, epic manager, or reporter for this item.",
    `Reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else; PM will mark the turn complete without creating a visible comment.`,
  ].join("\n");
}
