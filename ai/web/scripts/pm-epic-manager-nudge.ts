// Directed epic-chat nudge from the Mission Control owner to one agent,
// dispatched through the native PM channel so the turn carries a fresh Epic
// manager workflow grant (assign_next / advance_queue / create_tasks when the
// recipient is the Epic acting manager). Mirrors the epic branch of
// sendAgentChatMessage (lib/agents/chat/actions.ts).
//
// Usage:
//   tsx scripts/pm-epic-manager-nudge.ts --epic-id <id> --agent <slug> --message <text>
//
// Run as the PM app user with the production env loaded (/etc/default/pm +
// /etc/default/pm-active-worktree) so DB, AUTH_SECRET, and the PM channel
// token file resolve.
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

type Args = { epicId?: string; agent?: string; message?: string };

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--epic-id" && next) {
      out.epicId = next;
      i += 1;
    } else if (arg === "--agent" && next) {
      out.agent = next;
      i += 1;
    } else if (arg === "--message" && next) {
      out.message = next;
      i += 1;
    }
  }
  return out;
}

function agentCallbackBaseUrl() {
  return process.env.PM_AGENT_CALLBACK_URL
    ?? process.env.PM_INTERNAL_APP_URL
    ?? "http://127.0.0.1:3000";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.epicId || !args.agent || !args.message?.trim()) {
    throw new Error("Usage: pm-epic-manager-nudge --epic-id <id> --agent <slug> --message <text>");
  }
  const agentSlug = args.agent;
  const body = [
    `PM workflow notification for @${agentSlug}:`,
    "",
    args.message.trim(),
  ].join("\n");

  const [sender, epic, agentUser, activeAgents] = await Promise.all([
    db.user.findFirst({
      where: { kind: "human", status: "active", isOwner: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true },
    }),
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
  if (!sender) throw new Error("No active Mission Control owner found");
  if (!epic) throw new Error(`Epic not found: ${args.epicId}`);
  if (!agentUser?.agent) throw new Error(`Active agent not found: ${agentSlug}`);

  const msg = await db.agentChatMessage.create({
    data: {
      projectId: epic.projectId,
      taskId: null,
      epicId: epic.id,
      agentSlug: "room",
      senderUserId: sender.id,
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

  const activeAgentSlugs = new Set(activeAgents.map((u) => u.agent!.slug));
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
    actor: { id: sender.id, username: sender.username, kind: "human" },
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
      userId: sender.id,
      kind: delivery.ok ? "epic.chat.dispatch" : "epic.chat.dispatch_failed",
      targetAgent: agentSlug,
      payload: JSON.stringify({
        messageId: msg.id,
        agentSlug,
        epicId: epic.id,
        driver: delivery.driver,
        status: delivery.status ?? null,
        error: delivery.error ?? null,
        via: "pm-epic-manager-nudge",
      }),
    },
  });

  console.log(JSON.stringify({
    ok: delivery.ok,
    epicId: epic.id,
    agent: agentSlug,
    messageId: msg.id,
    incremental: Boolean(previousDispatchedMessageId),
    delivery: { status: delivery.status ?? null, driver: delivery.driver, error: delivery.error ?? null },
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
