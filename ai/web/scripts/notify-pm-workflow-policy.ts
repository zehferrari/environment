import { db } from "@/lib/db";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/auth/session-bindings";
import {
  buildPmTurnSessionKey,
  sendOpenClawPmChannelTurn,
} from "@/lib/agents/pm-channel/openclaw";
import { buildUnifiedPmTurnSystemPrompt, nullPmContextText } from "@/lib/agents/pm-channel/context";
import { PM_SILENT_REPLY_TOKEN } from "@/lib/agents/ops/pm-silence";

const POLICY_UPDATE_ID = "2026-06-01-action-plan-approval-feedback";

const body = [
  "PM workflow policy update:",
  "",
  "- Backlog assignments are for planning/opinions only. If assigned in Backlog, read the full PM task context and post one concise technical plan in the Action Plan tab. Do not change status and do not start work.",
  "- To Do is executable only after the Action Plan is approved. If approved_on is empty, post the technical Action Plan and wait for reviewer/reporter approval. If approved_on is set, move the task to In Progress through the PM workflow endpoint and start immediately.",
  "- Reviewers/reporters approve acceptable Action Plans through the PM workflow endpoint with action=approve_plan and include one concise comment explaining why the plan is acceptable or naming any constraints. If the plan needs adjustment, reply in Action Plan with consolidated feedback instead of approving.",
  "- Move completed implementation from In Progress to Review through the PM workflow endpoint with one concise ready-for-review note.",
  "- Review is for completed-work review. The resolved reviewer is task acting manager, then In Progress Epic acting manager, then task reporter. If satisfied, call action=review_done without posting an approval-only comment; PM will move the task to Done, assign the next To Do task in the Epic when one exists, and wake the assignee. If changes/blockers remain, call action=review_feedback with concise feedback.",
  "- Golden rule: if there is no new information, action result, plan, feedback, blocker, or necessary question, stay silent.",
  "- Tasks under an Epic are actionable only when that Epic is In Progress.",
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
    const kind = "direct" as const;
    const delivery = await sendOpenClawPmChannelTurn({
      gatewayPort: agent.gatewayPort,
      agentSlug: agent.slug,
      sessionKey: buildPmTurnSessionKey(sessionBinding.openclawSessionKey, msg.id),
      kind,
      text: body,
      contextText: nullPmContextText(),
      systemPrompt: buildUnifiedPmTurnSystemPrompt({
        kind,
        trustedPrompt: [
          `You have a directed PM policy update addressed to @${agent.slug}.`,
          "Read it carefully and apply it to future Zero Latency / PM tasks.",
          `If you have no concrete blocker applying the policy, reply exactly ${PM_SILENT_REPLY_TOKEN} and nothing else.`,
          "Create a visible reply only for a concrete blocker.",
        ].join("\n"),
        primaryContext: body,
      }),
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
