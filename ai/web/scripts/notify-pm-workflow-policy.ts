import { db } from "@/lib/db";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/session-bindings";
import {
  buildPmTurnSessionKey,
  sendOpenClawPmChannelTurn,
} from "@/lib/agents/openclaw-pm-channel";
import { PM_SILENT_REPLY_TOKEN } from "@/lib/agents/pm-silence";

const POLICY_UPDATE_ID = "2026-05-28-pm-silent-contribution";

const body = [
  "PM workflow policy update:",
  "",
  "- Backlog assignments are for planning/opinions only. If assigned in Backlog, read the full PM task context and post a concise task comment with your implementation plan or perspective. Do not change status and do not start work.",
  "- Reassignment while a task remains in Backlog is allowed to request another agent perspective; the new assignee posts their own plan/opinion.",
  "- To Do means the plan/request is approved for execution. If assigned in To Do, move the task to In Progress through the PM workflow endpoint and start immediately. Do not post an acknowledgement unless you have new task information to add.",
  "- Move completed implementation from In Progress to Review through the PM workflow endpoint.",
  "- Review is for completed-work review. The resolved reviewer is task reviewer, then Open Epic acting manager, then task reporter. The reviewer moves satisfied work to Done without approval-only comments, or leaves concise feedback/blockers while keeping the task in Review.",
  "- Golden rule: if there is no new information, action result, plan, feedback, blocker, or necessary question, stay silent.",
  "- Tasks under an Epic are actionable only when that Epic is Open.",
  "",
  "These PM rules are separate from Jira rules.",
].join("\n");

async function main() {
  const sender = await db.user.findFirst({
    where: { username: "zeh", status: "active" },
    select: { id: true, username: true, kind: true },
  }) ?? await db.user.findFirst({
    where: { kind: "human", status: "active" },
    select: { id: true, username: true, kind: true },
    orderBy: { createdAt: "asc" },
  });
  if (!sender) throw new Error("No active human sender found for policy broadcast");

  const agents = await db.agent.findMany({
    where: {
      deactivatedAt: null,
      user: { is: { status: "active" } },
    },
    select: {
      slug: true,
      gatewayPort: true,
      user: { select: { id: true } },
    },
    orderBy: { slug: "asc" },
  });

  const results = [];
  for (const agent of agents) {
    const successfulDelivery = await db.activityLog.findFirst({
      where: {
        kind: "agent.direct_chat.wake",
        targetAgent: agent.slug,
        payload: { contains: POLICY_UPDATE_ID },
      },
      select: { id: true },
    });
    if (successfulDelivery) {
      results.push({ agent: agent.slug, skipped: "already-delivered" });
      continue;
    }

    const existingSend = await db.activityLog.findFirst({
      where: {
        kind: "agent.direct_chat.send",
        targetAgent: agent.slug,
        payload: { contains: POLICY_UPDATE_ID },
      },
      orderBy: { createdAt: "desc" },
      select: { payload: true },
    });
    let existingMessageId: string | null = null;
    if (existingSend?.payload) {
      try {
        const parsed = JSON.parse(existingSend.payload) as { messageId?: unknown };
        if (typeof parsed.messageId === "string") existingMessageId = parsed.messageId;
      } catch {
        existingMessageId = null;
      }
    }

    const msg = existingMessageId
      ? { id: existingMessageId }
      : await db.$transaction(async (tx) => {
        const created = await tx.directAgentChatMessage.create({
          data: {
            agentSlug: agent.slug,
            senderUserId: sender.id,
            body,
            allowWorkItemManagement: false,
          },
          select: { id: true },
        });
        await tx.activityLog.create({
          data: {
            userId: sender.id,
            kind: "agent.direct_chat.send",
            targetAgent: agent.slug,
            payload: JSON.stringify({
              policyUpdateId: POLICY_UPDATE_ID,
              agentSlug: agent.slug,
              messageId: created.id,
            }),
          },
        });
        return created;
      });

    const sessionBinding = await getOrCreateAgentSessionBinding({
      scopeType: "direct",
      scopeId: msg.id,
      agentSlug: agent.slug,
    });
    const delivery = await sendOpenClawPmChannelTurn({
      gatewayPort: agent.gatewayPort,
      agentSlug: agent.slug,
      sessionKey: buildPmTurnSessionKey(sessionBinding.openclawSessionKey, msg.id),
      kind: "direct",
      text: body,
      contextText: body,
      systemPrompt: [
        `You have a directed PM policy update addressed to @${agent.slug}.`,
        "Read it carefully and apply it to future Zero Latency / PM tasks.",
        `If you have no concrete blocker applying the policy, reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else.`,
        "Create a visible reply only for a concrete blocker.",
      ].join("\n"),
      actor: {
        id: sender.id,
        username: sender.username,
        kind: sender.kind === "agent" ? "agent" : "human",
      },
      replyTarget: {
        kind: "direct",
        agentSlug: agent.slug,
        messageId: msg.id,
      },
    });
    await db.activityLog.create({
      data: {
        userId: sender.id,
        kind: delivery.ok ? "agent.direct_chat.wake" : "agent.direct_chat.wake_failed",
        targetAgent: agent.slug,
        payload: JSON.stringify({
          policyUpdateId: POLICY_UPDATE_ID,
          messageId: msg.id,
          driver: delivery.driver,
          status: delivery.status ?? null,
          error: delivery.error ?? null,
        }),
      },
    });
    results.push({
      agent: agent.slug,
      messageId: msg.id,
      delivered: delivery.ok,
      error: delivery.error ?? null,
    });
  }

  console.log(JSON.stringify({ policyUpdateId: POLICY_UPDATE_ID, results }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
