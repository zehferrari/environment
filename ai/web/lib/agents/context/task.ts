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
  directedDescriptor: DirectedDescriptor | null;
  /** Caps used when building this packet — also drives renderer clip sizes. */
  caps: ContextCaps;
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

export interface LiveContextAccess {
  /** Absolute base URL where PM is reachable from this host — loopback only. */
  baseUrl: string;
  /** Per-agent Bearer token (same value as channels.pm.token in this agent's openclaw.json). */
  bearer: string;
  /** Current task id, embedded into a ready-to-curl URL for convenience. */
  taskId: string;
  /** Optional epic id, when the task lives under an Epic — agent should fetch the Epic too. */
  epicId?: string | null;
  /** Project id, for proposing work items. */
  projectId: string;
}

function liveContextFetchBlock(args: LiveContextAccess) {
  return [
    "LIVE PM CONTEXT — FETCH BEFORE YOU REPLY:",
    "PM no longer inlines the whole task context into this prompt — it has grown too large. Instead, fetch the live data over loopback before you respond. PM is reachable ONLY at 127.0.0.1; do NOT call agents.vixi.au or any public URL. Three read endpoints are available, all returning JSON. Authenticate with the Bearer below (same value as channels.pm.token in your ~/.openclaw/openclaw.json):",
    "",
    "  # Required — current task, its comments, full discussion, activity, attachments:",
    `  curl -s -H 'Authorization: Bearer ${args.bearer}' '${args.baseUrl}/api/agents/context/task/${args.taskId}'`,
    "",
    args.epicId
      ? "  # Required — parent epic, since this task lives under one:"
      : "  # Optional — call this only if you reference a different epic:",
    args.epicId
      ? `  curl -s -H 'Authorization: Bearer ${args.bearer}' '${args.baseUrl}/api/agents/context/epic/${args.epicId}'`
      : `  curl -s -H 'Authorization: Bearer ${args.bearer}' '${args.baseUrl}/api/agents/context/epic/<epicId>'`,
    "",
    "  # Use before proposing work-item changes: project env + epics + open tasks + active principals:",
    `  curl -s -H 'Authorization: Bearer ${args.bearer}' '${args.baseUrl}/api/agents/context/project/${args.projectId}'`,
    "",
    "Soft-deleted comments / chats are filtered server-side — anything missing from the response is deliberately invisible to you. Do not infer or invent content that is not in the JSON. Full contract: see ai/web/docs/agent-pm-api.md inside your worktree.",
  ].join("\n");
}

export function buildTaskNativeChannelPrompt(
  taskTitle: string,
  slug: string,
  directedDescriptor?: DirectedDescriptor | null,
  contextAccess?: LiveContextAccess | null,
): string {
  const lines = [
    `You have a PM message on task "${taskTitle}", addressed to @${slug}.`,
    "This turn arrived through the native OpenClaw PM channel.",
    "Golden rule: only create a visible PM reply when you have new information, a concrete action result, a required plan, review feedback, a blocker, or a necessary question.",
    `If you have no contribution to add, reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else. PM will mark the turn complete without creating a visible comment.`,
    "Do not post acknowledgements, restatements, progress filler, or 'nothing to add' comments.",
    "Markdown formatting in your reply is welcome.",
  ];
  if (contextAccess) {
    lines.push("", liveContextFetchBlock(contextAccess));
  }
  if (directedDescriptor) {
    lines.push("", renderDirectedSilenceRule({ descriptor: directedDescriptor, recipientAgentSlug: slug }));
  }
  return lines.join("\n");
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
    description: "<complete final markdown description>",
  });

  return [
    `DESCRIPTION DRAFT CAPABILITY for task "${args.taskTitle}".`,
    "A human-authored message on this task gives you a one-shot capability to PROPOSE A DRAFT of the task description. Your POST does NOT replace the description directly — it lands as a draft on the open task page for the requesting human to review, Save (apply), or Rollback. If the requester closed the page before your POST landed, the draft is reaped within ~60s and no other viewer ever sees it.",
    "Use it only when the current human message directly asks you to update, rewrite, reformat, or replace this task description. If the message is only a question, discussion, or status check, do not call this endpoint.",
    "",
    "To publish a draft, POST application/json to:",
    args.descriptionUrl,
    "Body shape:",
    exampleBody,
    "",
    "The `description` field must contain the COMPLETE final markdown description and nothing else — no preamble, no acknowledgement, no JSON wrapper. After a successful POST, reply through the PM channel with a concise confirmation noting that the requester needs to click Save to apply the draft.",
  ].join("\n");
}

export async function buildTaskAgentContextPacket(args: {
  taskId: string;
  agentSlug: string;
  currentTurn: TaskAgentCurrentTurn;
  directedDescriptor?: DirectedDescriptor | null;
}): Promise<AgentContextPacket> {
  // Caps are role-driven (see ./caps.ts) — coding agents get the 1M
  // profile, monitor agents get the 256k profile. Resolved once per
  // build and threaded through both the Prisma query (row counts) and
  // the renderer (per-body clips).
  const caps = await resolveAgentCaps(args.agentSlug);
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
        // Active discussion only, and never soft-deleted bubbles.
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
      activity: {
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
          // Soft-deleted bubbles inside an archived discussion are
          // also hidden from agent context. HOMELAB-41 / item 2.
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
  pushDescription(lines, "PROJECT DESCRIPTION", project.description, packet.caps.projectDescriptionMax);

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
  pushDescription(lines, "TASK DESCRIPTION", task.description, packet.caps.taskDescriptionMax);

  lines.push("", "EPIC SNAPSHOT:");
  if (epic) {
    lines.push(
      `Epic: ${epic.title} (${epic.status}, ${epic.id})`,
      `Assignee: ${epic.assignee}`,
      `Acting manager: ${epic.actingManager}`,
    );
    pushDescription(lines, "EPIC DESCRIPTION", epic.description, packet.caps.epicDescriptionMax);
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
    "Use the current turn together with the live PM task, Epic, timeline, and attachment context above. If an attachment is important but only metadata is available, say exactly which attachment needs inspection. Do not invent attachment contents.",
    "You can see EVERY comment and EVERY discussion message above, including messages between other people/agents that were not directed at you. Read them as background and use them in your reasoning.",
    `If the current turn requires no visible contribution from you, reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else.`,
  );

  return lines.join("\n");
}

export async function buildTaskAgentUserMessage(args: {
  taskId: string;
  agentSlug: string;
  currentTurn: TaskAgentCurrentTurn;
  directedDescriptor?: DirectedDescriptor | null;
}) {
  const packet = await buildTaskAgentContextPacket(args);
  return packet.renderedPrompt;
}
