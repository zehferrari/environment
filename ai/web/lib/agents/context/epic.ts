import { db } from "@/lib/db";
import {
  getAttachmentContext,
  type AttachmentContext,
  type AttachmentForContext,
} from "./attachment-extracts";

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

function clip(value: string | null | undefined, max = 4000) {
  const text = (value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n[truncated]`;
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

export function buildEpicNativeChannelPrompt(epicTitle: string, slug: string): string {
  return [
    `You have a directed PM message on epic "${epicTitle}", addressed to @${slug}.`,
    "This turn arrived through the native OpenClaw PM channel.",
    "Reply normally; OpenClaw will deliver your visible response back to the same PM origin channel.",
    "Use the full live PM context supplied in the message. Do not answer only from the latest line if earlier comments, chats, activity, epic details, or attachments change the meaning.",
    "Markdown formatting in your reply is welcome.",
  ].join("\n");
}

export function buildEpicNativeEditGrantPrompt(epicTitle: string): string {
  return [
    `The PM user allowed description editing for epic "${epicTitle}".`,
    "This turn arrived through the native OpenClaw PM channel.",
    "For now, reply with the proposed complete description in markdown and explain that it is ready for PM review.",
    "Do not call legacy callback URLs. OpenClaw delivers your visible response through the PM channel.",
  ].join("\n");
}

export async function buildEpicAgentContextPacket(args: {
  epicId: string;
  agentSlug: string;
  currentTurn: EpicAgentCurrentTurn;
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
        take: 24,
        select: {
          id: true,
          body: true,
          createdAt: true,
          user: { select: { username: true, kind: true } },
        },
      },
      chats: {
        where: { agentSlug: { in: [args.agentSlug, "room"] } },
        orderBy: { createdAt: "desc" },
        take: 30,
        select: {
          id: true,
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
    take: 30,
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
      ...chats.map((chat) => ({
        type: "chat" as const,
        id: chat.id,
        actor: actorLabel(chat.sender),
        body: chat.body,
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
    "",
  ];

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

  lines.push("", "RELATED TIMELINE (oldest to newest):");
  if (packet.timeline.length === 0) {
    lines.push("(none)");
  } else {
    for (const item of packet.timeline) {
      const kind = item.kind ? ` ${item.kind}` : "";
      lines.push(
        `[${item.createdAt}] ${item.type}${kind} ${item.actor} (${item.id}):`,
        clip(item.body, item.type === "activity" ? 900 : 1800),
        "",
      );
    }
  }

  lines.push(
    "",
    "RESPONSE GUIDANCE:",
    "Use the current turn together with the live PM Epic, timeline, tasks, and attachment context above. If an attachment is important but only metadata is available, say exactly which attachment needs inspection. Do not invent attachment contents.",
  );

  return lines.join("\n");
}

export async function buildEpicAgentUserMessage(args: {
  epicId: string;
  agentSlug: string;
  currentTurn: EpicAgentCurrentTurn;
}) {
  const packet = await buildEpicAgentContextPacket(args);
  return packet.renderedPrompt;
}
