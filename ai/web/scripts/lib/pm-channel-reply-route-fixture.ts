// Shared fixture for route-boundary tests of POST /api/openclaw/pm-channel/reply.
// Importing this module first installs the AsyncLocalStorage polyfill (via
// next-route-harness) before any Next internal is evaluated, so the route
// handler and `NextRequest` can be imported and invoked from a plain script.
import { runRouteHandler } from "./next-route-harness";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { pmChannelRunTargetKey } from "@/lib/agents/pm-channel/runs";
import { POST as pmChannelReplyPost } from "@/app/api/openclaw/pm-channel/reply/route";

export type CallResult = { status: number; json: unknown };

export async function callPmChannelReply(args: {
  target: unknown;
  body: string;
  bearer: string | null;
}): Promise<CallResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.bearer != null) headers.authorization = `Bearer ${args.bearer}`;
  const req = new NextRequest("http://127.0.0.1/api/openclaw/pm-channel/reply", {
    method: "POST",
    headers,
    body: JSON.stringify({ target: args.target, text: args.body }),
  });
  const res = await runRouteHandler(() => pmChannelReplyPost(req));
  return { status: res.status, json: await res.json() };
}

async function markDirectTurnAccepted(slug: string, messageId: string) {
  const target = { kind: "direct" as const, agentSlug: slug, messageId };
  await db.pmChannelRun.create({
    data: {
      targetKey: pmChannelRunTargetKey(target),
      kind: "direct",
      agentSlug: slug,
      messageId,
      status: "accepted",
      admittedAt: new Date(),
      acceptedAt: new Date(), // ENV-159: legacy compatibility
      lastEventAt: new Date(),
    },
  });
}

// Seed an active agent + its agent-user, an active Mission Control owner as
// the original sender, and a corresponding accepted PM-channel turn.
export async function seedDirectAgentMessage(slug: string, body = "original message") {
  const agent = await db.agent.create({
    data: { slug, name: `Route Test ${slug}`, role: "coding" },
  });
  const agentUser = await db.user.create({
    data: {
      username: slug,
      email: `${slug}@route-test.local`,
      kind: "agent",
      agentId: agent.id,
      status: "active",
    },
  });
  const owner = await db.user.create({
    data: {
      username: `${slug}-owner`,
      email: `${slug}-owner@route-test.local`,
      kind: "human",
      status: "active",
      isOwner: true,
      mustRotatePassword: false,
    },
  });
  const message = await db.directAgentChatMessage.create({
    data: { agentSlug: slug, senderUserId: owner.id, body },
    select: { id: true },
  });
  await markDirectTurnAccepted(slug, message.id);
  return { agentId: agent.id, agentUserId: agentUser.id, ownerUserId: owner.id, messageId: message.id };
}

export async function addDirectMessage(slug: string, senderUserId: string, body = "another") {
  const message = await db.directAgentChatMessage.create({
    data: { agentSlug: slug, senderUserId, body },
    select: { id: true },
  });
  await markDirectTurnAccepted(slug, message.id);
  return message.id;
}

// Remove every row the route may have created for this agent slug, in FK order.
// PmChannelRun deletion cascades its jobs and stream events.
export async function cleanupDirectAgent(slug: string) {
  await db.pmChannelRun.deleteMany({ where: { agentSlug: slug } });
  await db.activityLog.deleteMany({ where: { targetAgent: slug } });
  await db.directAgentChatMessage.deleteMany({ where: { agentSlug: slug } });
  await db.user.deleteMany({ where: { agent: { slug } } });
  await db.agent.deleteMany({ where: { slug } });
  await db.user.deleteMany({ where: { username: `${slug}-owner` } });
}
