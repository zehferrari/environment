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
import { buildTaskAgentChat, type EventTaskRef } from "@/lib/pm-events";

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

  // Task chats fire a typed task.agent_chat envelope. The consumer
  // (lib/pm-consumer/target.ts) routes by payload.targetAgentSlug —
  // not by task assignee — so a chat can reach any active agent.
  //
  // Epic chats persist only: PmEvent schema v1 is task-scoped, and
  // expanding it to epics is deliberately out of scope for HOMELAB-48.
  if (task) {
    const actorRef = { id: actor.id, kind: actor.kind };
    const taskRef: EventTaskRef = {
      id: task.id,
      key: task.id,
      projectKey: slug,
      title: task.title,
    };
    const systemPrompt = allowDescriptionEdit
      ? buildEditGrantPrompt(task.title)
      : buildPlainChatPrompt(task.title, agentSlug);
    // Embed the current description verbatim in userMessage so the
    // LLM has it in the conversation turn (not just in a structured
    // field the runtime might or might not surface). Reference is
    // delimited so the LLM can spot the request vs. the existing copy.
    const userMessage = buildUserMessage(body, task.description);
    await notifyDispatch(
      buildTaskAgentChat(
        {
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          actor: actorRef,
          task: taskRef,
        },
        {
          chatMessageId: msg.id,
          targetAgentSlug: agentSlug,
          userMessage,
          allowDescriptionEdit,
          currentDescription: task.description,
          systemPrompt,
          replyEndpoint: allowDescriptionEdit
            ? {
                method: "POST",
                path: `/api/tasks/${task.id}/description`,
                bodyShape: {
                  messageId: msg.id,
                  description: "<agent reply text>",
                },
              }
            : null,
        },
      ),
    );
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

// Strict system prompt used when the chat message carries a
// description-edit grant. PM owns this template so the contract is
// version-controlled with the endpoint that consumes it. Update both
// in lock-step.
//
// Markdown intent: descriptions are routinely README.md-style content
// (headings, lists, fenced code, tables). The strict rule is about
// the OUTER response shape — don't wrap the whole reply in a JSON
// object or a single ```markdown ... ``` fence — but markdown
// constructs INSIDE the description, including code fences for
// example snippets, are first-class.
function buildEditGrantPrompt(taskTitle: string): string {
  return [
    `You have been authorised to rewrite the description of the task "${taskTitle}".`,
    "",
    "RESPONSE RULES (strict):",
    "1. Your response body must be the FINAL description text and",
    "   nothing else — no preamble, no acknowledgement, no \"Sure,",
    "   here is...\", no trailing notes.",
    "2. Do NOT wrap the whole response in a code fence (\\`\\`\\`) or a",
    "   JSON object. The endpoint already JSON-encodes the reply.",
    "3. Markdown content INSIDE the description is encouraged when it",
    "   helps — headings, bullet lists, fenced code blocks for example",
    "   snippets, tables, links. README.md / runbook style is common.",
    "4. Your full response will be persisted verbatim as the new",
    "   description, replacing the current one in full.",
    "5. The grant is single-use. Do not call the reply endpoint twice.",
    "",
    "The user's request and the current description are below in",
    "userMessage. The same currentDescription is also available as a",
    "structured field on the envelope payload.",
  ].join("\n");
}

function buildPlainChatPrompt(taskTitle: string, slug: string): string {
  return [
    `You have a directed chat message on task "${taskTitle}", addressed to @${slug}.`,
    "Respond conversationally; you do NOT have permission to write the",
    "description on this message (allowDescriptionEdit is false).",
    "Markdown formatting in your reply is welcome.",
  ].join("\n");
}

// Build the userMessage shipped on the envelope. The current
// description is embedded verbatim under a clearly-delimited block so
// an LLM that sees only userMessage (no access to structured payload
// fields) still has full context. The marker lines are intentional —
// they're stable, greppable, and unambiguous.
function buildUserMessage(
  body: string,
  currentDescription: string | null,
): string {
  if (!currentDescription || currentDescription.trim() === "") {
    return [
      "USER REQUEST:",
      body,
      "",
      "CURRENT DESCRIPTION: (empty)",
    ].join("\n");
  }
  return [
    "USER REQUEST:",
    body,
    "",
    "CURRENT DESCRIPTION (verbatim, between the markers):",
    "<<<CURRENT_DESCRIPTION",
    currentDescription,
    "CURRENT_DESCRIPTION>>>",
  ].join("\n");
}
