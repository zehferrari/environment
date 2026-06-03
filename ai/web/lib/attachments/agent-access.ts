import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type AttachmentAgentAccessReason =
  | "task.assignee"
  | "task.acting-manager"
  | "task.epic-acting-manager"
  | "task.mentioned"
  | "task.addressed"
  | "epic.assignee"
  | "epic.acting-manager"
  | "epic.child-task-role"
  | "epic.mentioned"
  | "epic.addressed"
  | "epic.child-task-mentioned"
  | "epic.child-task-addressed";

export type AttachmentAgentAccessResult =
  | { allowed: true; reason: AttachmentAgentAccessReason }
  | { allowed: false; reason: "attachment-not-found" | "agent-not-found" | "forbidden" };

type AgentPrincipal = {
  id: string;
  username: string;
  slug: string;
  role: string | null;
};

function uniq(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function mentionNeedles(agent: AgentPrincipal) {
  return uniq([agent.username, agent.slug]).map((value) => `@${value}`);
}

function commentMentionWhere(
  agent: AgentPrincipal,
): Prisma.CommentWhereInput[] {
  return mentionNeedles(agent).map((needle) => ({ body: { contains: needle } }));
}

function chatAddressWhere(
  agent: AgentPrincipal,
): Prisma.AgentChatMessageWhereInput[] {
  const conditions: Prisma.AgentChatMessageWhereInput[] = [
    { agentSlug: agent.slug },
    { targetValue: { contains: `agent:${agent.slug}` } },
    ...mentionNeedles(agent).map((needle) => ({ body: { contains: needle } })),
  ];
  if (agent.role === "coding") {
    conditions.push({ targetType: "all-coders" });
  }
  return conditions;
}

async function hasCommentMention(
  scope: { taskId: string } | { epicId: string },
  agent: AgentPrincipal,
) {
  return db.comment.count({
    where: {
      ...scope,
      deletedAt: null,
      OR: commentMentionWhere(agent),
    },
  }).then((count) => count > 0);
}

async function hasChatAddress(
  scope: { taskId: string } | { epicId: string },
  agent: AgentPrincipal,
) {
  return db.agentChatMessage.count({
    where: {
      ...scope,
      deletedAt: null,
      OR: chatAddressWhere(agent),
    },
  }).then((count) => count > 0);
}

async function taskRelationReason(taskId: string, agent: AgentPrincipal) {
  const task = await db.task.findFirst({
    where: { id: taskId, archivedAt: null, deletedAt: null },
    select: {
      assigneeId: true,
      actingManagerId: true,
      epic: {
        select: {
          actingManagerId: true,
          archivedAt: true,
          deletedAt: true,
        },
      },
    },
  });
  if (!task) return null;
  if (task.assigneeId === agent.id) return "task.assignee" as const;
  if (task.actingManagerId === agent.id) return "task.acting-manager" as const;
  if (
    task.epic &&
    task.epic.archivedAt === null &&
    task.epic.deletedAt === null &&
    task.epic.actingManagerId === agent.id
  ) {
    return "task.epic-acting-manager" as const;
  }
  return null;
}

async function taskMentionReason(taskId: string, agent: AgentPrincipal) {
  if (await hasCommentMention({ taskId }, agent)) return "task.mentioned" as const;
  if (await hasChatAddress({ taskId }, agent)) return "task.addressed" as const;
  return null;
}

async function epicRelationReason(epicId: string, agent: AgentPrincipal) {
  const epic = await db.epic.findFirst({
    where: { id: epicId, archivedAt: null, deletedAt: null },
    select: {
      assigneeId: true,
      actingManagerId: true,
    },
  });
  if (!epic) return null;
  if (epic.assigneeId === agent.id) return "epic.assignee" as const;
  if (epic.actingManagerId === agent.id) return "epic.acting-manager" as const;

  const childRoleCount = await db.task.count({
    where: {
      epicId,
      archivedAt: null,
      deletedAt: null,
      OR: [
        { assigneeId: agent.id },
        { actingManagerId: agent.id },
      ],
    },
  });
  if (childRoleCount > 0) return "epic.child-task-role" as const;

  return null;
}

async function epicMentionReason(epicId: string, agent: AgentPrincipal) {
  if (await hasCommentMention({ epicId }, agent)) return "epic.mentioned" as const;
  if (await hasChatAddress({ epicId }, agent)) return "epic.addressed" as const;

  const taskMentionCount = await db.comment.count({
    where: {
      task: { is: { epicId, archivedAt: null, deletedAt: null } },
      deletedAt: null,
      OR: commentMentionWhere(agent),
    },
  });
  if (taskMentionCount > 0) return "epic.child-task-mentioned" as const;

  const taskAddressCount = await db.agentChatMessage.count({
    where: {
      task: { is: { epicId, archivedAt: null, deletedAt: null } },
      deletedAt: null,
      OR: chatAddressWhere(agent),
    },
  });
  if (taskAddressCount > 0) return "epic.child-task-addressed" as const;

  return null;
}

export async function checkAgentAttachmentReadAccess(args: {
  attachmentId: string;
  agentSlug: string;
}): Promise<AttachmentAgentAccessResult> {
  const [attachment, agent] = await Promise.all([
    db.attachment.findUnique({
      where: { id: args.attachmentId },
      select: { taskId: true, epicId: true },
    }),
    db.agent.findFirst({
      where: {
        slug: args.agentSlug,
        deactivatedAt: null,
        user: { is: { status: "active" } },
      },
      select: {
        slug: true,
        role: true,
        user: { select: { id: true, username: true } },
      },
    }),
  ]);

  if (!attachment) return { allowed: false, reason: "attachment-not-found" };
  if (!agent?.user) return { allowed: false, reason: "agent-not-found" };

  const principal: AgentPrincipal = {
    id: agent.user.id,
    username: agent.user.username,
    slug: agent.slug,
    role: agent.role,
  };

  if (attachment.taskId) {
    const relationReason = await taskRelationReason(attachment.taskId, principal);
    if (relationReason) return { allowed: true, reason: relationReason };
    const mentionReason = await taskMentionReason(attachment.taskId, principal);
    if (mentionReason) return { allowed: true, reason: mentionReason };
  }

  if (attachment.epicId) {
    const relationReason = await epicRelationReason(attachment.epicId, principal);
    if (relationReason) return { allowed: true, reason: relationReason };
    const mentionReason = await epicMentionReason(attachment.epicId, principal);
    if (mentionReason) return { allowed: true, reason: mentionReason };
  }

  return { allowed: false, reason: "forbidden" };
}
