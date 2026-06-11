// Resolves the human who should be pushed when an agent posts a reply, and
// fans the reply out to their devices via Web Push. The recipient is the
// human author of the message being replied to (inReplyToMessageId); we never
// push for agent-authored origin messages (agent-to-agent turns).

import { db } from "@/lib/db";
import type { PmChannelReplyTarget } from "@/lib/agents/openclaw-pm-channel";
import { sendWebPushToUser, webPushConfigured, type WebPushPayload } from "@/lib/push/web-push";

function snippet(body: string, max = 140): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>#\[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

async function agentDisplayName(agentSlug: string): Promise<string> {
  const agent = await db.agent.findUnique({ where: { slug: agentSlug }, select: { name: true } });
  return agent?.name ? agent.name : `@${agentSlug}`;
}

interface Recipient {
  userId: string;
  url: string;
}

async function resolveRecipient(target: PmChannelReplyTarget): Promise<Recipient | null> {
  if (target.kind === "direct") {
    const original = await db.directAgentChatMessage.findUnique({
      where: { id: target.messageId },
      select: { senderUserId: true, sender: { select: { kind: true } } },
    });
    if (!original || original.sender.kind === "agent") return null;
    return { userId: original.senderUserId, url: `/agents/${target.agentSlug}/chat` };
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: target.messageId },
    select: {
      senderUserId: true,
      taskId: true,
      epicId: true,
      sender: { select: { kind: true } },
      project: { select: { slug: true } },
    },
  });
  if (!original || original.sender.kind === "agent" || !original.project?.slug) return null;

  if (target.kind === "epic-chat" && original.epicId) {
    return { userId: original.senderUserId, url: `/projects/${original.project.slug}/epics/${original.epicId}` };
  }
  if ((target.kind === "task-chat" || target.kind === "task-comment") && original.taskId) {
    return { userId: original.senderUserId, url: `/projects/${original.project.slug}/tasks/${original.taskId}` };
  }
  return null;
}

// Best-effort: never throws, no-op when Web Push is not configured.
export async function notifyHumanOfAgentReply(target: PmChannelReplyTarget, replyText: string): Promise<void> {
  try {
    if (!webPushConfigured()) return;
    const recipient = await resolveRecipient(target);
    if (!recipient) return;

    const title = await agentDisplayName(target.agentSlug);
    const payload: WebPushPayload = {
      title,
      body: snippet(replyText) || "New reply",
      url: recipient.url,
      tag: `pm-reply:${target.kind}:${target.messageId}`,
    };
    await sendWebPushToUser(recipient.userId, payload);
  } catch (err) {
    console.warn("[web-push] notifyHumanOfAgentReply failed", err);
  }
}
