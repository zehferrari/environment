// Agent description write-back for Epics (HOMELAB-48).
//
// Mirror of /api/tasks/[id]/description. The caller presents a signed
// one-shot token bound to the addressed chat message, target epic, and
// target agent. The activity row uses kind="epic.description.agent_write".

import { NextResponse, type NextRequest } from "next/server";
import { verifyEpicDescriptionWriteToken } from "@/lib/agents/epic-chat-token";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id: epicId } = await ctx.params;

  let payload: { messageId?: unknown; token?: unknown; description?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const messageId =
    typeof payload.messageId === "string" ? payload.messageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const description =
    typeof payload.description === "string" ? payload.description : null;
  if (!messageId || !token || description === null) {
    return NextResponse.json(
      { error: "messageId, token, and description (string) are required" },
      { status: 400 },
    );
  }

  const grant = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    select: {
      epicId: true,
      agentSlug: true,
      allowDescriptionEdit: true,
      editGrantUsedAt: true,
    },
  });
  if (!grant) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (grant.epicId !== epicId) {
    return NextResponse.json(
      { error: "Message does not reference this epic" },
      { status: 400 },
    );
  }
  if (!grant.allowDescriptionEdit) {
    return NextResponse.json(
      { error: "Message did not grant description edit" },
      { status: 403 },
    );
  }
  if (grant.editGrantUsedAt) {
    return NextResponse.json(
      { error: "Grant already used" },
      { status: 410 },
    );
  }

  const activeAgents = await db.agent.findMany({
    where: { deactivatedAt: null, user: { is: { status: "active" } } },
    select: {
      slug: true,
      user: { select: { id: true } },
    },
  });

  let resolvedAgent: (typeof activeAgents)[number] | null = null;
  if (grant.agentSlug === "room") {
    for (const agent of activeAgents) {
      if (verifyEpicDescriptionWriteToken(messageId, epicId, agent.slug, token)) {
        resolvedAgent = agent;
        break;
      }
    }
  } else {
    const matchingAgent = activeAgents.find((a) => a.slug === grant.agentSlug);
    if (
      matchingAgent &&
      verifyEpicDescriptionWriteToken(messageId, epicId, grant.agentSlug, token)
    ) {
      resolvedAgent = matchingAgent;
    }
  }

  if (!resolvedAgent?.user) {
    return NextResponse.json(
      { error: "Invalid description token or agent not active" },
      { status: 403 },
    );
  }

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: { id: true, projectId: true, deletedAt: true },
  });
  if (!epic || epic.deletedAt) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }

  const newDescription = description.trim();

  const { saveDescriptionDraft } = await import("@/lib/description-drafts");
  saveDescriptionDraft(epicId, "epic", newDescription);

  await db.$transaction([
    db.agentChatMessage.update({
      where: { id: messageId },
      data: { editGrantUsedAt: new Date() },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: resolvedAgent.user.id,
        kind: "epic.description.agent_write",
        payload: JSON.stringify({
          messageId,
          epicId,
          agentSlug: resolvedAgent.slug,
          length: newDescription.length,
          draft: true,
        }),
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
