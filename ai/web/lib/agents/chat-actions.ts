"use server";

// Agent-chat server actions (HOMELAB-48).
//
// sendAgentChatMessage persists a message in the per-(target, agent)
// thread. Task-scoped chats are delivered through the native OpenClaw
// PM channel, so OpenClaw owns session recording and visible reply
// delivery. Epic-scoped chats still persist only until the channel
// contract grows an Epic scope.
//
// The `allowDescriptionEdit` boolean per message is the grant token
// the agent later uses against POST /api/{tasks,epics}/[id]/description
// to write back. One-shot: editGrantUsedAt is stamped on first use.

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  buildTaskAgentUserMessage,
  buildTaskNativeChannelPrompt,
  buildTaskNativeEditGrantPrompt,
} from "@/lib/agents/task-chat-context";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/session-bindings";
import { sendOpenClawPmChannelTurn } from "@/lib/agents/openclaw-pm-channel";

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

  // Scope-check the target. We also load the current description so it
  // can be embedded in the dispatch payload as context for the agent.
  let task: {
    id: string;
    title: string;
    projectId: string;
    description: string | null;
  } | null = null;
  if (taskId) {
    const t = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        description: true,
        deletedAt: true,
      },
    });
    if (!t || t.projectId !== project.id || t.deletedAt) return;
    task = {
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      description: t.description,
    };
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

  // Task chats enter OpenClaw as native PM-channel turns. OpenClaw
  // records the session and owns final reply delivery back into PM.
  // Epic chats persist only for now.
  if (task) {
    const actorUser = await db.user.findUnique({
      where: { id: actor.id },
      select: { username: true },
    });
    const systemPrompt = allowDescriptionEdit
      ? buildTaskNativeEditGrantPrompt(task.title)
      : buildTaskNativeChannelPrompt(task.title, agentSlug);
    const userMessage = await buildTaskAgentUserMessage({
      taskId: task.id,
      agentSlug,
      currentTurn: {
        id: msg.id,
        source: "task chat",
        actorUsername: actorUser?.username,
        actorKind: actor.kind,
        body,
      },
    });
    const sessionBinding = await getOrCreateAgentSessionBinding({
      scopeType: "task",
      scopeId: task.id,
      agentSlug,
    });
    const delivery = await sendOpenClawPmChannelTurn({
      gatewayPort: agent.gatewayPort,
      agentSlug,
      sessionKey: sessionBinding.openclawSessionKey,
      kind: "task-chat",
      text: body,
      contextText: userMessage,
      systemPrompt,
      actor: {
        id: actor.id,
        username: actorUser?.username,
        kind: actor.kind,
      },
      replyTarget: {
        kind: "task-chat",
        agentSlug,
        taskId: task.id,
        messageId: msg.id,
        projectSlug: slug,
      },
    });
    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId,
        userId: actor.id,
        kind: delivery.ok ? "task.chat.dispatch" : "task.chat.dispatch_failed",
        targetAgent: agentSlug,
        payload: JSON.stringify({
          messageId: msg.id,
          agentSlug,
          driver: delivery.driver,
          status: delivery.status ?? null,
          error: delivery.error ?? null,
        }),
      },
    });
  }

  if (taskId) revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  if (epicId) revalidatePath(`/projects/${slug}/epics/${epicId}`);
}

// Hard-delete a chat message. Chats are conversation, not work
// items — they don't go through the soft-delete bin. The activity
// log keeps a record of who deleted what; the row itself is gone.
// Scope is project-slug enforced so a stale messageId from another
// project can't be deleted via this action.
export async function deleteChatMessage(formData: FormData) {
  const actor = await requireActor();
  const slug = String(formData.get("projectSlug") ?? "");
  const messageId = String(formData.get("messageId") ?? "");
  if (!slug || !messageId) return;

  const msg = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    include: { project: { select: { slug: true } } },
  });
  if (!msg || msg.project.slug !== slug) return;

  await db.$transaction([
    db.agentChatMessage.delete({ where: { id: messageId } }),
    db.activityLog.create({
      data: {
        projectId: msg.projectId,
        taskId: msg.taskId,
        userId: actor.id,
        kind: msg.taskId ? "task.chat.delete" : "epic.chat.delete",
        payload: JSON.stringify({
          messageId,
          agentSlug: msg.agentSlug,
          allowDescriptionEdit: msg.allowDescriptionEdit,
        }),
      },
    }),
  ]);

  if (msg.taskId) revalidatePath(`/projects/${slug}/tasks/${msg.taskId}`);
  if (msg.epicId) revalidatePath(`/projects/${slug}/epics/${msg.epicId}`);
}
