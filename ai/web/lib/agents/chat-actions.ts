"use server";

// Agent-chat server actions (HOMELAB-48).
//
// sendAgentChatMessage persists a message in the per-(target, agent)
// thread. Task-scoped chats additionally fire a typed PmEvent so the
// agent's gateway can wake on receipt; epic-scoped chats persist only,
// because the current PmEvent schema (v1) is task-scoped — extending
// it to epics is deliberately out of scope until the consumer side is
// ready.
//
// The `allowDescriptionEdit` boolean per message is the grant token
// the agent later uses against POST /api/{tasks,epics}/[id]/description
// to write back. One-shot: editGrantUsedAt is stamped on first use.

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { notifyDispatch } from "@/lib/pm-dispatch";
import { buildTaskCommented, type EventTaskRef } from "@/lib/pm-events";

async function requireActor(): Promise<{ id: string; kind: "human" | "agent" }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, kind };
}

export async function sendAgentChatMessage(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const taskIdRaw = String(formData.get("taskId") ?? "");
  const epicIdRaw = String(formData.get("epicId") ?? "");
  const taskId = taskIdRaw === "" ? null : taskIdRaw;
  const epicId = epicIdRaw === "" ? null : epicIdRaw;
  const agentSlug = String(formData.get("agentSlug") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const allowDescriptionEdit = formData.get("allowDescriptionEdit") === "on";

  if (!slug || !agentSlug || !body) return;
  if ((taskId === null) === (epicId === null)) {
    throw new Error("Chat target must be exactly one of taskId or epicId");
  }
  if (body.length > 8000) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!project) return;

  // Verify the agent slug resolves to an active agent on this host.
  const agent = await db.agent.findUnique({
    where: { slug: agentSlug },
    select: { id: true, slug: true, deactivatedAt: true, gatewayPort: true },
  });
  if (!agent || agent.deactivatedAt) {
    throw new Error("Unknown or deactivated agent");
  }

  // Scope-check the target.
  let task: {
    id: string;
    title: string;
    projectId: string;
  } | null = null;
  if (taskId) {
    const t = await db.task.findUnique({
      where: { id: taskId },
      select: { id: true, title: true, projectId: true, deletedAt: true },
    });
    if (!t || t.projectId !== project.id || t.deletedAt) return;
    task = { id: t.id, title: t.title, projectId: t.projectId };
  } else if (epicId) {
    const e = await db.epic.findUnique({
      where: { id: epicId },
      select: { id: true, projectId: true, deletedAt: true },
    });
    if (!e || e.projectId !== project.id || e.deletedAt) return;
  }

  const msg = await db.agentChatMessage.create({
    data: {
      projectId: project.id,
      taskId,
      epicId,
      agentSlug,
      senderUserId: actor.id,
      body,
      allowDescriptionEdit,
    },
    select: { id: true },
  });

  await db.activityLog.create({
    data: {
      projectId: project.id,
      taskId,
      userId: actor.id,
      kind: taskId ? "task.chat.send" : "epic.chat.send",
      payload: JSON.stringify({
        messageId: msg.id,
        agentSlug,
        allowDescriptionEdit,
      }),
    },
  });

  // Task chats fire a dispatch event so the agent gateway can wake. We
  // reuse task.commented for the envelope shape — the consumer treats
  // it as a task event for the addressed agent. A dedicated kind would
  // be cleaner; leaving that to a follow-up so we don't expand the
  // PmEvent schema in this slice.
  if (task) {
    const actorRef = { id: actor.id, kind: actor.kind };
    const taskRef: EventTaskRef = {
      id: task.id,
      key: task.id,
      projectKey: slug,
      title: task.title,
    };
    await notifyDispatch(
      buildTaskCommented(
        {
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          actor: actorRef,
          task: taskRef,
        },
        {
          commentId: msg.id,
          bodyMarkdown: `[chat → @${agentSlug}] ${body}`,
          mentions: [],
        },
      ),
    );
  }

  if (taskId) revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  if (epicId) revalidatePath(`/projects/${slug}/epics/${epicId}`);
}
