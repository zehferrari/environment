import { db } from "@/lib/db";
import { buildTaskNativeChannelPrompt } from "@/lib/agents/task-chat-context";
import { buildEpicNativeChannelPrompt } from "@/lib/agents/epic-chat-context";
import { createContextGrantUrl } from "@/lib/agents/context-grants";
import { extractMentions } from "@/lib/markdown";
import { resolveDirectedFromDiscussionRow } from "@/lib/agents/directed-targets";
import {
  formatRecentBlock,
  recentComments,
  recentDiscussion,
} from "@/lib/agents/context-api/recent";

const CACHE_TTL_MS = Number.parseInt(process.env.PM_SPECULATIVE_CONTEXT_TTL_MS ?? "120000", 10);
const MAX_CACHE_ENTRIES = Number.parseInt(process.env.PM_SPECULATIVE_CONTEXT_MAX_ENTRIES ?? "256", 10);

type AgentUser = {
  id: string;
  username: string;
  name: string | null;
  kind: string;
  status: string;
  updatedAt?: Date;
  agent: {
    slug: string | null;
    name: string | null;
    role?: string | null;
    deactivatedAt: Date | null;
    gatewayPort?: number | null;
  } | null;
};

type TargetAgent = { slug: string; gatewayPort: number | null };

type PrebuiltContext = {
  key: string;
  createdAt: number;
  expiresAt: number;
  revision: string;
  scopeType: "task" | "epic";
  scopeId: string;
  projectId: string;
  messageId: string;
  agentSlug: string;
  baseSystemPrompt: string;
};

const cache = new Map<string, PrebuiltContext>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

function ttlMs() {
  return Number.isFinite(CACHE_TTL_MS) && CACHE_TTL_MS > 0 ? CACHE_TTL_MS : 120_000;
}

function maxEntries() {
  return Number.isFinite(MAX_CACHE_ENTRIES) && MAX_CACHE_ENTRIES > 0 ? MAX_CACHE_ENTRIES : 256;
}

function callbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

function targetValueForPrincipal(user: { id: string; kind: string; agent?: { slug?: string | null } | null }) {
  if (user.kind === "agent" && user.agent?.slug) return `agent:${user.agent.slug}`;
  return `user:${user.id}`;
}

function targetLabelForUser(user: {
  username: string;
  kind: string;
  name?: string | null;
  agent?: { slug?: string | null; name?: string | null } | null;
}) {
  if (user.kind === "agent") return user.agent?.name ?? user.name ?? user.username;
  return user.name ?? user.username;
}

function addAgentTarget(targetAgents: Map<string, TargetAgent>, user: AgentUser | null | undefined) {
  if (
    user?.kind === "agent" &&
    user.status === "active" &&
    user.agent?.slug &&
    !user.agent.deactivatedAt
  ) {
    targetAgents.set(user.agent.slug, {
      slug: user.agent.slug,
      gatewayPort: user.agent.gatewayPort ?? null,
    });
    return true;
  }
  return false;
}

function principalTarget(users: AgentUser[], targetAgents: Map<string, TargetAgent>, user: AgentUser | null | undefined) {
  if (!user || user.status !== "active") return null;
  addAgentTarget(targetAgents, user);
  return {
    type: user.kind === "agent" ? "agent" : "user",
    value: targetValueForPrincipal(user),
    label: targetLabelForUser(user),
  };
}

function resolveTargets(args: {
  users: AgentUser[];
  bodyRaw: string;
  selectedTargets: string[];
  task?: { assignee: AgentUser | null; actingManager: AgentUser | null } | null;
  epic?: { actingManager: AgentUser | null } | null;
}) {
  const targetAgents = new Map<string, TargetAgent>();
  let targetType: string | null = null;
  let targetValue: string | null = null;
  let targetLabel: string | null = null;
  const selectedTargets = args.selectedTargets.includes("all-coders")
    ? ["all-coders"]
    : args.selectedTargets.filter((value) => value !== "all-coders");

  const appliedTargets: Array<{ type: string; value: string; label: string }> = [];
  if (selectedTargets[0] === "all-coders") {
    targetType = "all-coders";
    targetValue = "all-coders";
    targetLabel = "All Coders";
    for (const user of args.users) {
      if (user.agent?.role === "coding") addAgentTarget(targetAgents, user);
    }
  } else {
    for (const requestedTarget of selectedTargets) {
      if (requestedTarget.startsWith("agent:")) {
        const agentSlug = requestedTarget.slice("agent:".length);
        const target = principalTarget(
          args.users,
          targetAgents,
          args.users.find((u) => u.kind === "agent" && u.agent?.slug === agentSlug),
        );
        if (target) appliedTargets.push(target);
      } else if (requestedTarget.startsWith("user:")) {
        const userId = requestedTarget.slice("user:".length);
        const target = principalTarget(
          args.users,
          targetAgents,
          args.users.find((u) => u.id === userId),
        );
        if (target) appliedTargets.push(target);
      }
    }

    if (appliedTargets.length === 1) {
      targetType = appliedTargets[0]!.type;
      targetValue = appliedTargets[0]!.value;
      targetLabel = appliedTargets[0]!.label;
    } else if (appliedTargets.length > 1) {
      targetType = "multi";
      targetValue = JSON.stringify(appliedTargets.map((target) => target.value));
      targetLabel = appliedTargets.map((target) => target.label).join(", ");
    }
  }

  const mentions = extractMentions(args.bodyRaw, args.users.map((u) => ({ username: u.username })));
  for (const user of args.users) {
    if (mentions.includes(user.username)) addAgentTarget(targetAgents, user);
  }

  if (!targetType) {
    if (args.task) {
      for (const candidate of [args.task.actingManager, args.task.assignee]) {
        const target = principalTarget(args.users, targetAgents, candidate);
        if (target) {
          targetType = target.type;
          targetValue = target.value;
          targetLabel = target.label;
          break;
        }
      }
    } else if (args.epic) {
      const target = principalTarget(args.users, targetAgents, args.epic.actingManager);
      if (target) {
        targetType = target.type;
        targetValue = target.value;
        targetLabel = target.label;
      }
    }
  }

  const activeAgentSlugs = new Set(
    args.users
      .filter((u) => u.kind === "agent" && u.status === "active" && u.agent?.slug && !u.agent.deactivatedAt)
      .map((u) => u.agent!.slug!),
  );
  const directedDescriptor = resolveDirectedFromDiscussionRow({
    targetType,
    targetValue,
    targetLabel,
    activeAgentSlugs,
  });

  return { targetAgents: [...targetAgents.values()], directedDescriptor, targetType, targetValue, targetLabel };
}

// The directed prompt baked into a prebuilt entry is fully determined by the
// resolved (targetType, targetValue, targetLabel) — so folding them into the
// cache key means an entry is only consumed when the message actually sent
// resolves to the same recipients/silence rule. A draft edited after prebuild
// (e.g. an added @mention) changes these, so the stale entry is no longer a
// hit and the send rebuilds. It also makes any drift between the prebuild and
// send target-resolution paths degrade to a cache miss instead of a wrong prompt.
export function directedTargetKey(args: {
  targetType: string | null;
  targetValue: string | null;
  targetLabel: string | null;
}) {
  return JSON.stringify([args.targetType, args.targetValue, args.targetLabel]);
}

function newestDate(...values: Array<Date | null | undefined>) {
  let max = 0;
  for (const value of values) {
    const time = value?.getTime() ?? 0;
    if (time > max) max = time;
  }
  return max;
}

export async function chatContextRevision(args: {
  projectId: string;
  taskId?: string | null;
  epicId?: string | null;
  excludeMessageId?: string | null;
}) {
  const [project, task, epic, commentsAgg, chatsAgg, activityAgg, attachmentCount, members, usersAgg] = await Promise.all([
    db.project.findUnique({ where: { id: args.projectId }, select: { updatedAt: true } }),
    args.taskId
      ? db.task.findUnique({ where: { id: args.taskId }, select: { updatedAt: true, epicId: true } })
      : Promise.resolve(null),
    args.epicId
      ? db.epic.findUnique({ where: { id: args.epicId }, select: { updatedAt: true } })
      : Promise.resolve(null),
    db.comment.aggregate({
      where: args.taskId ? { taskId: args.taskId } : { epicId: args.epicId ?? undefined },
      _count: { _all: true },
      _max: { createdAt: true, deletedAt: true },
    }),
    db.agentChatMessage.aggregate({
      where: {
        ...(args.taskId ? { taskId: args.taskId } : { epicId: args.epicId ?? undefined }),
        ...(args.excludeMessageId ? { id: { not: args.excludeMessageId } } : {}),
      },
      _count: { _all: true },
      _max: { createdAt: true, deletedAt: true },
    }),
    db.activityLog.aggregate({
      where: {
        ...(args.taskId ? { taskId: args.taskId } : { projectId: args.projectId }),
        ...(args.excludeMessageId ? { NOT: { payload: { contains: args.excludeMessageId } } } : {}),
      },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    db.attachment.count({
      where: args.taskId ? { taskId: args.taskId } : { epicId: args.epicId ?? undefined },
    }),
    db.projectMember.aggregate({
      where: { projectId: args.projectId },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    db.user.aggregate({ _max: { updatedAt: true } }),
  ]);

  const taskEpic = task?.epicId && task.epicId !== args.epicId
    ? await db.epic.findUnique({ where: { id: task.epicId }, select: { updatedAt: true } })
    : null;

  return JSON.stringify({
    p: project?.updatedAt.getTime() ?? 0,
    t: task?.updatedAt.getTime() ?? 0,
    e: newestDate(epic?.updatedAt, taskEpic?.updatedAt),
    c: [commentsAgg._count._all, newestDate(commentsAgg._max.createdAt, commentsAgg._max.deletedAt)],
    ch: [chatsAgg._count._all, newestDate(chatsAgg._max.createdAt, chatsAgg._max.deletedAt)],
    a: [activityAgg._count._all, newestDate(activityAgg._max.createdAt)],
    att: attachmentCount,
    m: [members._count._all, newestDate(members._max.createdAt)],
    u: newestDate(usersAgg._max.updatedAt),
  });
}

function cacheKey(args: {
  scopeType: "task" | "epic";
  scopeId: string;
  projectId: string;
  messageId: string;
  agentSlug: string;
  directedKey: string;
  revision: string;
}) {
  return [args.scopeType, args.scopeId, args.projectId, args.messageId, args.agentSlug, args.directedKey, args.revision].join(":");
}

function pruneCache() {
  const now = Date.now();
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries()) {
    const oldestKey = [...cache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]?.[0];
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

async function prebuildNow(args: {
  projectSlug: string;
  taskId?: string | null;
  epicId?: string | null;
  messageId: string;
  bodyRaw: string;
  selectedTargets: string[];
}) {
  if (!args.messageId || (!args.taskId && !args.epicId)) return { built: 0 };
  const project = await db.project.findUnique({ where: { slug: args.projectSlug }, select: { id: true } });
  if (!project) return { built: 0 };

  const [users, task, epic] = await Promise.all([
    db.user.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        kind: true,
        status: true,
        updatedAt: true,
        agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } },
      },
    }),
    args.taskId
      ? db.task.findUnique({
          where: { id: args.taskId },
          select: {
            id: true,
            title: true,
            projectId: true,
            epicId: true,
            deletedAt: true,
            assignee: { select: { id: true, username: true, name: true, kind: true, status: true, agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } } } },
            actingManager: { select: { id: true, username: true, name: true, kind: true, status: true, agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } } } },
          },
        })
      : Promise.resolve(null),
    args.epicId
      ? db.epic.findUnique({
          where: { id: args.epicId },
          select: {
            id: true,
            title: true,
            projectId: true,
            deletedAt: true,
            actingManager: { select: { id: true, username: true, name: true, kind: true, status: true, agent: { select: { slug: true, name: true, role: true, deactivatedAt: true, gatewayPort: true } } } },
          },
        })
      : Promise.resolve(null),
  ]);

  if (task && (task.projectId !== project.id || task.deletedAt)) return { built: 0 };
  if (epic && (epic.projectId !== project.id || epic.deletedAt)) return { built: 0 };
  if (!task && !epic) return { built: 0 };

  const scopeType = task ? "task" as const : "epic" as const;
  const scopeId = task ? task.id : epic!.id;
  const revision = await chatContextRevision({ projectId: project.id, taskId: task?.id ?? null, epicId: epic?.id ?? null });
  const { targetAgents, directedDescriptor, targetType, targetValue, targetLabel } = resolveTargets({
    users,
    bodyRaw: args.bodyRaw,
    selectedTargets: args.selectedTargets,
    task: task as any,
    epic: epic as any,
  });
  if (targetAgents.length === 0) return { built: 0 };
  const directedKey = directedTargetKey({ targetType, targetValue, targetLabel });

  const [recentDisc, recentCmts] = await Promise.all([
    recentDiscussion(task ? { taskId: task.id } : { epicId: epic!.id }),
    recentComments(task ? { taskId: task.id } : { epicId: epic!.id }),
  ]);
  const inlineRecentBlock = formatRecentBlock({
    scope: scopeType,
    discussion: recentDisc,
    comments: recentCmts,
    currentMessageId: args.messageId,
  });
  const fetchBaseUrl = callbackBaseUrl();
  const now = Date.now();
  const expiresAt = now + ttlMs();

  for (const target of targetAgents) {
    const projectGrantUrl = await createContextGrantUrl({
      baseUrl: fetchBaseUrl,
      agentSlug: target.slug,
      scopeType: "project",
      scopeId: project.id,
      turnId: args.messageId,
    });
    const baseSystemPrompt = task
      ? buildTaskNativeChannelPrompt(task.title, target.slug, directedDescriptor, {
          baseUrl: fetchBaseUrl,
          projectId: project.id,
          inlineRecentBlock,
          taskId: task.id,
          epicId: task.epicId ?? null,
          grantUrls: {
            task: await createContextGrantUrl({
              baseUrl: fetchBaseUrl,
              agentSlug: target.slug,
              scopeType: "task",
              scopeId: task.id,
              turnId: args.messageId,
            }),
            epic: task.epicId
              ? await createContextGrantUrl({
                  baseUrl: fetchBaseUrl,
                  agentSlug: target.slug,
                  scopeType: "epic",
                  scopeId: task.epicId,
                  turnId: args.messageId,
                })
              : null,
            project: projectGrantUrl,
          },
        })
      : buildEpicNativeChannelPrompt(epic!.title, target.slug, directedDescriptor, {
          baseUrl: fetchBaseUrl,
          projectId: project.id,
          inlineRecentBlock,
          epicId: epic!.id,
          grantUrls: {
            epic: await createContextGrantUrl({
              baseUrl: fetchBaseUrl,
              agentSlug: target.slug,
              scopeType: "epic",
              scopeId: epic!.id,
              turnId: args.messageId,
            }),
            project: projectGrantUrl,
          },
        });
    const key = cacheKey({ scopeType, scopeId, projectId: project.id, messageId: args.messageId, agentSlug: target.slug, directedKey, revision });
    cache.set(key, {
      key,
      createdAt: now,
      expiresAt,
      revision,
      scopeType,
      scopeId,
      projectId: project.id,
      messageId: args.messageId,
      agentSlug: target.slug,
      baseSystemPrompt,
    });
  }
  pruneCache();
  return { built: targetAgents.length };
}

export async function scheduleSpeculativeAgentChatContext(args: {
  projectSlug: string;
  taskId?: string | null;
  epicId?: string | null;
  messageId: string;
  bodyRaw: string;
  selectedTargets: string[];
}) {
  const debounceMs = Number.parseInt(process.env.PM_SPECULATIVE_CONTEXT_DEBOUNCE_MS ?? "250", 10);
  const delay = Number.isFinite(debounceMs) && debounceMs > 0 ? debounceMs : 250;
  const scope = args.taskId ? `task:${args.taskId}` : `epic:${args.epicId ?? ""}`;
  const pendingKey = `${scope}:${args.messageId}`;
  const existing = pending.get(pendingKey);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    pending.delete(pendingKey);
    prebuildNow(args).catch((error) => {
      console.warn("[pm] speculative context prebuild failed", error);
    });
  }, delay);
  pending.set(pendingKey, timeout);
  return { scheduled: true };
}

export async function consumeSpeculativeAgentChatContext(args: {
  projectId: string;
  taskId?: string | null;
  epicId?: string | null;
  messageId: string;
  agentSlug: string;
  directedKey: string;
  // The revision is identical across every target agent of a single send, so
  // the caller computes it once and passes it in to avoid re-running the
  // ~9-aggregate revision query per agent. Falls back to computing it when omitted.
  revision?: string;
}) {
  const scopeType = args.taskId ? "task" as const : "epic" as const;
  const scopeId = args.taskId ?? args.epicId;
  if (!scopeId) return null;
  const revision = args.revision
    ?? await chatContextRevision({ projectId: args.projectId, taskId: args.taskId, epicId: args.epicId, excludeMessageId: args.messageId });
  const key = cacheKey({ scopeType, scopeId, projectId: args.projectId, messageId: args.messageId, agentSlug: args.agentSlug, directedKey: args.directedKey, revision });
  const entry = cache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) cache.delete(key);
    return null;
  }
  cache.delete(key);
  return { baseSystemPrompt: entry.baseSystemPrompt };
}

export function speculativeContextCacheStats() {
  pruneCache();
  return { entries: cache.size, pending: pending.size };
}
