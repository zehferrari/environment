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

// Row caps for context breadth on a single epic. Matches the task.ts caps so
// that the prompt experience is the same on both surfaces — breadth-first,
// per-body clipping reported inline via clipWithMeta().
const MAX_COMMENTS = 40;
const MAX_LIVE_CHATS = 50;
const MAX_ACTIVITY = 30;
const MAX_ARCHIVED_CHATS = 80;
const MAX_TIMELINE_BODY = 1400;
const MAX_ACTIVITY_BODY = 900;

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

export function buildEpicNativeChannelPrompt(
  epicTitle: string,
  slug: string,
  directedDescriptor?: DirectedDescriptor | null,
): string {
  const lines = [
    `You have a PM message on epic "${epicTitle}", addressed to @${slug}.`,
    "This turn arrived through the native OpenClaw PM channel.",
    "Golden rule: only create a visible PM reply when you have new information, a concrete action result, a required plan, review feedback, a blocker, or a necessary question.",
    `If you have no contribution to add, reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else. PM will mark the turn complete without creating a visible comment.`,
    "Context breadth: the PM context packet below contains EVERY comment and EVERY discussion message on this epic — not only the ones directed at you. Read them as background. The directed-message rule below governs whether you reply.",
    "Use the full live PM context supplied in the message. Do not answer only from the latest line if earlier comments, chats, activity, epic details, or attachments change the meaning.",
    "Markdown formatting in your reply is welcome.",
  ];
  if (directedDescriptor) {
    lines.push("", renderDirectedSilenceRule({ descriptor: directedDescriptor, recipientAgentSlug: slug }));
  }
  return lines.join("\n");
}

export function buildEpicNativeEditGrantPrompt(args: {
  epicTitle: string;
  descriptionUrl: string;
  messageId: string;
  token: string;
}): string {
  const exampleBody = JSON.stringify({
    messageId: args.messageId,
    token: args.token,
    description: "<complete replacement markdown description>",
  });

  return [
    `DESCRIPTION WRITE CAPABILITY for epic "${args.epicTitle}".`,
    "A human-authored message on this epic gives you a one-shot capability to replace the epic description.",
    "Use it only when the current human message directly asks you to update, rewrite, reformat, or replace this epic description. If the message is only a question, discussion, or status check, do not call this endpoint.",
    "",
    "To write the description, POST application/json to:",
    args.descriptionUrl,
    "Body shape:",
    exampleBody,
    "",
    "The description field must contain the complete final markdown description and nothing else. After a successful POST, reply normally through the PM channel with a concise confirmation.",
  ].join("\n");
}

export async function buildEpicAgentContextPacket(args: {
  epicId: string;
  agentSlug: string;
  currentTurn: EpicAgentCurrentTurn;
  directedDescriptor?: DirectedDescriptor | null;
}): Promise<EpicAgentContextPacket> {
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
        orderBy: { createdAt: "desc" },
        take: MAX_COMMENTS,
        select: {
          id: true,
          body: true,
          createdAt: true,
          user: { select: { username: true, kind: true } },
        },
      },
      chats: {
        where: { archiveId: null },
        orderBy: { createdAt: "desc" },
        take: MAX_LIVE_CHATS,
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
        },
        orderBy: { createdAt: "asc" },
        take: MAX_ARCHIVED_CHATS,
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
    take: MAX_ACTIVITY,
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

function renderAttachments(attachments: AttachmentContext[]) {
  const lines: string[] = [];
  let remainingInlineChars = 12000;
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
        const text = clip(attachment.extract.text, Math.min(4000, remainingInlineChars));
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
  pushDescription(lines, "PROJECT DESCRIPTION", project.description, 2500);

  lines.push("", "EPIC SNAPSHOT:");
  lines.push(
    `Epic: ${epic.title} (${epic.status}, ${epic.id})`,
    `Assignee: ${epic.assignee}`,
    `Acting manager: ${epic.actingManager}`,
  );
  pushDescription(lines, "EPIC DESCRIPTION", epic.description, 6000);

  lines.push("", "EPIC TASKS:");
  if (tasks.length === 0) {
    lines.push("(none)");
  } else {
    for (const t of tasks) {
      lines.push(`- ${t.title} [${t.status}] assignee: ${t.assignee} (${t.id})`);
    }
  }

  lines.push("", "ATTACHMENTS:");
  lines.push(...renderAttachments(packet.attachments));

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
    if (counts.comment >= MAX_COMMENTS || counts.chat >= MAX_LIVE_CHATS || counts.activity >= MAX_ACTIVITY) {
      lines.push(
        `[partial context: comments cap ${MAX_COMMENTS} / chats cap ${MAX_LIVE_CHATS} / activity cap ${MAX_ACTIVITY} — older rows may exist beyond this packet]`,
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
      const clipped = clipWithMeta(item.body, item.type === "activity" ? MAX_ACTIVITY_BODY : MAX_TIMELINE_BODY);
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
