import { db } from "@/lib/db";
import {
  getAttachmentContext,
  type AttachmentContext,
  type AttachmentForContext,
} from "./attachment-extracts";

export type TaskAgentCurrentTurn = {
  id?: string | null;
  agentChatMessageId?: string | null;
  source: "task comment" | "task chat";
  actorUsername?: string | null;
  actorKind?: string | null;
  body: string;
  createdAt?: Date | string | null;
};

export type AgentContextPacket = {
  scope: {
    type: "task";
    id: string;
    projectId: string | null;
    projectSlug: string | null;
  };
  targetAgentSlug: string;
  origin: "comment" | "chat";
  currentTurn: {
    id: string | null;
    source: "task_comment" | "task_chat";
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
    task: {
      id: string;
      title: string;
      status: string;
      description: string | null;
      branchName: string | null;
      createdAt: string;
      updatedAt: string;
      assignee: string;
      reviewer: string;
    } | null;
    epic: {
      id: string;
      title: string;
      status: string;
      description: string | null;
      assignee: string;
      actingManager: string;
    } | null;
    parentTask: {
      id: string;
      title: string;
      status: string;
    } | null;
    subtasks: Array<{
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

function currentTurnSource(source: TaskAgentCurrentTurn["source"]) {
  return source === "task comment" ? "task_comment" : "task_chat";
}

function originFromSource(source: TaskAgentCurrentTurn["source"]) {
  return source === "task comment" ? "comment" : "chat";
}

async function attachmentContexts(
  rows: AttachmentForContext[],
  scope: "task" | "epic",
) {
  return Promise.all(rows.map((row) => getAttachmentContext(row, scope)));
}

async function taskDiscussionArchiveChain(taskId: string, archiveId: string | null) {
  const ids: string[] = [];
  const seen = new Set<string>();
  let currentId = archiveId;
  while (currentId && !seen.has(currentId) && ids.length < 3) {
    seen.add(currentId);
    const archive = await db.agentChatRoomArchive.findFirst({
      where: { id: currentId, taskId, deletedAt: null },
      select: { id: true, parentArchiveId: true },
    });
    if (!archive) break;
    ids.unshift(archive.id);
    currentId = archive.parentArchiveId;
  }
  return ids;
}

export function buildTaskEditGrantPrompt(taskTitle: string): string {
  return [
    `You have been authorised to rewrite the description of the task "${taskTitle}".`,
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
    "   task page shows that the work was completed.",
    "5. Markdown content INSIDE the description is encouraged when it",
    "   helps - headings, bullet lists, fenced code blocks for example",
    "   snippets, tables, links. README.md / runbook style is common.",
    "6. Your full description POST will be persisted verbatim as the new",
    "   description, replacing the current one in full.",
    "7. The grant is single-use. Do not call the description endpoint twice.",
    "",
    "The user's request and the live PM context packet are below in",
    "userMessage. Treat PM task/Epic/comments/activity/attachments as",
    "the source of truth for this turn.",
  ].join("\n");
}

export function buildTaskPlainChatPrompt(taskTitle: string, slug: string): string {
  return [
    `You have a directed PM message on task "${taskTitle}", addressed to @${slug}.`,
    "The PM user will not see your final OpenClaw transcript message.",
    "You must POST your visible answer to the origin-channel callback",
    "included in the wake text.",
    "Respond conversationally; you do NOT have permission to write the",
    "description on this message unless an explicit description endpoint",
    "is included. Markdown formatting in your reply is welcome.",
    "Use the full live PM context supplied in userMessage. Do not answer",
    "only from the latest line if earlier comments, chats, activity, task",
    "details, Epic details, or attachments change the meaning.",
  ].join("\n");
}

export function buildTaskNativeChannelPrompt(taskTitle: string, slug: string): string {
  return [
    `You have a directed PM message on task "${taskTitle}", addressed to @${slug}.`,
    "This turn arrived through the native OpenClaw PM channel.",
    "Reply normally; OpenClaw will deliver your visible response back to the same PM origin channel.",
    "Use the full live PM context supplied in the message. Do not answer only from the latest line if earlier comments, chats, activity, task details, Epic details, or attachments change the meaning.",
    "Markdown formatting in your reply is welcome.",
  ].join("\n");
}

export function buildTaskNativeEditGrantPrompt(args: {
  taskTitle: string;
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
    `DESCRIPTION WRITE CAPABILITY for task "${args.taskTitle}".`,
    "A human-authored message on this task gives you a one-shot capability to replace the task description.",
    "Use it only when the current human message directly asks you to update, rewrite, reformat, or replace this task description. If the message is only a question, discussion, or status check, do not call this endpoint.",
    "",
    "To write the description, POST application/json to:",
    args.descriptionUrl,
    "Body shape:",
    exampleBody,
    "",
    "The description field must contain the complete final markdown description and nothing else. After a successful POST, reply normally through the PM channel with a concise confirmation.",
  ].join("\n");
}

export async function buildTaskAgentContextPacket(args: {
  taskId: string;
  agentSlug: string;
  currentTurn: TaskAgentCurrentTurn;
}): Promise<AgentContextPacket> {
  const task = await db.task.findUnique({
    where: { id: args.taskId },
    select: {
      id: true,
      title: true,
      status: true,
      description: true,
      branchName: true,
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
      epic: {
        select: {
          id: true,
          title: true,
          status: true,
          description: true,
          assignee: { select: { username: true, kind: true } },
          actingManager: { select: { username: true, kind: true } },
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
        },
      },
      parent: { select: { id: true, title: true, status: true } },
      assignee: { select: { username: true, kind: true } },
      actingManager: { select: { username: true, kind: true } },
      subtasks: {
        where: { deletedAt: null },
        orderBy: [{ status: "asc" }, { rank: "asc" }, { createdAt: "asc" }],
        take: 25,
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
        where: { archiveId: null },
        orderBy: { createdAt: "desc" },
        take: 30,
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
      activity: {
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
      },
    },
  });

  const basePacket: AgentContextPacket = {
    scope: {
      type: "task",
      id: args.taskId,
      projectId: task?.project.id ?? null,
      projectSlug: task?.project.slug ?? null,
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
      project: task?.project ?? null,
      task: task
        ? {
            id: task.id,
            title: task.title,
            status: task.status,
            description: task.description,
            branchName: task.branchName,
            createdAt: formatDate(task.createdAt)!,
            updatedAt: formatDate(task.updatedAt)!,
            assignee: actorLabel(task.assignee),
            reviewer: actorLabel(task.actingManager),
          }
        : null,
      epic: task?.epic
        ? {
            id: task.epic.id,
            title: task.epic.title,
            status: task.epic.status,
            description: task.epic.description,
            assignee: actorLabel(task.epic.assignee),
            actingManager: actorLabel(task.epic.actingManager),
          }
        : null,
      parentTask: task?.parent ?? null,
      subtasks: task?.subtasks.map((subtask) => ({
        id: subtask.id,
        title: subtask.title,
        status: subtask.status,
        assignee: actorLabel(subtask.assignee),
      })) ?? [],
    },
    timeline: [],
    attachments: [],
    renderedPrompt: "",
  };

  if (!task) {
    return {
      ...basePacket,
      renderedPrompt: renderAgentContextPacket(basePacket),
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
  const archiveIds = await taskDiscussionArchiveChain(
    args.taskId,
    currentChat?.baseArchiveId ?? null,
  );
  const archivedChats = archiveIds.length > 0
    ? await db.agentChatMessage.findMany({
        where: {
          taskId: args.taskId,
          archiveId: { in: archiveIds },
        },
        orderBy: { createdAt: "asc" },
        take: 80,
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
  const comments = [...task.comments]
    .reverse()
    .filter((comment) => comment.id !== currentId);
  const chats = [...task.chats]
    .reverse()
    .filter((chat) => chat.id !== currentChatId && chat.id !== currentId);
  const activity = [...task.activity].reverse();
  const [taskAttachments, epicAttachments] = await Promise.all([
    attachmentContexts(task.attachments, "task"),
    task.epic ? attachmentContexts(task.epic.attachments, "epic") : [],
  ]);

  const packet: AgentContextPacket = {
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
      ...activity.map((row) => ({
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
    attachments: [...taskAttachments, ...epicAttachments],
  };

  return {
    ...packet,
    renderedPrompt: renderAgentContextPacket(packet),
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

export function renderAgentContextPacket(packet: AgentContextPacket): string {
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

  if (!packet.snapshot.task || !packet.snapshot.project) {
    lines.push(
      "TASK SNAPSHOT:",
      `Task ${packet.scope.id} could not be loaded. Use the current turn only.`,
      "",
      "RESPONSE GUIDANCE:",
      "Answer only from the current turn because PM could not load the work item context.",
    );
    return lines.join("\n");
  }

  const { project, task, epic, parentTask, subtasks } = packet.snapshot;
  lines.push(
    "PROJECT SNAPSHOT:",
    `Project: ${project.name} (${project.slug})`,
    `Project id: ${project.id}`,
    `Project README path: ${project.readmePath || "(not set)"}`,
  );
  pushDescription(lines, "PROJECT DESCRIPTION", project.description, 2500);

  lines.push(
    "",
    "TASK SNAPSHOT:",
    `Task: ${task.title} (${task.id})`,
    `Status: ${task.status}`,
    `Assignee: ${task.assignee}`,
    `Reviewer: ${task.reviewer}`,
    `Branch: ${task.branchName || "(not set)"}`,
    `Parent: ${parentTask ? `${parentTask.title} (${parentTask.status}, ${parentTask.id})` : "(none)"}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
    "",
  );
  pushDescription(lines, "TASK DESCRIPTION", task.description, 6000);

  lines.push("", "EPIC SNAPSHOT:");
  if (epic) {
    lines.push(
      `Epic: ${epic.title} (${epic.status}, ${epic.id})`,
      `Assignee: ${epic.assignee}`,
      `Acting manager: ${epic.actingManager}`,
    );
    pushDescription(lines, "EPIC DESCRIPTION", epic.description, 6000);
  } else {
    lines.push("(none)");
  }

  lines.push("", "SUBTASKS:");
  if (subtasks.length === 0) {
    lines.push("(none)");
  } else {
    for (const subtask of subtasks) {
      lines.push(`- ${subtask.title} [${subtask.status}] assignee: ${subtask.assignee} (${subtask.id})`);
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
    "Use the current turn together with the live PM task, Epic, timeline, and attachment context above. If an attachment is important but only metadata is available, say exactly which attachment needs inspection. Do not invent attachment contents.",
  );

  return lines.join("\n");
}

export async function buildTaskAgentUserMessage(args: {
  taskId: string;
  agentSlug: string;
  currentTurn: TaskAgentCurrentTurn;
}) {
  const packet = await buildTaskAgentContextPacket(args);
  return packet.renderedPrompt;
}
