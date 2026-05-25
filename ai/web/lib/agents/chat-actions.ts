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
import {
  buildEpicAgentUserMessage,
  buildEpicNativeChannelPrompt,
  buildEpicNativeEditGrantPrompt,
} from "@/lib/agents/epic-chat-context";
import { extractMentions } from "@/lib/markdown";
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
  const body = String(formData.get("body") ?? "").trim();
  const allowDescriptionEdit = formData.get("allowDescriptionEdit") === "on";

  if (!slug || !body) return;
  if ((taskId === null) === (epicId === null)) {
    throw new Error("Chat target must be exactly one of taskId or epicId");
  }
  if (body.length > 8000) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!project) return;

  const users = await db.user.findMany({
    select: {
      id: true,
      username: true,
      kind: true,
      status: true,
      agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
    },
  });

  const mentions = extractMentions(
    body,
    users.map((u) => ({ username: u.username })),
  );

  let task: any = null;
  let epic: any = null;

  if (taskId) {
    task = await db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        projectId: true,
        description: true,
        deletedAt: true,
        assignee: {
          select: {
            id: true,
            username: true,
            kind: true,
            status: true,
            agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
          },
        },
        actingManager: {
          select: {
            id: true,
            username: true,
            kind: true,
            status: true,
            agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
          },
        },
        epic: {
          select: {
            id: true,
            title: true,
            actingManager: {
              select: {
                id: true,
                username: true,
                kind: true,
                status: true,
                agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
              },
            },
          },
        },
      },
    });
    if (!task || task.projectId !== project.id || task.deletedAt) return;
  } else if (epicId) {
    epic = await db.epic.findUnique({
      where: { id: epicId },
      select: {
        id: true,
        title: true,
        projectId: true,
        description: true,
        deletedAt: true,
        actingManager: {
          select: {
            id: true,
            username: true,
            kind: true,
            status: true,
            agent: { select: { slug: true, deactivatedAt: true, gatewayPort: true } },
          },
        },
      },
    });
    if (!epic || epic.projectId !== project.id || epic.deletedAt) return;
  }

  // Unified Chat Room groups all messages under the agentSlug "room"
  const dbAgentSlug = "room";

  const msg = await db.agentChatMessage.create({
    data: {
      projectId: project.id,
      taskId,
      epicId,
      agentSlug: dbAgentSlug,
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
        agentSlug: dbAgentSlug,
        allowDescriptionEdit,
      }),
    },
  });

  const targetAgents = new Map<string, { slug: string; gatewayPort: number | null }>();

  if (mentions.length > 0) {
    for (const u of users) {
      if (
        mentions.includes(u.username) &&
        u.kind === "agent" &&
        u.status === "active" &&
        u.agent &&
        !u.agent.deactivatedAt
      ) {
        targetAgents.set(u.agent.slug, {
          slug: u.agent.slug,
          gatewayPort: u.agent.gatewayPort ?? null,
        });
      }
    }
  } else {
    // Default targets when no mentions are present
    if (task) {
      const candidates = [
        task.assignee,
        task.actingManager,
        task.epic?.actingManager,
      ];
      for (const cand of candidates) {
        if (
          cand &&
          cand.kind === "agent" &&
          cand.status === "active" &&
          cand.agent &&
          !cand.agent.deactivatedAt
        ) {
          targetAgents.set(cand.agent.slug, {
            slug: cand.agent.slug,
            gatewayPort: cand.agent.gatewayPort ?? null,
          });
        }
      }
    } else if (epic) {
      const candidates = [
        epic.actingManager,
      ];
      for (const cand of candidates) {
        if (
          cand &&
          cand.kind === "agent" &&
          cand.status === "active" &&
          cand.agent &&
          !cand.agent.deactivatedAt
        ) {
          targetAgents.set(cand.agent.slug, {
            slug: cand.agent.slug,
            gatewayPort: cand.agent.gatewayPort ?? null,
          });
        }
      }
    }
  }

  const actorUser = await db.user.findUnique({
    where: { id: actor.id },
    select: { username: true },
  });

  for (const target of targetAgents.values()) {
    const agentSlug = target.slug;
    const gatewayPort = target.gatewayPort;

    const systemPrompt = taskId
      ? (allowDescriptionEdit
          ? buildTaskNativeEditGrantPrompt(task.title)
          : buildTaskNativeChannelPrompt(task.title, agentSlug))
      : (allowDescriptionEdit
          ? buildEpicNativeEditGrantPrompt(epic.title)
          : buildEpicNativeChannelPrompt(epic.title, agentSlug));

    const userMessage = taskId
      ? await buildTaskAgentUserMessage({
          taskId: task.id,
          agentSlug,
          currentTurn: {
            id: msg.id,
            source: "task chat",
            actorUsername: actorUser?.username,
            actorKind: actor.kind,
            body,
          },
        })
      : await buildEpicAgentUserMessage({
          epicId: epic.id,
          agentSlug,
          currentTurn: {
            id: msg.id,
            source: "epic chat",
            actorUsername: actorUser?.username,
            actorKind: actor.kind,
            body,
          },
        });

    const sessionBinding = await getOrCreateAgentSessionBinding({
      scopeType: taskId ? "task" : "epic",
      scopeId: taskId ? task.id : epic.id,
      agentSlug,
    });

    const delivery = await sendOpenClawPmChannelTurn({
      gatewayPort,
      agentSlug,
      sessionKey: sessionBinding.openclawSessionKey,
      kind: taskId ? "task-chat" : "epic-chat",
      text: body,
      contextText: userMessage,
      systemPrompt,
      actor: {
        id: actor.id,
        username: actorUser?.username,
        kind: actor.kind,
      },
      replyTarget: taskId
        ? {
            kind: "task-chat",
            agentSlug,
            taskId: task.id,
            messageId: msg.id,
            projectSlug: slug,
          }
        : {
            kind: "epic-chat",
            agentSlug,
            epicId: epic.id,
            messageId: msg.id,
            projectSlug: slug,
          },
    });

    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId: taskId ?? null,
        userId: actor.id,
        kind: taskId
          ? (delivery.ok ? "task.chat.dispatch" : "task.chat.dispatch_failed")
          : (delivery.ok ? "epic.chat.dispatch" : "epic.chat.dispatch_failed"),
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
