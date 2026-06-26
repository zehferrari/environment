"use server";

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isValidClientMessageId } from "@/lib/agents/ops/client-message-id";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { stripChatMarkdown as compactText, truncateSummary } from "@/lib/text";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat, writeFile, readdir, readFile, chmod, chown } from "node:fs/promises";
import {
  getOrCreateAgentSessionBinding,
  type AgentSessionBinding,
} from "@/lib/agents/auth/session-bindings";
import { wakeAgent as wakeGatewayAgent } from "@/lib/pm-consumer/gateway-client";
import { pmAsyncDispatchEnabled, sendOrQueueOpenClawPmChannelTurn } from "@/lib/agents/pm-channel/jobs";
import { buildUnifiedPmTurnSystemPrompt, nullPmContextText } from "@/lib/agents/pm-channel/context";
import { buildPmChannelDispatchMetrics } from "@/lib/agents/pm-channel/openclaw";
import { recordPmChannelRunEvent, recordPmChannelRunQueued } from "@/lib/agents/pm-channel/runs";
import {
  buildProjectEnvContext,
  buildWorkItemPlanningPrompt,
} from "@/lib/agents/context/project";
import { createContextGrantUrl } from "@/lib/agents/context/grants";
import { createWorkItemGrantToken } from "@/lib/agents/workflow/token/work-item";
import { publicOriginFromHeaders } from "@/lib/http/public-origin";
import {
  directChatArchiveChainLimit,
  directChatArchiveContextMessages,
  directChatContextMessages,
  intEnv,
} from "@/lib/agents/context/caps";

const execFileAsync = promisify(execFile);
const MONITOR_DIRECT_CHAT_CONTEXT = [
  "MONITOR ROLE HOST-FLEET CONTEXT:",
  "You are the local monitor agent for the x1 OpenClaw fleet, not just your own OpenClaw session.",
  "When a user asks about any named agent, gateway, PM workflow stall, or service health, inspect the host fleet before answering.",
  "Do not rely on your local OpenClaw agents_list or your own gateway state as proof that another agent is missing or unreachable.",
  "Use the host registry and service surfaces that are available to the monitor role: /etc/openclaw/agents.json, /srv/agents/index.json, agent-dashboard snapshots, ai-monitor state/logs, systemctl user services for the target agent, and journalctl logs.",
  "For a gateway issue, resolve the target user's UID, check XDG_RUNTIME_DIR=/run/user/<uid>, inspect openclaw-gateway.service as that user, check recent logs, then restart/wake through openclaw-control when appropriate.",
  "If you cannot run one of those checks, say exactly which check was unavailable and what evidence you do have.",
].join("\n");

async function requireUserId() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error("Unauthenticated");
  const userKind = session.user.kind === "agent" ? "agent" : "human";
  return { userId, userName: session.user.name ?? "PM user", userKind };
}

function agentCallbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

function buildReplyUrl(agentSlug: string) {
  return new URL(`/api/agents/${encodeURIComponent(agentSlug)}/chat/reply`, agentCallbackBaseUrl()).toString();
}

function formatDate(value: Date) {
  return value.toISOString();
}

function clip(value: string, max = 3000) {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}\n[truncated]`;
}

function activeContextMessages() {
  return directChatContextMessages();
}

function archiveContextMessages() {
  return directChatArchiveContextMessages();
}

function archiveChainLimit() {
  return directChatArchiveChainLimit();
}

function shouldIncludeDirectFilesContext(args: {
  body: string;
  attachmentCount: number;
  projectId: string | null;
}) {
  if (args.attachmentCount > 0) return true;
  if (process.env.PM_DIRECT_CHAT_ALWAYS_INCLUDE_FILES_CONTEXT === "1") return true;
  if (args.projectId) return false;
  return /\b(attach(?:ed|ment|ments)?|file|files|document|context|folder|upload|readme|logs?)\b/i.test(args.body);
}

export async function getAgentChatUploadDir(agentSlug: string, chatId: string): Promise<string> {
  const basePattern = process.env.PM_AGENT_SAMBA_ROOT ?? "/srv/samba/shared/[agent]";
  const baseDir = basePattern.replace("[agent]", agentSlug);
  return path.join(baseDir, "chats", chatId);
}

export async function getConversationFolderIds(agentSlug: string, baseArchiveId: string | null): Promise<string[]> {
  const folders: string[] = [];
  let currentId = baseArchiveId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const archive = await db.directAgentChatArchive.findFirst({
      where: { id: currentId, agentSlug, deletedAt: null },
      select: { id: true, parentArchiveId: true },
    });
    if (!archive) break;
    folders.push(archive.id);
    currentId = archive.parentArchiveId;
  }
  return folders;
}

export async function appendFilesContext(agentSlug: string, folderIds: string[]): Promise<string> {
  const lines: string[] = [];
  const limit = intEnv("PM_AGENT_CONTEXT_ATTACHMENT_TEXT_MAX_BYTES", 98304, 1024, 512 * 1024);
  let totalBytes = 0;

  for (const folderId of folderIds) {
    const dir = await getAgentChatUploadDir(agentSlug, folderId);
    if (!existsSync(dir)) continue;

    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        const stats = await stat(filePath);
        
        lines.push(`- File: ${entry.name} (${stats.size} bytes)`);
        lines.push(`  Path: ${filePath}`);

        // Read content if it's text-like and within limits
        const ext = path.extname(entry.name).toLowerCase();
        const isText = [".txt", ".md", ".js", ".ts", ".py", ".json", ".csv", ".yml", ".yaml", ".sh", ".html", ".css"].includes(ext);
        if (isText && stats.size < 50000 && totalBytes + stats.size < limit) {
          try {
            const content = await readFile(filePath, "utf8");
            lines.push("  Content:");
            lines.push("  ```");
            lines.push(content.slice(0, 10000));
            lines.push("  ```");
            totalBytes += stats.size;
          } catch {
            lines.push("  [Error reading content]");
          }
        }
        lines.push("");
      }
    } catch (e) {
      console.error(`Error reading files context for ${dir}`, e);
    }
  }

  if (lines.length === 0) return "";
  return [
    "ATTACHED CONTEXT FILES (accessible in your local environment):",
    ...lines,
    "",
  ].join("\n");
}

function formatTranscript(
  messages: Array<{
    id: string;
    body: string;
    createdAt: Date;
    sender: { username: string; kind: string };
  }>,
  currentMessageId?: string,
  maxChars = 1200,
) {
  return messages.flatMap((m) => [
    `[${formatDate(m.createdAt)}] @${m.sender.username}${m.sender.kind === "agent" ? " (agent)" : ""}${m.id === currentMessageId ? " [CURRENT]" : ""}:`,
    clip(m.body, m.id === currentMessageId ? 8000 : maxChars),
    "",
  ]);
}

async function loadArchiveChain(agentSlug: string, archiveId: string | null) {
  const chain: Array<{
    id: string;
    summary: string;
    startedAt: Date;
    endedAt: Date;
    parentArchiveId: string | null;
  }> = [];
  const seen = new Set<string>();
  let currentId = archiveId;
  while (currentId && !seen.has(currentId) && chain.length < archiveChainLimit()) {
    seen.add(currentId);
    const archive = await db.directAgentChatArchive.findFirst({
      where: { id: currentId, agentSlug, deletedAt: null },
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        parentArchiveId: true,
      },
    });
    if (!archive) break;
    chain.unshift(archive);
    currentId = archive.parentArchiveId;
  }
  return chain;
}

async function buildBaseArchiveContext(agentSlug: string, baseArchiveId: string | null) {
  const chain = await loadArchiveChain(agentSlug, baseArchiveId);
  if (chain.length === 0) return [];

  const lines = [
    "BASE ARCHIVE CONTEXT:",
    "The current conversation is a child continuation. The frozen archive transcript below is context only; do not mutate it.",
    "",
  ];
  for (const archive of chain) {
    const messages = await db.directAgentChatMessage.findMany({
      where: { agentSlug, archiveId: archive.id },
      orderBy: { createdAt: "desc" },
      take: archiveContextMessages(),
      include: { sender: { select: { username: true, kind: true } } },
    });
    lines.push(
      `Archive ${archive.id}: ${archive.summary}`,
      `Period: ${formatDate(archive.startedAt)} - ${formatDate(archive.endedAt)}`,
      `Excerpt: latest ${messages.length} archived messages, oldest to newest.`,
      "-----",
      ...formatTranscript(messages.reverse(), undefined, 800),
      "-----",
      "",
    );
  }
  return lines;
}

async function buildDirectSessionContext(args: {
  agentSlug: string;
  messageId: string;
  actorName: string;
  body: string;
}) {
  const original = await db.directAgentChatMessage.findUnique({
    where: { id: args.messageId },
    select: { archiveId: true, baseArchiveId: true },
  });
  const archive = original?.archiveId
    ? await db.directAgentChatArchive.findFirst({
        where: { id: original.archiveId, agentSlug: args.agentSlug, deletedAt: null },
        select: { parentArchiveId: true },
      })
    : null;
  const baseArchiveId = original?.baseArchiveId ?? archive?.parentArchiveId ?? null;
  const baseContext = await buildBaseArchiveContext(args.agentSlug, baseArchiveId);
  const recent = await db.directAgentChatMessage.findMany({
    where: {
      agentSlug: args.agentSlug,
      archiveId: original?.archiveId ?? null,
      baseArchiveId,
    },
    orderBy: { createdAt: "desc" },
    take: activeContextMessages(),
    include: { sender: { select: { username: true, kind: true } } },
  });
  const messages = recent.reverse();
  const transcript = messages.length > 0
    ? formatTranscript(messages, args.messageId, 1200)
    : [
        `[CURRENT] ${args.actorName}:`,
        clip(args.body),
        "",
      ];
  return [
    `Direct PM chat with @${args.agentSlug}.`,
    original?.archiveId
      ? `Archive id: ${original.archiveId}.`
      : baseArchiveId
        ? `Current active child chat based on archive ${baseArchiveId}.`
        : "Current active chat.",
    "",
    ...baseContext,
    "RECENT SESSION TRANSCRIPT (oldest to newest):",
    ...transcript,
    "Use the full session transcript when answering. Do not answer only from the last message if earlier turns change the context.",
  ].join("\n");
}

function buildWakePrompt(args: {
  agentSlug: string;
  actorName: string;
  messageId: string;
  token: string;
  sessionContext: string;
  sessionBinding: AgentSessionBinding;
}) {
  const replyUrl = buildReplyUrl(args.agentSlug);
  const exampleBody = JSON.stringify({
    messageId: args.messageId,
    token: args.token,
    body: "<your markdown reply>",
  });
  return [
    `PM direct chat message for @${args.agentSlug} from ${args.actorName}.`,
    `OpenClaw session key: ${args.sessionBinding.openclawSessionKey}`,
    "",
    "Conversation context:",
    args.sessionContext,
    "",
    "Reply in the PM direct chat window by POSTing JSON to:",
    replyUrl,
    "",
    "Body shape:",
    exampleBody,
    "",
    "Use markdown if useful. Do not only answer in your private session; the PM chat window updates only when you POST the reply.",
  ].join("\n");
}

function buildDirectReplyPrompt(args: {
  agentSlug: string;
  actorName: string;
  sessionContext: string;
  sessionBinding: AgentSessionBinding;
}) {
  return [
    `PM direct chat message for @${args.agentSlug} from ${args.actorName}.`,
    `OpenClaw session key: ${args.sessionBinding.openclawSessionKey}`,
    "",
    "Reply directly to the user's message. Keep the answer useful and concise unless the user asked for detail.",
    "Do not mention callback URLs, internal tokens, or implementation details.",
    "",
    "Conversation context:",
    args.sessionContext,
  ].join("\n");
}

function summarizeMessages(messages: Array<{ body: string; sender: { kind: string } }>) {
  const firstHuman = messages.find((m) => m.sender.kind === "human");
  const source = compactText(firstHuman?.body ?? messages[0]?.body ?? "");
  return truncateSummary(source || "Direct chat");
}

function monitorWakeHelperPath() {
  return process.env.PM_MONITOR_WAKE_HELPER
    ?? process.env.PM_KAREN_WAKE_HELPER
    ?? "/usr/local/sbin/pm-monitor-wake-agent";
}

async function wakeAgentViaMonitor(agentSlug: string, prompt: string, sessionBinding: AgentSessionBinding) {
  await execFileAsync("sudo", [
    "-n",
    monitorWakeHelperPath(),
    agentSlug,
    "--session-key",
    sessionBinding.openclawSessionId ?? sessionBinding.openclawSessionKey,
    prompt,
  ], { timeout: 45000 });
}

async function wakeDirectAgent(args: {
  agentSlug: string;
  gatewayPort: number | null;
  prompt: string;
  sessionBinding: AgentSessionBinding;
}) {
  const sessionKey = args.sessionBinding.openclawSessionId
    ?? args.sessionBinding.openclawSessionKey;
  if (args.gatewayPort) {
    const result = await wakeGatewayAgent({
      gatewayPort: args.gatewayPort,
      slug: args.agentSlug,
      text: args.prompt,
      mode: "now",
      sessionKey,
    });
    if (result.ok) return result.driver ?? "gateway-http";
    throw new Error(result.error ?? "Gateway wake failed");
  }

  await wakeAgentViaMonitor(args.agentSlug, args.prompt, args.sessionBinding);
  return "monitor-control" as const;
}

function currentProcessUser() {
  return process.env.USER ?? process.env.LOGNAME ?? "";
}

function canRunLocalOpenClawAgent(agentSlug: string) {
  return process.env.PM_DIRECT_CHAT_DRIVER !== "wake"
    && currentProcessUser() === agentSlug;
}

function directChatTimeoutSeconds() {
  const raw = Number(process.env.PM_DIRECT_CHAT_TIMEOUT_SECONDS ?? 90);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 90;
}

function directChatUploadedFiles(formData: FormData) {
  return formData
    .getAll("attachments")
    .filter((file): file is File => (
      typeof file !== "string"
      && typeof file.name === "string"
      && typeof file.size === "number"
      && typeof file.arrayBuffer === "function"
      && file.size > 0
    ));
}

function appendDirectAttachmentNames(body: string, files: File[]) {
  if (files.length === 0) return body;
  return [
    body,
    "",
    "Attached files:",
    ...files.map((file) => `- ${path.basename(file.name)}`),
  ].filter(Boolean).join("\n");
}

type DirectPmWorkItemRef = {
  kind: "task" | "epic";
  projectSlug: string;
  id: string;
};

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractPmWorkItemRefs(text: string): DirectPmWorkItemRef[] {
  const refs: DirectPmWorkItemRef[] = [];
  const seen = new Set<string>();
  const re = /\/projects\/([^/\s?#]+)\/(tasks|epics)\/([A-Za-z0-9_-]+)/g;
  for (const match of text.matchAll(re)) {
    const projectSlug = safeDecodeURIComponent(match[1] ?? "").trim();
    const routeKind = match[2] ?? "";
    const id = (match[3] ?? "").trim();
    if (!projectSlug || !id) continue;
    const kind = routeKind === "tasks" ? "task" : "epic";
    const key = `${projectSlug}:${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind, projectSlug, id });
  }
  return refs;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

async function inferProjectIdFromPmWorkItemLinks(body: string) {
  const slugs = unique(extractPmWorkItemRefs(body).map((ref) => ref.projectSlug));
  if (slugs.length !== 1) return null;
  const project = await db.project.findFirst({
    where: { slug: slugs[0], deletedAt: null },
    select: { id: true },
  });
  return project?.id ?? null;
}

function directlyRequestsWorkItemManagement(body: string) {
  const text = body.toLowerCase();
  const workItemNoun = "(?:work[- ]?item|task|sub[- ]?task|epic|action plan|proposal|board|backlog)";
  const managementVerb = "(?:create|add|make|open|update|edit|change|reorganize|re-organize|move|assign|comment|archive|delete|split|break down|breakdown|propose|submit)";
  return (
    new RegExp(`\\b${managementVerb}\\b.{0,80}\\b${workItemNoun}\\b`).test(text) ||
    new RegExp(`\\b${workItemNoun}\\b.{0,80}\\b${managementVerb}\\b`).test(text)
  );
}

function buildDirectLiveContextBlock(args: {
  projectUrl: string;
  tasks: Array<{ id: string; title: string; url: string }>;
  epics: Array<{ id: string; title: string; url: string }>;
}) {
  const lines = [
    "LIVE PM CONTEXT - FETCH WHEN YOU NEED DEEPER HISTORY:",
    "PM exposes loopback-only JSON endpoints through the short-lived grant URLs below. Use these URLs instead of opening a public browser URL from the user's message.",
    "",
    "  # Project overview, active epics/open tasks, repository path, git identity, and valid assignee / actingManager / deployReviewer principals:",
    `  curl -s '${args.projectUrl}'`,
  ];

  if (args.epics.length > 0) {
    lines.push("", "  # Same-project epics explicitly linked in this turn, plus parent epics for linked tasks:");
    for (const epic of args.epics) {
      lines.push(`  # ${epic.title} (${epic.id})`);
      lines.push(`  curl -s '${epic.url}'`);
    }
  } else {
    lines.push(
      "",
      "  # No same-project epic grant was issued. Use the project overview or ask for a scoped Task/Epic turn if deep item history is required.",
    );
  }

  if (args.tasks.length > 0) {
    lines.push("", "  # Same-project tasks explicitly linked in this turn:");
    for (const task of args.tasks) {
      lines.push(`  # ${task.title} (${task.id})`);
      lines.push(`  curl -s '${task.url}'`);
    }
  }

  lines.push(
    "",
    "Soft-deleted comments / chats are filtered server-side. Attachment download URLs inside fetched JSON require the same grant token and should be called from loopback. Full contract: ai/web/docs/agent-pm-api.md.",
  );
  return lines.join("\n");
}

async function buildDirectLiveContextAccess(args: {
  agentSlug: string;
  messageId: string;
  projectId: string;
  body: string;
}) {
  const baseUrl = agentCallbackBaseUrl();
  const projectUrl = await createContextGrantUrl({
    baseUrl,
    agentSlug: args.agentSlug,
    scopeType: "project",
    scopeId: args.projectId,
    turnId: args.messageId,
  });

  const refs = extractPmWorkItemRefs(args.body);
  const taskIds = unique(
    refs.filter((ref) => ref.kind === "task").map((ref) => ref.id),
  ).slice(0, 5);
  const explicitEpicIds = unique(
    refs.filter((ref) => ref.kind === "epic").map((ref) => ref.id),
  ).slice(0, 5);

  const tasks = taskIds.length
    ? await db.task.findMany({
        where: {
          id: { in: taskIds },
          projectId: args.projectId,
          deletedAt: null,
        },
        select: {
          id: true,
          title: true,
          epicId: true,
        },
      })
    : [];

  const epicIds = unique([
    ...explicitEpicIds,
    ...tasks.map((task) => task.epicId ?? ""),
  ]).slice(0, 8);
  const epics = epicIds.length
    ? await db.epic.findMany({
        where: {
          id: { in: epicIds },
          projectId: args.projectId,
          deletedAt: null,
        },
        select: { id: true, title: true },
      })
    : [];

  const [taskGrantRows, epicGrantRows] = await Promise.all([
    Promise.all(tasks.map(async (task) => ({
      id: task.id,
      title: task.title,
      url: await createContextGrantUrl({
        baseUrl,
        agentSlug: args.agentSlug,
        scopeType: "task",
        scopeId: task.id,
        turnId: args.messageId,
      }),
    }))),
    Promise.all(epics.map(async (epic) => ({
      id: epic.id,
      title: epic.title,
      url: await createContextGrantUrl({
        baseUrl,
        agentSlug: args.agentSlug,
        scopeType: "epic",
        scopeId: epic.id,
        turnId: args.messageId,
      }),
    }))),
  ]);

  return buildDirectLiveContextBlock({
    projectUrl,
    tasks: taskGrantRows,
    epics: epicGrantRows,
  });
}

function extractOpenClawReply(stdout: string) {
  const parsed = JSON.parse(stdout) as {
    runId?: unknown;
    result?: {
      payloads?: Array<{ text?: unknown }>;
      meta?: {
        durationMs?: unknown;
        finalAssistantVisibleText?: unknown;
        finalAssistantRawText?: unknown;
        agentMeta?: {
          provider?: unknown;
          model?: unknown;
          usage?: unknown;
          lastCallUsage?: unknown;
        };
        requestShaping?: {
          thinking?: unknown;
        };
      };
    };
  };
  const payloadText = parsed.result?.payloads
    ?.map((p) => (typeof p.text === "string" ? p.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
  const meta = parsed.result?.meta;
  const diagnostics = {
    runId: typeof parsed.runId === "string" ? parsed.runId : null,
    durationMs: typeof meta?.durationMs === "number" ? meta.durationMs : null,
    provider: typeof meta?.agentMeta?.provider === "string" ? meta.agentMeta.provider : null,
    model: typeof meta?.agentMeta?.model === "string" ? meta.agentMeta.model : null,
    usage: meta?.agentMeta?.usage ?? meta?.agentMeta?.lastCallUsage ?? null,
    thinking: typeof meta?.requestShaping?.thinking === "string" ? meta.requestShaping.thinking : null,
  };
  if (payloadText) return { body: payloadText, diagnostics };

  const visible = meta?.finalAssistantVisibleText;
  if (typeof visible === "string" && visible.trim()) {
    return { body: visible.trim(), diagnostics };
  }

  const raw = meta?.finalAssistantRawText;
  if (typeof raw === "string" && raw.trim()) {
    return { body: raw.trim(), diagnostics };
  }

  throw new Error("OpenClaw returned no visible reply text");
}

async function runLocalOpenClawAgent(prompt: string, sessionBinding: AgentSessionBinding) {
  const timeoutSeconds = directChatTimeoutSeconds();
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.HOME ??= `/home/${currentProcessUser()}`;
  if (!env.XDG_RUNTIME_DIR && typeof process.getuid === "function") {
    env.XDG_RUNTIME_DIR = `/run/user/${process.getuid()}`;
  }

  const { stdout } = await execFileAsync("/usr/local/bin/openclaw", [
    "agent",
    "--agent",
    process.env.PM_DIRECT_CHAT_OPENCLAW_AGENT_ID ?? "main",
    "--message",
    prompt,
    "--session-id",
    sessionBinding.openclawSessionId ?? sessionBinding.openclawSessionKey,
    "--thinking",
    process.env.PM_DIRECT_CHAT_THINKING ?? "off",
    "--timeout",
    String(timeoutSeconds),
    "--json",
  ], {
    env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: (timeoutSeconds + 15) * 1000,
  });

  return extractOpenClawReply(stdout);
}

async function persistAgentReply(args: {
  agentSlug: string;
  agentUserId: string;
  body: string;
  inReplyToMessageId: string;
  diagnostics?: unknown;
}) {
  await db.$transaction(async (tx) => {
    const original = await tx.directAgentChatMessage.findUnique({
      where: { id: args.inReplyToMessageId },
      select: { archiveId: true, baseArchiveId: true },
    });
    const reply = await tx.directAgentChatMessage.create({
      data: {
        agentSlug: args.agentSlug,
        senderUserId: args.agentUserId,
        archiveId: original?.archiveId ?? null,
        baseArchiveId: original?.baseArchiveId ?? null,
        body: args.body,
      },
      select: { id: true, archiveId: true, createdAt: true },
    });
    if (reply.archiveId) {
      await tx.directAgentChatArchive.update({
        where: { id: reply.archiveId },
        data: {
          endedAt: reply.createdAt,
          messageCount: { increment: 1 },
        },
      });
    }
    await tx.activityLog.create({
      data: {
        userId: args.agentUserId,
        kind: "agent.direct_chat.reply",
        targetAgent: args.agentSlug,
        payload: JSON.stringify({
          agentSlug: args.agentSlug,
          messageId: reply.id,
          inReplyToMessageId: args.inReplyToMessageId,
          driver: "openclaw-agent",
          diagnostics: args.diagnostics ?? null,
        }),
      },
    });
  });
}

async function handleDirectAgentMessage(args: {
  agentSlug: string;
  agentRole: string | null;
  actorName: string;
  body: string;
  messageId: string;
  userId: string;
  gatewayPort: number | null;
  sessionBinding: AgentSessionBinding;
  projectId: string | null;
  allowWorkItemManagement: boolean;
  attachmentCount: number;
  publicOrigin: string | null;
}) {
  const timingStartedAt = Date.now();
  const timings: Record<string, number> = {};
  const sizes: Record<string, number> = {};
  const mark = (name: string, startedAt: number) => {
    timings[name] = Date.now() - startedAt;
  };

  let stepStartedAt = Date.now();
  const sessionContext = await buildDirectSessionContext(args);
  mark("sessionContextMs", stepStartedAt);
  sizes.sessionContextChars = sessionContext.length;

  stepStartedAt = Date.now();
  const original = await db.directAgentChatMessage.findUnique({
    where: { id: args.messageId },
    select: { baseArchiveId: true, archiveId: true },
  });
  const baseArchiveId = original?.baseArchiveId ?? null;
  const parentFolders = await getConversationFolderIds(args.agentSlug, baseArchiveId);
  const folderIds = [args.sessionBinding.scopeId, ...parentFolders];
  const includeFilesContext = shouldIncludeDirectFilesContext({
    body: args.body,
    attachmentCount: args.attachmentCount,
    projectId: args.projectId,
  });
  const filesContext = includeFilesContext
    ? await appendFilesContext(args.agentSlug, folderIds)
    : "";
  mark("filesContextMs", stepStartedAt);
  sizes.filesContextChars = filesContext.length;

  // Project-scoped planning: when a project is attached, include its
  // environment packet; when the user also granted work-item management,
  // hand the agent the propose endpoint + a one-shot grant token bound to
  // this message (the sanctioned write-action pattern).
  const systemPromptParts = [
    `Direct PM chat message for @${args.agentSlug} from ${args.actorName}.`,
    `OpenClaw session key: ${args.sessionBinding.openclawSessionKey}`,
    "This turn arrived through the native OpenClaw PM channel.",
    "Reply normally; OpenClaw will deliver your visible response back to the PM chat window.",
    "Keep the answer useful and concise unless the user asked for detail.",
  ];
  if (args.agentRole === "monitor") {
    systemPromptParts.push("", MONITOR_DIRECT_CHAT_CONTEXT);
  }
  let projectContextText = "";
  stepStartedAt = Date.now();
  if (args.projectId) {
    const env = await buildProjectEnvContext(args.projectId);
    if (env) {
      projectContextText = env.text;
      const liveContextBlock = await buildDirectLiveContextAccess({
        agentSlug: args.agentSlug,
        messageId: args.messageId,
        projectId: args.projectId,
        body: args.body,
      });
      systemPromptParts.push("", liveContextBlock);
      if (args.allowWorkItemManagement) {
        const token = createWorkItemGrantToken(args.projectId, args.agentSlug, args.messageId);
        const proposeUrl = new URL(
          `/api/agent/projects/${args.projectId}/proposals`,
          agentCallbackBaseUrl(),
        ).toString();
        systemPromptParts.push(
          "",
          buildWorkItemPlanningPrompt({
            agentSlug: args.agentSlug,
            projectSlug: env.projectSlug,
            proposeUrl,
            grantMessageId: args.messageId,
            token,
            autoApply: true,
            publicOrigin: args.publicOrigin,
          }),
        );
      }
    }
  }
  mark("projectContextMs", stepStartedAt);
  sizes.projectContextChars = projectContextText.length;

  const primaryContext = [sessionContext, filesContext, projectContextText]
    .filter(Boolean)
    .join("\n\n");
  sizes.primaryContextChars = primaryContext.length;

  stepStartedAt = Date.now();
  const dispatchArgs = {
    gatewayPort: args.gatewayPort,
    agentSlug: args.agentSlug,
    sessionKey: args.sessionBinding.openclawSessionKey,
    kind: "direct" as const,
    text: args.body,
    contextText: nullPmContextText(),
    systemPrompt: buildUnifiedPmTurnSystemPrompt({
      kind: "direct",
      trustedPrompt: systemPromptParts.join("\n"),
      primaryContext,
    }),
    projectId: args.projectId,
    actor: {
      id: args.userId,
      username: args.actorName,
      kind: "human" as const,
    },
    replyTarget: {
      kind: "direct" as const,
      agentSlug: args.agentSlug,
      messageId: args.messageId,
    },
  };
  const dispatchMetrics = buildPmChannelDispatchMetrics(dispatchArgs);
  const delivery = await sendOrQueueOpenClawPmChannelTurn(dispatchArgs);
  mark("queueOrDispatchMs", stepStartedAt);
  timings.totalBeforeActivityLogMs = Date.now() - timingStartedAt;

  await db.activityLog.create({
    data: {
      userId: args.userId,
      kind: delivery.ok
        ? "agent.direct_chat.dispatch"
        : "agent.direct_chat.dispatch_failed",
      targetAgent: args.agentSlug,
      payload: JSON.stringify({
        agentSlug: args.agentSlug,
        messageId: args.messageId,
        driver: delivery.driver,
        status: delivery.status ?? null,
        openclawSessionKey: args.sessionBinding.openclawSessionKey,
        error: delivery.error ?? null,
        timings,
        sizes,
        dispatchMetrics,
        includeFilesContext,
        parentFolderCount: parentFolders.length,
      }),
    },
  });

  if (!delivery.ok) {
    console.warn(`[direct-chat] failed to dispatch ${args.agentSlug} through PM channel: ${delivery.error ?? "unknown"}`);
  }
}

function getGidByName(groupName: string): number | null {
  try {
    const content = readFileSync("/etc/group", "utf8");
    for (const line of content.split("\n")) {
      const parts = line.split(":");
      if (parts[0] === groupName) {
        const gid = parseInt(parts[2], 10);
        if (!isNaN(gid)) return gid;
      }
    }
  } catch (e) {
    console.error("Failed to read /etc/group", e);
  }
  return null;
}

export async function sendDirectAgentMessage(formData: FormData) {
  const publicOrigin = publicOriginFromHeaders(await headers());
  const { userId, userName, userKind } = await requireUserId();
  const agentSlug = String(formData.get("agentSlug") ?? "").trim();
  const requestedBaseArchiveId = String(formData.get("baseArchiveId") ?? "").trim() || null;
  const continueFromArchive = formData.get("continueFromArchive") === "1";
  const bodyRaw = String(formData.get("body") ?? "").trim();
  const attachments = directChatUploadedFiles(formData);
  const body = appendDirectAttachmentNames(bodyRaw, attachments);
  const requestedProjectId = String(formData.get("projectId") ?? "").trim() || null;
  // The client supplies the message id so the optimistic echo can reconcile by
  // id (not fragile body matching) and a double-fire is idempotent.
  const requestedMessageId = String(formData.get("clientMessageId") ?? "").trim() || null;
  if (!agentSlug || (!bodyRaw && attachments.length === 0) || body.length > 8000) return;
  if (requestedMessageId && !isValidClientMessageId(requestedMessageId)) {
    throw new Error("Invalid client messageId");
  }

  const agent = await db.agent.findUnique({
    where: { slug: agentSlug },
    select: {
      slug: true,
      role: true,
      deactivatedAt: true,
      gatewayPort: true,
      user: { select: { id: true, status: true } },
    },
  });
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") return;

  // Optional project attachment for planning. Project context may be useful for
  // ordinary Q&A, but the one-shot proposal capability is only attached when
  // the human message explicitly asks to manage work items. Otherwise the
  // proposal instructions can pressure agents into sending unsolicited Action
  // Plans/proposals during status/debug conversations.
  let projectId: string | null = requestedProjectId;
  if (!projectId) {
    projectId = await inferProjectIdFromPmWorkItemLinks(bodyRaw);
  }
  if (projectId) {
    const proj = await db.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { id: true },
    });
    if (!proj) projectId = null;
  }
  const grantWorkItems = userKind === "human" && projectId !== null && directlyRequestsWorkItemManagement(bodyRaw);

  let baseArchiveId = requestedBaseArchiveId;
  if (baseArchiveId) {
    const archive = await db.directAgentChatArchive.findFirst({
      where: { id: baseArchiveId, agentSlug, deletedAt: null },
      select: { id: true },
    });
    if (!archive) return;
  } else {
    const latestActive = await db.directAgentChatMessage.findFirst({
      where: { agentSlug, archiveId: null },
      orderBy: { createdAt: "desc" },
      select: { baseArchiveId: true },
    });
    baseArchiveId = latestActive?.baseArchiveId ?? null;
  }

  // Idempotency: a retried/double-fired submit with the same client id must not
  // create a second row (and must not re-dispatch).
  if (requestedMessageId) {
    const existing = await db.directAgentChatMessage.findUnique({
      where: { id: requestedMessageId },
      select: { id: true },
    });
    if (existing) {
      revalidatePath(`/agents/${agentSlug}/chat`);
      if (continueFromArchive) redirect(`/agents/${agentSlug}/chat`);
      return;
    }
  }

  const msg = await db.$transaction(async (tx) => {
    const created = await tx.directAgentChatMessage.create({
      data: {
        ...(requestedMessageId ? { id: requestedMessageId } : {}),
        agentSlug,
        senderUserId: userId,
        baseArchiveId,
        body,
        projectId,
        allowWorkItemManagement: grantWorkItems,
      },
      select: { id: true },
    });
    await tx.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.send",
        targetAgent: agentSlug,
        payload: JSON.stringify({
          agentSlug,
          messageId: created.id,
          baseArchiveId,
          projectId,
          allowWorkItemManagement: grantWorkItems,
          publicOrigin,
        }),
      },
    });
    return created;
  });

  const activeAnchor = await db.directAgentChatMessage.findFirst({
    where: { agentSlug, archiveId: null, baseArchiveId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const sessionBinding = await getOrCreateAgentSessionBinding({
    scopeType: "direct",
    scopeId: activeAnchor?.id ?? msg.id,
    agentSlug,
  });

  // Handle files upload to Samba chats folder
  const chatId = activeAnchor?.id ?? msg.id;
  const uploadDir = await getAgentChatUploadDir(agentSlug, chatId);
  for (const file of attachments) {
    if (file && file.size > 0 && file.name) {
      const filename = path.basename(file.name);
      if (!filename) continue;
      await mkdir(uploadDir, { recursive: true });
      const chatsDir = path.dirname(uploadDir);
      const gid = getGidByName(agentSlug);
      try {
        await chmod(chatsDir, 0o770);
        await chmod(uploadDir, 0o770);
        if (gid !== null) {
          const chatsDirStats = await stat(chatsDir);
          await chown(chatsDir, chatsDirStats.uid, gid);
          const uploadDirStats = await stat(uploadDir);
          await chown(uploadDir, uploadDirStats.uid, gid);
          
          await execFileAsync("setfacl", ["-m", "g::rwx", chatsDir]);
          await execFileAsync("setfacl", ["-m", "g::rwx", uploadDir]);
        }
      } catch (e) {
        console.error(`Failed to set permissions/owner on directories for ${agentSlug}`, e);
      }
      const filePath = path.join(uploadDir, filename);
      const buffer = Buffer.from(await file.arrayBuffer());
      await writeFile(filePath, buffer);
      try {
        await chmod(filePath, 0o660);
        if (gid !== null) {
          const fileStats = await stat(filePath);
          await chown(filePath, fileStats.uid, gid);
          
          await execFileAsync("setfacl", ["-m", "g::rw-", filePath]);
        }
      } catch (e) {
        console.error(`Failed to set permissions/owner on file ${filePath}`, e);
      }
    }
  }

  // Durability: create the queued run row synchronously so a committed user
  // message ALWAYS has a recoverable run. If the process dies before the
  // dispatch job is created, getPmChannelRunSnapshot's queued-timeout watchdog
  // can still settle the run as failed instead of leaving a permanent spinner.
  await recordPmChannelRunQueued({
    target: { kind: "direct", agentSlug, messageId: msg.id },
    kind: "direct",
    projectId,
    gatewayPort: agent.gatewayPort,
    sessionKey: sessionBinding.openclawSessionKey,
  });

  const dispatchArgs = {
    agentSlug,
    agentRole: agent.role ?? null,
    actorName: userName,
    messageId: msg.id,
    body,
    userId,
    gatewayPort: agent.gatewayPort,
    sessionBinding,
    projectId,
    allowWorkItemManagement: grantWorkItems,
    attachmentCount: attachments.length,
    publicOrigin,
  };
  const recordDispatchFailure = async (err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[direct-chat] failed to queue ${agentSlug} PM-channel turn`, err);
    await db.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.dispatch_failed",
        targetAgent: agentSlug,
        payload: JSON.stringify({
          agentSlug,
          messageId: msg.id,
          openclawSessionKey: sessionBinding.openclawSessionKey,
          error,
        }),
      },
    }).catch(() => undefined);
    // Settle the run so the browser surfaces a failure bubble instead of an
    // indefinite "thinking" spinner.
    await recordPmChannelRunEvent({
      target: { kind: "direct", agentSlug, messageId: msg.id },
      event: "error",
      error,
    }).catch(() => undefined);
  };

  // With async dispatch (the default) the enqueue commits a durable run + job
  // and returns right after the DB write — the agent turn runs off-request in
  // the worker — so awaiting it does NOT block the send on the model, but it
  // DOES guarantee the durable job exists before the request returns (no lost
  // message on a process restart). In legacy synchronous-dispatch mode the call
  // would block on the whole agent turn, so keep it detached there.
  if (pmAsyncDispatchEnabled()) {
    try {
      await handleDirectAgentMessage(dispatchArgs);
    } catch (err) {
      await recordDispatchFailure(err);
    }
  } else {
    setTimeout(() => {
      handleDirectAgentMessage(dispatchArgs).catch((err) => {
        void recordDispatchFailure(err);
      });
    }, 0);
  }

  revalidatePath(`/agents/${agentSlug}/chat`);
  if (continueFromArchive) redirect(`/agents/${agentSlug}/chat`);
}

export async function archiveDirectAgentChat(formData: FormData) {
  const { userId } = await requireUserId();
  const agentSlug = String(formData.get("agentSlug") ?? "").trim();
  const customTitle = String(formData.get("customTitle") ?? "").trim() || null;
  const deleteToBin = formData.get("deleteToBin") === "1" || formData.get("deleteToBin") === "true";
  if (!agentSlug) return;

  const messages = await db.directAgentChatMessage.findMany({
    where: { agentSlug, archiveId: null },
    orderBy: { createdAt: "asc" },
    include: { sender: { select: { kind: true } } },
  });
  if (messages.length === 0) return;

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const parentArchiveId = messages.find((m) => m.baseArchiveId)?.baseArchiveId ?? null;
  const summary = customTitle || summarizeMessages(messages);
  const created = await db.$transaction(async (tx) => {
    const created = await tx.directAgentChatArchive.create({
      data: {
        agentSlug,
        archivedById: userId,
        parentArchiveId,
        summary,
        startedAt: first.createdAt,
        endedAt: last.createdAt,
        messageCount: messages.length,
        deletedAt: deleteToBin ? new Date() : null,
        deletedById: deleteToBin ? userId : null,
      },
      select: { id: true },
    });
    await tx.directAgentChatMessage.updateMany({
      where: { agentSlug, archiveId: null },
      data: { archiveId: created.id },
    });
    await tx.activityLog.create({
      data: {
        userId,
        kind: deleteToBin ? "agent.direct_chat.delete_to_bin" : "agent.direct_chat.archive",
        targetAgent: agentSlug,
        payload: JSON.stringify({
          agentSlug,
          archiveId: created.id,
          parentArchiveId,
          messageCount: messages.length,
        }),
      },
    });
    return created;
  });

  // Rename folder from active anchor ID to archive ID
  const oldDir = await getAgentChatUploadDir(agentSlug, first.id);
  const newDir = await getAgentChatUploadDir(agentSlug, created.id);
  if (existsSync(oldDir)) {
    try {
      await rename(oldDir, newDir);
    } catch (e) {
      console.error(`Failed to rename active folder ${oldDir} to archive ${newDir}`, e);
    }
  }

  revalidatePath(`/agents/${agentSlug}/chat`);
  redirect(`/agents/${agentSlug}/chat`);
}

export async function deleteDirectAgentArchive(formData: FormData) {
  const { userId } = await requireUserId();
  const agentSlug = String(formData.get("agentSlug") ?? "").trim();
  const archiveId = String(formData.get("archiveId") ?? "").trim();
  if (!agentSlug || !archiveId) return;

  const archive = await db.directAgentChatArchive.findUnique({
    where: { id: archiveId },
    select: { id: true, agentSlug: true, deletedAt: true },
  });
  if (!archive || archive.agentSlug !== agentSlug || archive.deletedAt) return;

  const hasChild = await db.directAgentChatArchive.findFirst({
    where: { parentArchiveId: archiveId, deletedAt: null },
    select: { id: true },
  });
  if (hasChild) {
    throw new Error("Cannot delete an archive that has active continuation children.");
  }

  await db.$transaction([
    db.directAgentChatArchive.update({
      where: { id: archiveId },
      data: {
        deletedAt: new Date(),
        deletedById: userId,
      },
    }),
    db.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.archive_delete",
        targetAgent: agentSlug,
        payload: JSON.stringify({ agentSlug, archiveId }),
      },
    }),
  ]);

  revalidatePath(`/agents/${agentSlug}/chat`);
  redirect(`/agents/${agentSlug}/chat`);
}

export async function deleteDirectAgentMessage(formData: FormData) {
  const { userId } = await requireUserId();
  const messageId = String(formData.get("messageId") ?? "");
  const agentSlug = String(formData.get("agentSlug") ?? "");
  if (!messageId || !agentSlug) return;

  const msg = await db.directAgentChatMessage.findUnique({
    where: { id: messageId },
    select: { id: true, agentSlug: true, deletedAt: true },
  });
  if (!msg || msg.agentSlug !== agentSlug) return;
  if (msg.deletedAt) return; // already soft-deleted

  // Soft delete (HOMELAB-41 / item 2). Same convention as
  // deleteChatMessage and deleteComment: the row stays, deletedAt is
  // stamped, and the frontend renders it as a collapsed dotted divider
  // a human can expand. Agent context never sees the deleted body.
  await db.$transaction([
    db.directAgentChatMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date(), deletedById: userId },
    }),
    db.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.delete",
        targetAgent: agentSlug,
        payload: JSON.stringify({ messageId, soft: true }),
      },
    }),
  ]);

  revalidatePath(`/agents/${agentSlug}/chat`);
}

// Restore a soft-deleted direct-agent-chat bubble (HOMELAB-41 / item 2
// follow-up). Inverse of deleteDirectAgentMessage. Idempotent.
export async function restoreDirectAgentMessage(formData: FormData) {
  const { userId } = await requireUserId();
  const messageId = String(formData.get("messageId") ?? "");
  const agentSlug = String(formData.get("agentSlug") ?? "");
  if (!messageId || !agentSlug) return;

  const msg = await db.directAgentChatMessage.findUnique({
    where: { id: messageId },
    select: { id: true, agentSlug: true, deletedAt: true },
  });
  if (!msg || msg.agentSlug !== agentSlug) return;
  if (!msg.deletedAt) return; // already restored

  await db.$transaction([
    db.directAgentChatMessage.update({
      where: { id: messageId },
      data: { deletedAt: null, deletedById: null },
    }),
    db.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.restore",
        targetAgent: agentSlug,
        payload: JSON.stringify({ messageId }),
      },
    }),
  ]);

  revalidatePath(`/agents/${agentSlug}/chat`);
}

export async function restoreDirectAgentArchive(formData: FormData) {
  const { userId } = await requireUserId();
  const agentSlug = String(formData.get("agentSlug") ?? "").trim();
  const archiveId = String(formData.get("archiveId") ?? "").trim();
  if (!agentSlug || !archiveId) return;

  const archive = await db.directAgentChatArchive.findUnique({
    where: { id: archiveId },
    select: { id: true, agentSlug: true, deletedAt: true, parentArchiveId: true },
  });
  if (!archive || archive.agentSlug !== agentSlug || !archive.deletedAt) return;

  const restoreIds: string[] = [archiveId];
  let currentParentId = archive.parentArchiveId;
  const seen = new Set<string>([archiveId]);

  while (currentParentId && !seen.has(currentParentId)) {
    seen.add(currentParentId);
    const parent = await db.directAgentChatArchive.findFirst({
      where: { id: currentParentId, agentSlug },
      select: { id: true, parentArchiveId: true, deletedAt: true },
    });
    if (!parent) break;
    if (parent.deletedAt) {
      restoreIds.push(parent.id);
    }
    currentParentId = parent.parentArchiveId;
  }

  await db.$transaction([
    db.directAgentChatArchive.updateMany({
      where: { id: { in: restoreIds } },
      data: {
        deletedAt: null,
        deletedById: null,
      },
    }),
    db.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.archive_restore",
        targetAgent: agentSlug,
        payload: JSON.stringify({ agentSlug, archiveId, restoreIds }),
      },
    }),
  ]);

  revalidatePath(`/agents/${agentSlug}/chat`);
}

export async function emptyDirectAgentChatBin(formData: FormData) {
  const { userId } = await requireUserId();
  const agentSlug = String(formData.get("agentSlug") ?? "").trim();
  if (!agentSlug) return;

  const deletedArchives = await db.directAgentChatArchive.findMany({
    where: { agentSlug, deletedAt: { not: null } },
    select: { id: true },
  });

  if (deletedArchives.length === 0) return;

  const archiveIds = deletedArchives.map((a) => a.id);

  await db.$transaction([
    db.directAgentChatMessage.deleteMany({
      where: { archiveId: { in: archiveIds } },
    }),
    db.directAgentChatArchive.deleteMany({
      where: { id: { in: archiveIds } },
    }),
    db.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.bin_empty",
        targetAgent: agentSlug,
        payload: JSON.stringify({ agentSlug, archiveIds }),
      },
    }),
  ]);

  for (const archiveId of archiveIds) {
    const uploadDir = await getAgentChatUploadDir(agentSlug, archiveId);
    if (existsSync(uploadDir)) {
      try {
        await rm(uploadDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`Failed to delete archive files at ${uploadDir} during bin empty`, e);
      }
    }
  }

  revalidatePath(`/agents/${agentSlug}/chat`);
}

export async function updateDirectAgentArchiveTitle(formData: FormData) {
  const { userId } = await requireUserId();
  const agentSlug = String(formData.get("agentSlug") ?? "").trim();
  const archiveId = String(formData.get("archiveId") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  if (!agentSlug || !archiveId || !title) return;

  const archive = await db.directAgentChatArchive.findFirst({
    where: { id: archiveId, agentSlug },
    select: { id: true },
  });
  if (!archive) return;

  await db.$transaction([
    db.directAgentChatArchive.update({
      where: { id: archiveId },
      data: { summary: title },
    }),
    db.activityLog.create({
      data: {
        userId,
        kind: "agent.direct_chat.archive_rename",
        targetAgent: agentSlug,
        payload: JSON.stringify({ agentSlug, archiveId, title }),
      },
    }),
  ]);

  revalidatePath(`/agents/${agentSlug}/chat`);
}
