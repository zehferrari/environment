import { db } from "@/lib/db";
import {
  getAttachmentContext,
  type AttachmentContext,
  type AttachmentForContext,
} from "./attachment-extracts";
import { PM_SILENT_REPLY_TOKEN } from "@/lib/agents/pm-silence";
import {
  renderDirectedSilenceRule,
  type DirectedDescriptor,
} from "@/lib/agents/directed-targets";
import { resolveAgentCaps, type ContextCaps } from "@/lib/agents/context/caps";

// Context-packet caps live in ./caps.ts and are resolved per-recipient
// from agent.role. Coding agents (can_modify_code=true) get the 1M-token
// profile; monitor agents get the 256k profile.

export type EpicAgentCurrentTurn = {
  id?: string | null;
  agentChatMessageId?: string | null;
  source: "epic comment" | "epic chat";
  actorUsername?: string | null;
  actorKind?: string | null;
  body: string;
  createdAt?: Date | string | null;
};

export type EpicAgentContextPacket = {
  scope: {
    type: "epic";
    id: string;
    projectId: string | null;
    projectSlug: string | null;
  };
  targetAgentSlug: string;
  origin: "comment" | "chat";
  directedDescriptor: DirectedDescriptor | null;
  /** Caps used when building this packet — also drives renderer clip sizes. */
  caps: ContextCaps;
  currentTurn: {
    id: string | null;
    source: "epic_comment" | "epic_chat";
    author: string;
    body: string;
    createdAt: string | null;
  };
  snapshot: {
    project: {
      id: string;
      slug: string;
      name: string;
      description: string | null;
      readmePath: string | null;
    } | null;
    epic: {
      id: string;
      title: string;
      status: string;
      description: string | null;
      assignee: string;
      actingManager: string;
    } | null;
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      assignee: string;
    }>;
  };
  timeline: Array<{
    type: "comment" | "chat" | "activity";
    id: string;
    actor: string;
    body: string;
    createdAt: string;
    kind?: string;
  }>;
  attachments: AttachmentContext[];
  renderedPrompt: string;
};

type UserLabel = { username: string | null; kind?: string | null } | null | undefined;

type ClipResult = { text: string; truncated: boolean; omittedChars: number };

function clipWithMeta(value: string | null | undefined, max = 4000): ClipResult {
  const text = (value ?? "").trim();
  if (text.length <= max) return { text, truncated: false, omittedChars: 0 };
  const omittedChars = text.length - max;
  return {
    text: `${text.slice(0, max).trimEnd()}\n[truncated: ${omittedChars} more chars]`,
    truncated: true,
    omittedChars,
  };
}

function clip(value: string | null | undefined, max = 4000) {
  return clipWithMeta(value, max).text;
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function actorLabel(user: UserLabel) {
  const username = typeof user?.username === "string" && user.username
    ? `@${user.username}`
    : "unknown user";
  return user?.kind === "agent" ? `${username} (agent)` : username;
}

function actorLabelFromParts(username: string | null | undefined, kind?: string | null) {
  return actorLabel({ username: username ?? null, kind });
}

function chatRoutingLabel(chat: {
  agentSlug?: string | null;
  targetLabel?: string | null;
  targetType?: string | null;
  targetValue?: string | null;
}) {
  if (chat.targetLabel?.trim()) return `target=${chat.targetLabel.trim()}`;
  if (chat.targetType?.trim() || chat.targetValue?.trim()) {
    return [chat.targetType, chat.targetValue].filter(Boolean).join(":");
  }
  if (chat.agentSlug && chat.agentSlug !== "room") return `legacy thread=@${chat.agentSlug}`;
  return "room";
}

function chatTimelineBody(
  chat: {
    agentSlug?: string | null;
    targetLabel?: string | null;
    targetType?: string | null;
    targetValue?: string | null;
    body: string;
  },
  archived = false,
) {
  const labels = [
    archived ? "archived discussion context" : "discussion context",
    chatRoutingLabel(chat),
  ].filter(Boolean);
  return `[${labels.join("; ")}]\n${chat.body}`;
}

function payloadText(payload: string | null | undefined) {
  if (!payload) return "";
  try {
    return JSON.stringify(JSON.parse(payload));
  } catch {
    return payload;
  }
}

function currentTurnSource(source: EpicAgentCurrentTurn["source"]) {
  return source === "epic comment" ? "epic_comment" : "epic_chat";
}

function originFromSource(source: EpicAgentCurrentTurn["source"]) {
  return source === "epic comment" ? "comment" : "chat";
}

async function attachmentContexts(
  rows: AttachmentForContext[],
  scope: "task" | "epic",
) {
  return Promise.all(rows.map((row) => getAttachmentContext(row, scope)));
}

async function epicDiscussionArchiveChain(epicId: string, archiveId: string | null) {
  const ids: string[] = [];
  const seen = new Set<string>();
  let currentId = archiveId;
  while (currentId && !seen.has(currentId) && ids.length < 3) {
    seen.add(currentId);
    const archive = await db.agentChatRoomArchive.findFirst({
      where: { id: currentId, epicId, deletedAt: null },
      select: { id: true, parentArchiveId: true },
    });
    if (!archive) break;
    ids.unshift(archive.id);
    currentId = archive.parentArchiveId;
  }
  return ids;
}

export function buildEpicEditGrantPrompt(epicTitle: string): string {
  return [
    `You have been authorised to rewrite the description of the epic "${epicTitle}".`,
    "",
    "RESPONSE RULES (strict):",
    "1. The PM user will not see your final OpenClaw transcript message.",
    "   You must POST to the callback endpoints included in the wake text.",
    "2. POST the complete final description to the description endpoint.",
    "   The JSON description value must contain the FINAL description text",
    "   and nothing else - no preamble, no acknowledgement, no \"Sure,",
    "   here is...\", no trailing notes.",
    "3. Do NOT wrap the whole description in a code fence (\\`\\`\\`) or a",
    "   JSON object inside the description string.",
    "4. After a successful description POST, POST a concise visible",
    "   acknowledgement to the origin-channel chat callback so the PM",
    "   epic page shows that the work was completed.",
    "5. Markdown content INSIDE the description is encouraged when it",
    "   helps - headings, bullet lists, fenced code blocks for example",
    "   snippets, tables, links. README.md / runbook style is common.",
    "6. Your full description POST will be persisted verbatim as the new",
    "   description, replacing the current one in full.",
    "7. The grant is single-use. Do not call the description endpoint twice.",
    "",
    "The user's request and the live PM context packet are below in",
    "userMessage. Treat PM epic/comments/activity/attachments as",
    "the source of truth for this turn.",
  ].join("\n");
}

export function buildEpicPlainChatPrompt(epicTitle: string, slug: string): string {
  return [
    `You have a directed PM message on epic "${epicTitle}", addressed to @${slug}.`,
    "The PM user will not see your final OpenClaw transcript message.",
    "You must POST your visible answer to the origin-channel callback",
    "included in the wake text.",
    "Respond conversationally; you do NOT have permission to write the",
    "description on this message unless an explicit description endpoint",
    "is included. Markdown formatting in your reply is welcome.",
    "Use the full live PM context supplied in userMessage. Do not answer",
    "only from the latest line if earlier comments, chats, activity, epic",
    "details, or attachments change the meaning.",
  ].join("\n");
}

export interface LiveContextAccessEpic {
  baseUrl: string;
  grantUrls?: {
    epic: string;
    project: string;
  };
  epicId: string;
  projectId: string;
  /** Inlined "recent exchange" block — same idea as the task variant. */
  inlineRecentBlock?: string;
}

const SCOPE_ANCHORING_RULE = [
  "SCOPE-ANCHORING RULE (read before composing):",
  "If you OR another participant proposed a specific scope in the RECENT block above (e.g. 'I can split this into 2 tasks'), and the user replied affirmatively (e.g. 'yes', 'please do', 'I really enjoy your suggestions'), MATCH THAT SCOPE EXACTLY. Do not silently widen it or invent a new epic. If you genuinely need a different scope, surface a question first instead of acting.",
].join("\n");

function liveContextFetchBlockEpic(args: LiveContextAccessEpic) {
  const out: string[] = [];
  const missingGrant = "  # No scoped grant URL was issued for this scope in this turn.";
  if (args.inlineRecentBlock && args.inlineRecentBlock.trim()) {
    out.push(args.inlineRecentBlock.trim());
    out.push("");
    out.push(SCOPE_ANCHORING_RULE);
    out.push("");
  }
  out.push(
    "LIVE PM CONTEXT — FETCH WHEN YOU NEED DEEPER HISTORY:",
    "The RECENT block above is your PRIMARY context. PM also exposes loopback-only JSON endpoints for older history and full project state. PM is reachable ONLY at 127.0.0.1; do NOT call agents.vixi.au or any public URL.",
    "",
    "  # Full epic: deeper history, full task list, comments, attachments:",
    args.grantUrls?.epic
      ? `  curl -s '${args.grantUrls.epic}'`
      : missingGrant,
    "",
    "  # Required before proposing work-item changes:",
    args.grantUrls?.project
      ? `  curl -s '${args.grantUrls.project}'`
      : missingGrant,
    "",
    "  # Per-task detail when you need to dive into a specific task under this epic:",
    "  # No arbitrary-task grant is issued. Use the epic/project overview or ask for a task-scoped turn if deep task detail is required.",
    "",
    "Soft-deleted comments / chats are filtered server-side. Full contract: ai/web/docs/agent-pm-api.md.",
  );
  return out.join("\n");
}

export function buildEpicNativeChannelPrompt(
  epicTitle: string,
  slug: string,
  directedDescriptor?: DirectedDescriptor | null,
  contextAccess?: LiveContextAccessEpic | null,
): string {
  const lines = [
    `You have a PM message on epic "${epicTitle}", addressed to @${slug}.`,
    "This turn arrived through the native OpenClaw PM channel.",
    "Golden rule: only create a visible PM reply when you have new information, a concrete action result, a required plan, review feedback, a blocker, or a necessary question.",
    `If you have no contribution to add, reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else. PM will mark the turn complete without creating a visible comment.`,
    "Markdown formatting in your reply is welcome.",
  ];
  if (contextAccess) {
    lines.push("", liveContextFetchBlockEpic(contextAccess));
  }
  if (directedDescriptor) {
    lines.push("", renderDirectedSilenceRule({ descriptor: directedDescriptor, recipientAgentSlug: slug }));
  }
  return lines.join("\n");
}

// HOMELAB-41 / item 4: the description endpoint creates a DRAFT for the
// requesting human, not a direct DB write. See task.ts equivalent for the
// full rationale.
export function buildEpicNativeEditGrantPrompt(args: {
  epicTitle: string;
  descriptionUrl: string;
  messageId: string;
  token: string;
}): string {
  const exampleBody = JSON.stringify({
    messageId: args.messageId,
    token: args.token,
    description: "<complete final markdown description>",
  });

  return [
    `DESCRIPTION DRAFT CAPABILITY for epic "${args.epicTitle}".`,
    "A human-authored message on this epic gives you a one-shot capability to PROPOSE A DRAFT of the epic description. Your POST does NOT replace the description directly — it lands as a draft on the open epic page for the requesting human to review, Save (apply), or Rollback. If the requester closed the page before your POST landed, the draft is reaped within ~60s and no other viewer ever sees it.",
    "Use it only when the current human message directly asks you to update, rewrite, reformat, or replace this epic description. If the message is only a question, discussion, or status check, do not call this endpoint.",
    "",
    "To publish a draft, POST application/json to:",
    args.descriptionUrl,
    "Body shape:",
    exampleBody,
    "",
    "The `description` field must contain the COMPLETE final markdown description and nothing else — no preamble, no acknowledgement, no JSON wrapper. After a successful POST, reply through the PM channel with a concise confirmation noting that the requester needs to click Save to apply the draft.",
  ].join("\n");
}

export async function buildEpicAgentContextPacket(args: {
  epicId: string;
  agentSlug: string;
  currentTurn: EpicAgentCurrentTurn;
  directedDescriptor?: DirectedDescriptor | null;
}): Promise<EpicAgentContextPacket> {
  // Role-driven caps; see lib/agents/context/caps.ts.
  const caps = await resolveAgentCaps(args.agentSlug);
  const epic = await db.epic.findUnique({
    where: { id: args.epicId },
    select: {
      id: true,
      title: true,
      status: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      project: {
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          readmePath: true,
        },
      },
      assignee: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
      tasks: {
        where: { deletedAt: null },
        orderBy: [{ status: "asc" }, { rank: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          status: true,
          assignee: { select: { username: true, kind: true } },
        },
      },
      attachments: {
        orderBy: { createdAt: "asc" },
        take: 30,
        select: {
          id: true,
          filename: true,
          storagePath: true,
          mimeType: true,
          sizeBytes: true,
          sha256: true,
          createdAt: true,
          uploader: { select: { username: true, kind: true } },
        },
      },
      comments: {
        // Agent context NEVER includes soft-deleted comments — a human
        // removed them on purpose. HOMELAB-41 / item 2.
        where: { deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: caps.maxComments,
        select: {
          id: true,
          body: true,
          createdAt: true,
          user: { select: { username: true, kind: true } },
        },
      },
      chats: {
        where: { archiveId: null, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: caps.maxLiveChats,
        select: {
          id: true,
          agentSlug: true,
          targetType: true,
          targetValue: true,
          targetLabel: true,
          body: true,
          createdAt: true,
          sender: { select: { username: true, kind: true } },
        },
      },
    },
  });

  const basePacket: EpicAgentContextPacket = {
    scope: {
      type: "epic",
      id: args.epicId,
      projectId: epic?.project.id ?? null,
      projectSlug: epic?.project.slug ?? null,
    },
    targetAgentSlug: args.agentSlug,
    origin: originFromSource(args.currentTurn.source),
    directedDescriptor: args.directedDescriptor ?? null,
    caps,
    currentTurn: {
      id: args.currentTurn.id ?? null,
      source: currentTurnSource(args.currentTurn.source),
      author: actorLabelFromParts(args.currentTurn.actorUsername, args.currentTurn.actorKind),
      body: args.currentTurn.body,
      createdAt: formatDate(args.currentTurn.createdAt),
    },
    snapshot: {
      project: epic?.project ?? null,
      epic: epic
        ? {
            id: epic.id,
            title: epic.title,
            status: epic.status,
            description: epic.description,
            assignee: actorLabel(epic.assignee),
            actingManager: actorLabel(epic.actingManager),
          }
        : null,
      tasks: epic?.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        assignee: actorLabel(t.assignee),
      })) ?? [],
    },
    timeline: [],
    attachments: [],
    renderedPrompt: "",
  };

  if (!epic) {
    return {
      ...basePacket,
      renderedPrompt: renderEpicAgentContextPacket(basePacket),
    };
  }

  const currentId = args.currentTurn.id ?? null;
  const currentChatId = args.currentTurn.agentChatMessageId ?? currentId;
  const currentChat = currentChatId
    ? await db.agentChatMessage.findUnique({
        where: { id: currentChatId },
        select: { baseArchiveId: true },
      })
    : null;
  const archiveIds = await epicDiscussionArchiveChain(
    args.epicId,
    currentChat?.baseArchiveId ?? null,
  );
  const archivedChats = archiveIds.length > 0
    ? await db.agentChatMessage.findMany({
        where: {
          epicId: args.epicId,
          archiveId: { in: archiveIds },
          // Soft-deleted archived bubbles stay hidden from agent
          // context too. HOMELAB-41 / item 2.
          deletedAt: null,
        },
        orderBy: { createdAt: "asc" },
        take: caps.maxArchivedChats,
        select: {
          id: true,
          agentSlug: true,
          targetType: true,
          targetValue: true,
          targetLabel: true,
          body: true,
          createdAt: true,
          sender: { select: { username: true, kind: true } },
        },
      })
    : [];
  const comments = [...epic.comments]
    .reverse()
    .filter((comment) => comment.id !== currentId);
  const chats = [...epic.chats]
    .reverse()
    .filter((chat) => chat.id !== currentChatId && chat.id !== currentId);
  
  // Load epic attachments context
  const epicAttachments = await attachmentContexts(epic.attachments, "epic");

  // Load activity logs relating to the project
  const activity = await db.activityLog.findMany({
    where: { projectId: epic.project.id },
    orderBy: { createdAt: "desc" },
    take: caps.maxActivity,
    select: {
      id: true,
      kind: true,
      payload: true,
      targetAgent: true,
      targetFile: true,
      createdAt: true,
      user: { select: { username: true, kind: true } },
    },
  });

  const timelineActivity = [...activity].reverse();

  const packet: EpicAgentContextPacket = {
    ...basePacket,
    timeline: [
      ...comments.map((comment) => ({
        type: "comment" as const,
        id: comment.id,
        actor: actorLabel(comment.user),
        body: comment.body,
        createdAt: formatDate(comment.createdAt)!,
      })),
      ...archivedChats.map((chat) => ({
        type: "chat" as const,
        id: chat.id,
        actor: actorLabel(chat.sender),
        body: chatTimelineBody(chat, true),
        createdAt: formatDate(chat.createdAt)!,
      })),
      ...chats.map((chat) => ({
        type: "chat" as const,
        id: chat.id,
        actor: actorLabel(chat.sender),
        body: chatTimelineBody(chat),
        createdAt: formatDate(chat.createdAt)!,
      })),
      ...timelineActivity.map((row) => ({
        type: "activity" as const,
        id: row.id,
        actor: actorLabel(row.user),
        body: [
          row.targetAgent ? `targetAgent=${row.targetAgent}` : "",
          row.targetFile ? `targetFile=${row.targetFile}` : "",
          payloadText(row.payload),
        ].filter(Boolean).join(" "),
        createdAt: formatDate(row.createdAt)!,
        kind: row.kind,
      })),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    attachments: epicAttachments,
  };

  return {
    ...packet,
    renderedPrompt: renderEpicAgentContextPacket(packet),
  };
}

function pushDescription(lines: string[], label: string, value: string | null, max = 6000) {
  lines.push(label);
  if (value?.trim()) {
    lines.push(`<<<${label.replaceAll(" ", "_")}\n${clip(value, max)}\n${label.replaceAll(" ", "_")}>>>`);
  } else {
    lines.push("(empty)");
  }
}

function renderAttachments(attachments: AttachmentContext[], caps: ContextCaps) {
  const lines: string[] = [];
  let remainingInlineChars = caps.attachmentInlineBudget;
  if (attachments.length === 0) {
    lines.push("(none)");
    return lines;
  }

  for (const attachment of attachments) {
    lines.push(
      `- [${attachment.scope}] ${attachment.filename} (${attachment.mimeType}, ${formatBytes(attachment.sizeBytes)}) uploaded by ${actorLabel(attachment.uploader)} at ${formatDate(attachment.createdAt)}; PM download path: ${attachment.downloadPath}`,
    );
    if (attachment.extract.status === "ready" && attachment.extract.text) {
      if (remainingInlineChars > 0) {
        const text = clip(attachment.extract.text, Math.min(caps.attachmentPerExcerpt, remainingInlineChars));
        remainingInlineChars -= text.length;
        lines.push("  Extracted text excerpt:", "  -----", ...text.split("\n").map((line) => `  ${line}`), "  -----");
      } else {
        lines.push("  Extracted text omitted: attachment inline context budget reached.");
      }
    } else if (attachment.extract.error) {
      lines.push(`  Extracted text unavailable: ${attachment.extract.error}.`);
    }
  }

  return lines;
}

export function renderEpicAgentContextPacket(packet: EpicAgentContextPacket): string {
  const lines = [
    "CURRENT TURN:",
    `${packet.currentTurn.source} from ${packet.currentTurn.author}${packet.currentTurn.createdAt ? ` at ${packet.currentTurn.createdAt}` : ""}`,
    packet.currentTurn.id ? `Turn id: ${packet.currentTurn.id}` : "Turn id: (not set)",
    "-----",
    clip(packet.currentTurn.body, 8000),
    "-----",
    "",
    "LIVE PM CONTEXT PACKET:",
    `Scope: ${packet.scope.type} ${packet.scope.id}`,
    `Target agent: @${packet.targetAgentSlug}`,
    `Origin channel: ${packet.origin}`,
  ];
  if (packet.directedDescriptor) {
    if (packet.directedDescriptor.isBroadcast) {
      lines.push(`Directed-to: broadcast (${packet.directedDescriptor.label})`);
    } else {
      lines.push(
        `Directed-to: ${packet.directedDescriptor.label} [${packet.directedDescriptor.directedAgentSlugs.map((s) => `@${s}`).join(", ")}]`,
      );
    }
  }
  lines.push("");

  if (!packet.snapshot.epic || !packet.snapshot.project) {
    lines.push(
      "EPIC SNAPSHOT:",
      `Epic ${packet.scope.id} could not be loaded. Use the current turn only.`,
      "",
      "RESPONSE GUIDANCE:",
      "Answer only from the current turn because PM could not load the work item context.",
    );
    return lines.join("\n");
  }

  const { project, epic, tasks } = packet.snapshot;
  lines.push(
    "PROJECT SNAPSHOT:",
    `Project: ${project.name} (${project.slug})`,
    `Project id: ${project.id}`,
    `Project README path: ${project.readmePath || "(not set)"}`,
  );
  pushDescription(lines, "PROJECT DESCRIPTION", project.description, packet.caps.projectDescriptionMax);

  lines.push("", "EPIC SNAPSHOT:");
  lines.push(
    `Epic: ${epic.title} (${epic.status}, ${epic.id})`,
    `Assignee: ${epic.assignee}`,
    `Acting manager: ${epic.actingManager}`,
  );
  pushDescription(lines, "EPIC DESCRIPTION", epic.description, packet.caps.epicDescriptionMax);

  lines.push("", "EPIC TASKS:");
  if (tasks.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of tasks) {
      lines.push(`- ${t.title} [${t.status}] assignee: ${t.assignee} (${t.id})`);
    }
  }

  lines.push("", "ATTACHMENTS:");
  lines.push(...renderAttachments(packet.attachments, packet.caps));

  lines.push("", "TIMELINE MANIFEST (breadth first; every fetched row):");
  if (packet.timeline.length === 0) {
    lines.push("(none)");
  } else {
    const counts = { comment: 0, chat: 0, activity: 0 };
    for (const item of packet.timeline) counts[item.type] += 1;
    lines.push(
      `Fetched: ${counts.comment} comments, ${counts.chat} discussion messages (including any archived chain), ${counts.activity} activity rows.`,
    );
    for (const item of packet.timeline) {
      const kind = item.kind ? ` ${item.kind}` : "";
      lines.push(
        `- [${item.createdAt}] ${item.type}${kind} ${item.actor} (${item.id})`,
      );
    }
    if (counts.comment >= packet.caps.maxComments || counts.chat >= packet.caps.maxLiveChats || counts.activity >= packet.caps.maxActivity) {
      lines.push(
        `[partial context: comments cap ${packet.caps.maxComments} / chats cap ${packet.caps.maxLiveChats} / activity cap ${packet.caps.maxActivity} — older rows may exist beyond this packet]`,
      );
    }
  }

  let truncatedBodies = 0;
  lines.push("", "RELATED TIMELINE (oldest to newest):");
  if (packet.timeline.length === 0) {
    lines.push("(none)");
  } else {
    for (const item of packet.timeline) {
      const kind = item.kind ? ` ${item.kind}` : "";
      const clipped = clipWithMeta(item.body, item.type === "activity" ? packet.caps.maxActivityBody : packet.caps.maxTimelineBody);
      if (clipped.truncated) truncatedBodies += 1;
      lines.push(
        `[${item.createdAt}] ${item.type}${kind} ${item.actor} (${item.id}):`,
        clipped.text,
        "",
      );
    }
  }
  if (truncatedBodies > 0) {
    lines.push(
      `[partial context: ${truncatedBodies} timeline bodies were clipped above; each clip annotates how many characters were omitted]`,
    );
  }

  lines.push(
    "",
    "RESPONSE GUIDANCE:",
    "Use the current turn together with the live PM Epic, timeline, tasks, and attachment context above. If an attachment is important but only metadata is available, say exactly which attachment needs inspection. Do not invent attachment contents.",
    "You can see EVERY comment and EVERY discussion message above, including messages between other people/agents that were not directed at you. Read them as background and use them in your reasoning.",
    `If the current turn requires no visible contribution from you, reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else.`,
  );

  return lines.join("\n");
}

export async function buildEpicAgentUserMessage(args: {
  epicId: string;
  agentSlug: string;
  currentTurn: EpicAgentCurrentTurn;
  directedDescriptor?: DirectedDescriptor | null;
}) {
  const packet = await buildEpicAgentContextPacket(args);
  return packet.renderedPrompt;
}
