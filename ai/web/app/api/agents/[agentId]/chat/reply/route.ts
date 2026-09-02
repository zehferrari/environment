import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyDirectChatReplyToken } from "@/lib/agents/chat/direct/token";
import { hasActiveOwnerOrigin } from "@/lib/agents/owner-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ agentId: string }> },
) {
  const { agentId } = await ctx.params;
  let payload: { messageId?: unknown; token?: unknown; body?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!messageId || !token || !body || body.length > 8000) {
    return NextResponse.json(
      { error: "messageId, token, and non-empty body <= 8000 chars are required" },
      { status: 400 },
    );
  }

  if (!verifyDirectChatReplyToken(messageId, agentId, token)) {
    return NextResponse.json({ error: "Invalid reply token" }, { status: 403 });
  }

  const [original, agent] = await Promise.all([
    db.directAgentChatMessage.findUnique({
      where: { id: messageId },
      select: { id: true, agentSlug: true, senderUserId: true, archiveId: true, baseArchiveId: true, billingRunId: true },
    }),
    db.agent.findUnique({
      where: { slug: agentId },
      select: {
        slug: true,
        deactivatedAt: true,
        user: { select: { id: true, status: true } },
      },
    }),
  ]);

  if (!original || original.agentSlug !== agentId) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  if (!(await hasActiveOwnerOrigin(original.senderUserId))) {
    return NextResponse.json({ error: "Reply grant is no longer authorized" }, { status: 403 });
  }

  const reply = await db.$transaction(async (tx) => {
    const created = await tx.directAgentChatMessage.create({
      data: {
        agentSlug: agentId,
        senderUserId: agent.user!.id,
        archiveId: original.archiveId,
        baseArchiveId: original.baseArchiveId,
        billingRunId: original.billingRunId,
        body,
      },
      select: { id: true, archiveId: true, createdAt: true },
    });
    if (created.archiveId) {
      await tx.directAgentChatArchive.update({
        where: { id: created.archiveId },
        data: {
          endedAt: created.createdAt,
          messageCount: { increment: 1 },
        },
      });
    }
    await tx.activityLog.create({
      data: {
        userId: agent.user!.id,
        kind: "agent.direct_chat.reply",
        targetAgent: agentId,
        payload: JSON.stringify({
          agentSlug: agentId,
          messageId: created.id,
          inReplyToMessageId: messageId,
        }),
      },
    });
    if (original.billingRunId) {
      await tx.billingRun.update({
        where: { id: original.billingRunId },
        data: { response: body.slice(0, 40000) },
      });
    }
    return created;
  });

  if (!original.billingRunId) revalidatePath(`/agents/${agentId}/chat`);
  return NextResponse.json({ ok: true, messageId: reply.id });
}
