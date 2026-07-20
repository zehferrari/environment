// Epic-scoped workflow notification: a directed epic-chat message to one
// agent (usually the acting manager), dispatched through the native PM
// channel so the turn carries a fresh Epic manager workflow grant. Writes the
// durable `epic.workflow.notify` audit row that authorizes the grant when the
// sender is an agent (see hasAuthorizedEpicAgentOrigin) — PM/monitor-generated
// manager wakes no longer need to impersonate the human owner.
import { db } from "@/lib/db";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/auth/session-bindings";
import { sendOrQueueOpenClawPmChannelTurn } from "@/lib/agents/pm-channel/jobs";
import { buildUnifiedPmTurnSystemPrompt, nullPmContextText } from "@/lib/agents/pm-channel/context";
import { createContextGrantUrlMap } from "@/lib/agents/context/grants";
import { DISCUSSION_REPLY_FORMAT_PROMPT } from "@/lib/agents/chat/discussion-reply-format";
import { resolveDirectedFromDiscussionRow } from "@/lib/agents/ops/directed-targets";
import {
  buildEpicNativeChannelPrompt,
  buildEpicNativeIncrementalChannelPrompt,
} from "@/lib/agents/workflow/chat/epic/context";
import {
  formatRecentBlock,
  recentComments,
  recentDiscussion,
} from "@/lib/agents/context/api/recent";

function agentCallbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

export async function sendEpicWorkflowNotification(args: {
  epicId: string;
  targetAgentSlug: string;
  actor: { id: string; username?: string | null; kind: "human" | "agent" };
  reason: string;
  body: string;
}) {
  const agentSlug = args.targetAgentSlug;
  const [epic, agentUser, activeAgents] = await Promise.all([
    db.epic.findFirst({
      where: { id: args.epicId, deletedAt: null },
      select: {
        id: true,
        title: true,
        projectId: true,
        project: { select: { slug: true } },
      },
    }),
    db.user.findFirst({
      where: {
        status: "active",
        kind: "agent",
        agent: { is: { slug: agentSlug, deactivatedAt: null } },
      },
      select: {
        id: true,
        username: true,
        agent: { select: { slug: true, gatewayPort: true } },
      },
    }),
    db.user.findMany({
      where: { kind: "agent", status: "active", agent: { is: { deactivatedAt: null } } },
      select: { agent: { select: { slug: true } } },
    }),
  ]);
  if (!epic) return { ok: false as const, error: "epic_not_found" };
  if (!agentUser?.agent) return { ok: false as const, error: "agent_not_active" };

  const body = args.body;
  const msg = await db.agentChatMessage.create({
    data: {
      projectId: epic.projectId,
      taskId: null,
      epicId: epic.id,
      agentSlug: "room",
      senderUserId: args.actor.id,
      body,
      targetType: "agent",
      targetValue: `agent:${agentSlug}`,
      targetLabel: agentUser.username,
      allowDescriptionEdit: false,
      allowWorkItemManagement: false,
      originChannel: "chat",
    },
    select: { id: true },
  });

  // The durable audit row hasAuthorizedEpicAgentOrigin validates against.
  await db.activityLog.create({
    data: {
      projectId: epic.projectId,
      userId: args.actor.id,
      kind: "epic.workflow.notify",
      targetAgent: agentSlug,
      payload: JSON.stringify({
        messageId: msg.id,
        epicId: epic.id,
        agentSlug,
        reason: args.reason,
      }),
    },
  });

  const activeAgentSlugs = new Set(
    activeAgents.flatMap((u) => (u.agent ? [u.agent.slug] : [])),
  );
  const directedDescriptor = resolveDirectedFromDiscussionRow({
    targetType: "agent",
    targetValue: `agent:${agentSlug}`,
    targetLabel: agentUser.username,
    activeAgentSlugs,
  });

  const [recentDisc, recentCmts] = await Promise.all([
    recentDiscussion({ epicId: epic.id }),
    recentComments({ epicId: epic.id }),
  ]);
  const inlineRecentBlock = formatRecentBlock({
    scope: "epic",
    discussion: recentDisc,
    comments: recentCmts,
    currentMessageId: msg.id,
  });

  const fetchBaseUrl = agentCallbackBaseUrl();
  const grantUrls = await createContextGrantUrlMap({
    baseUrl: fetchBaseUrl,
    agentSlug,
    projectId: epic.projectId,
    taskId: null,
    epicId: epic.id,
    turnId: msg.id,
  });

  const sessionBinding = await getOrCreateAgentSessionBinding({
    scopeType: "epic",
    scopeId: epic.id,
    agentSlug,
  });
  const previousDispatchedMessageId = sessionBinding.lastDispatchedMessageId;

  const promptOpts = {
    baseUrl: fetchBaseUrl,
    projectId: epic.projectId,
    inlineRecentBlock,
    epicId: epic.id,
    workflowMessageId: msg.id,
    grantUrls: {
      epic: grantUrls.epic!,
      project: grantUrls.project,
    },
  };
  const baseSystemPrompt = previousDispatchedMessageId
    ? buildEpicNativeIncrementalChannelPrompt(
        epic.title,
        agentSlug,
        previousDispatchedMessageId,
        directedDescriptor,
        promptOpts,
      )
    : buildEpicNativeChannelPrompt(epic.title, agentSlug, directedDescriptor, promptOpts);

  const systemPrompt = buildUnifiedPmTurnSystemPrompt({
    kind: "epic-chat",
    trustedPrompt: [baseSystemPrompt, DISCUSSION_REPLY_FORMAT_PROMPT].join("\n\n"),
    primaryBlocks: [{
      title: "CURRENT CHAT MESSAGE (untrustedContext)",
      body,
      trust: "untrusted",
    }],
  });

  const delivery = await sendOrQueueOpenClawPmChannelTurn({
    gatewayPort: agentUser.agent.gatewayPort,
    agentSlug,
    sessionKey: sessionBinding.openclawSessionKey,
    kind: "epic-chat",
    text: body,
    contextText: nullPmContextText(),
    systemPrompt,
    projectId: epic.projectId,
    actor: {
      id: args.actor.id,
      username: args.actor.username ?? undefined,
      kind: args.actor.kind,
    },
    replyTarget: {
      kind: "epic-chat",
      agentSlug,
      epicId: epic.id,
      messageId: msg.id,
      projectSlug: epic.project.slug,
    },
  });

  if (delivery.ok) {
    await db.agentSessionBinding.update({
      where: { id: sessionBinding.id },
      data: { lastDispatchedMessageId: msg.id, lastDispatchedAt: new Date() },
    });
  }

  await db.activityLog.create({
    data: {
      projectId: epic.projectId,
      userId: args.actor.id,
      kind: delivery.ok ? "epic.chat.dispatch" : "epic.chat.dispatch_failed",
      targetAgent: agentSlug,
      payload: JSON.stringify({
        messageId: msg.id,
        agentSlug,
        epicId: epic.id,
        driver: delivery.driver,
        status: delivery.status ?? null,
        error: delivery.error ?? null,
        reason: args.reason,
      }),
    },
  });

  return { ok: delivery.ok, messageId: msg.id, delivery };
}
