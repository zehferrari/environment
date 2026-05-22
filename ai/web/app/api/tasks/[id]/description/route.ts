// Agent description write-back for Tasks (HOMELAB-48).
//
// One-shot endpoint consumed by an agent that received a chat message
// with allowDescriptionEdit=true. Auth model:
//
//   - Caller must be authenticated as an agent (session.user.kind=='agent').
//   - The provided messageId must reference an AgentChatMessage where:
//     * agentSlug == session.user.agent.slug
//     * taskId == route :id
//     * allowDescriptionEdit == true
//     * editGrantUsedAt == null  (not yet used)
//
// On success: update Task.description, stamp the grant as used, write
// ActivityLog. Re-using the same messageId returns 410.

import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  if (session.user.kind !== "agent") {
    return NextResponse.json(
      { error: "Only agents may write descriptions via this endpoint" },
      { status: 403 },
    );
  }

  const agentRow = await db.agent.findFirst({
    where: { user: { is: { id: session.user.id } } },
    select: { slug: true },
  });
  if (!agentRow) {
    return NextResponse.json({ error: "Agent not found" }, { status: 403 });
  }

  const { id: taskId } = await ctx.params;

  let payload: { messageId?: unknown; description?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const messageId =
    typeof payload.messageId === "string" ? payload.messageId : "";
  const description =
    typeof payload.description === "string" ? payload.description : null;
  if (!messageId || description === null) {
    return NextResponse.json(
      { error: "messageId and description (string) are required" },
      { status: 400 },
    );
  }

  const grant = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    select: {
      taskId: true,
      agentSlug: true,
      allowDescriptionEdit: true,
      editGrantUsedAt: true,
    },
  });
  if (!grant) {
    return NextResponse.json({ error: "Message not found" }, { status: 404 });
  }
  if (grant.taskId !== taskId) {
    return NextResponse.json(
      { error: "Message does not reference this task" },
      { status: 400 },
    );
  }
  if (grant.agentSlug !== agentRow.slug) {
    return NextResponse.json(
      { error: "Message was not addressed to this agent" },
      { status: 403 },
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

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, deletedAt: true },
  });
  if (!task || task.deletedAt) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const newDescription = description.trim() === "" ? null : description;

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { description: newDescription },
    }),
    db.agentChatMessage.update({
      where: { id: messageId },
      data: { editGrantUsedAt: new Date() },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: session.user.id,
        kind: "task.description.agent_write",
        payload: JSON.stringify({
          messageId,
          agentSlug: agentRow.slug,
          length: newDescription?.length ?? 0,
        }),
      },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
