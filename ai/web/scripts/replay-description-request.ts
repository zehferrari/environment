// Bounded operator recovery for a description request that was persisted but
// failed before any durable PM-channel run existed.

import { db } from "@/lib/db";
import { createContextGrantUrlMap } from "@/lib/agents/context/grants";
import { resolveDirectedFromDiscussionRow } from "@/lib/agents/ops/directed-targets";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/auth/session-bindings";
import {
  buildEpicNativeChannelPrompt,
  buildEpicNativeEditGrantPrompt,
} from "@/lib/agents/workflow/chat/epic/context";
import { createEpicDescriptionWriteToken } from "@/lib/agents/workflow/chat/epic/token";
import { DISCUSSION_REPLY_FORMAT_PROMPT } from "@/lib/agents/chat/discussion-reply-format";
import {
  buildUnifiedPmTurnSystemPrompt,
  nullPmContextText,
} from "@/lib/agents/pm-channel/context";
import { sendOrQueueOpenClawPmChannelTurn } from "@/lib/agents/pm-channel/jobs";

function option(name: string) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function callbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

async function main() {
  process.env.PM_ASYNC_DISPATCH_INLINE_NUDGE = "0";
  const messageId = option("message-id");
  if (!messageId) throw new Error("Usage: replay-description-request --message-id=<id>");

  const message = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    include: {
      sender: { select: { id: true, username: true, kind: true, status: true, isOwner: true } },
      epic: {
        select: {
          id: true,
          title: true,
          projectId: true,
          deletedAt: true,
          private: true,
          project: { select: { slug: true } },
        },
      },
    },
  });
  if (!message?.epic || message.epic.deletedAt || message.epic.private) {
    throw new Error("Replay requires a live public Epic message");
  }
  if (
    message.originChannel !== "description"
    || !message.allowDescriptionEdit
    || message.sender.kind !== "human"
    || message.sender.status !== "active"
    || !message.sender.isOwner
  ) {
    throw new Error("Message is not an owner-authorized description request");
  }
  if (message.targetType !== "agent" || !message.targetValue?.startsWith("agent:")) {
    throw new Error("Replay requires one explicitly directed agent");
  }
  const existingRun = await db.pmChannelRun.findFirst({
    where: { messageId },
    select: { id: true, status: true },
  });
  if (existingRun) throw new Error(`Message already has PM run ${existingRun.id} (${existingRun.status})`);

  const agentSlug = message.targetValue.slice("agent:".length);
  const agent = await db.agent.findFirst({
    where: { slug: agentSlug, deactivatedAt: null, user: { is: { status: "active" } } },
    select: { slug: true, gatewayPort: true },
  });
  if (!agent) throw new Error(`Target agent is not active: ${agentSlug}`);

  const activeAgentSlugs = new Set((await db.agent.findMany({
    where: { deactivatedAt: null, user: { is: { status: "active" } } },
    select: { slug: true },
  })).map((row) => row.slug));
  const directedDescriptor = resolveDirectedFromDiscussionRow({
    targetType: message.targetType,
    targetValue: message.targetValue,
    targetLabel: message.targetLabel,
    activeAgentSlugs,
  });
  const baseUrl = callbackBaseUrl();
  const grantUrls = await createContextGrantUrlMap({
    baseUrl,
    agentSlug,
    projectId: message.epic.projectId,
    taskId: null,
    epicId: message.epic.id,
    turnId: message.id,
  });
  const sessionBinding = await getOrCreateAgentSessionBinding({
    scopeType: "epic",
    scopeId: message.epic.id,
    agentSlug,
  });
  const basePrompt = buildEpicNativeChannelPrompt(
    message.epic.title,
    agentSlug,
    directedDescriptor,
    {
      baseUrl,
      projectId: message.epic.projectId,
      inlineRecentBlock: undefined,
      epicId: message.epic.id,
      workflowMessageId: message.id,
      grantUrls: { epic: grantUrls.epic!, project: grantUrls.project },
    },
  );
  const descriptionPrompt = buildEpicNativeEditGrantPrompt({
    epicTitle: message.epic.title,
    descriptionUrl: new URL(`/api/epics/${message.epic.id}/description`, baseUrl).toString(),
    messageId: message.id,
    token: createEpicDescriptionWriteToken(message.id, message.epic.id, agentSlug),
  });
  const systemPrompt = buildUnifiedPmTurnSystemPrompt({
    kind: "epic-chat",
    trustedPrompt: [basePrompt, DISCUSSION_REPLY_FORMAT_PROMPT, descriptionPrompt].join("\n\n"),
    primaryBlocks: [{
      title: "CURRENT CHAT MESSAGE (untrustedContext)",
      body: message.body,
      trust: "untrusted",
    }],
  });

  await db.agentChatMessage.update({
    where: { id: message.id },
    data: { editGrantUsedAt: null },
  });
  const delivery = await sendOrQueueOpenClawPmChannelTurn({
    gatewayPort: agent.gatewayPort,
    agentSlug,
    sessionKey: sessionBinding.openclawSessionKey,
    kind: "epic-chat",
    text: message.body,
    contextText: nullPmContextText(),
    systemPrompt,
    projectId: message.epic.projectId,
    actor: {
      id: message.sender.id,
      username: message.sender.username,
      kind: "human",
    },
    replyTarget: {
      kind: "epic-chat",
      agentSlug,
      epicId: message.epic.id,
      messageId: message.id,
      projectSlug: message.epic.project.slug,
    },
  });
  if (!delivery.ok) {
    await db.agentChatMessage.update({
      where: { id: message.id },
      data: { editGrantUsedAt: new Date() },
    });
    throw new Error(delivery.error || "Replay dispatch failed");
  }
  await db.activityLog.create({
    data: {
      projectId: message.epic.projectId,
      userId: message.sender.id,
      kind: "epic.description.replayed",
      targetAgent: agentSlug,
      payload: JSON.stringify({ messageId: message.id, epicId: message.epic.id, driver: delivery.driver }),
    },
  });
  console.log(JSON.stringify({ ok: true, messageId: message.id, epicId: message.epic.id, agentSlug, delivery }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
