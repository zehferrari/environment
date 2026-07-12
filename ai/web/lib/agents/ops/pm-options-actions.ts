"use server";

import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth/permissions";
import { parsePmOptions } from "@/lib/pm-options";
import { sendAgentChatMessage } from "@/lib/agents/chat/actions";
import { sendTaskCommentNotifications } from "@/lib/agents/workflow/notifications/task";
import { revalidateTaskReplyScope } from "@/lib/tasks/cache";

async function requireHumanActor() {
  const owner = await requireOwner();
  return { id: owner.id };
}

export async function submitPmOptionDecision(formData: FormData) {
  const actor = await requireHumanActor();
  const projectSlug = String(formData.get("projectSlug") ?? "");
  const sourceMessageId = String(formData.get("sourceMessageId") ?? "");
  const optionId = String(formData.get("optionId") ?? "");
  const surface = String(formData.get("surface") ?? "");
  if (!projectSlug || !sourceMessageId || !optionId) return;

  if (surface === "task-chat" || surface === "epic-chat") {
    const source = await db.agentChatMessage.findUnique({
      where: { id: sourceMessageId },
      select: {
        id: true,
        body: true,
        targetType: true,
        targetValue: true,
        taskId: true,
        epicId: true,
        project: { select: { slug: true } },
      },
    });
    if (!source || source.project.slug !== projectSlug) return;
    if (surface === "task-chat" && !source.taskId) return;
    if (surface === "epic-chat" && !source.epicId) return;
    const option = parsePmOptions(source.body).options.find((candidate) => candidate.id === optionId);
    if (!option) return;

    const next = new FormData();
    next.set("projectSlug", projectSlug);
    if (source.taskId) next.set("taskId", source.taskId);
    if (source.epicId) next.set("epicId", source.epicId);
    next.set("body", option.label);
    next.set("decisionForMessageId", source.id);
    next.set("decisionOption", option.label);
    if (source.targetType === "agent" && source.targetValue) {
      next.set("discussionTarget", source.targetValue);
    } else if (source.targetType === "multi" && source.targetValue) {
      try {
        const values = JSON.parse(source.targetValue);
        if (Array.isArray(values)) {
          for (const value of values) if (typeof value === "string") next.append("discussionTarget", value);
        }
      } catch {
        // Fall back to default routing below.
      }
    }
    await sendAgentChatMessage(next);
    return;
  }

  if (surface === "task-comment") {
    const source = await db.comment.findUnique({
      where: { id: sourceMessageId },
      select: {
        id: true,
        body: true,
        taskId: true,
        task: { select: { id: true, projectId: true, title: true, project: { select: { slug: true } } } },
      },
    });
    if (!source?.task || !source.taskId || source.task.project.slug !== projectSlug) return;
    const option = parsePmOptions(source.body).options.find((candidate) => candidate.id === optionId);
    if (!option) return;

    const users = await db.user.findMany({ select: { id: true, username: true, kind: true } });
    const comment = await db.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: { taskId: source.taskId!, userId: actor.id, body: option.label },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: source.task!.projectId,
          taskId: source.taskId!,
          userId: actor.id,
          kind: "task.comment",
          payload: JSON.stringify({
            decision: option.label,
            decisionForMessageId: source.id,
            source: "pm-options",
          }),
        },
      });
      return created;
    });

    revalidateTaskReplyScope(source.taskId, "comment");
    const actorUser = users.find((u) => u.id === actor.id);
    await sendTaskCommentNotifications({
      taskId: source.task.id,
      commentId: comment.id,
      body: option.label,
      actor: {
        id: actor.id,
        username: actorUser?.username,
        kind: "human",
      },
    });
  }
}
