import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  renderCommentBody,
  renderFullMarkdown,
  extractMentions,
} from "@/lib/markdown";
import {
  checkAssignment,
  checkActingManager,
  checkHierarchy,
  checkStatusTransition,
  type ActorKind,
} from "@/lib/workflow";
import { COLUMN_IDS } from "../../columns";
import {
  buildTaskAssigned,
  buildTaskCommented,
  buildTaskMentioned,
  type EventTaskRef,
} from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import {
  buildTaskAgentUserMessage,
  buildTaskNativeChannelPrompt,
} from "@/lib/agents/task-chat-context";
import { getOrCreateAgentSessionBinding } from "@/lib/agents/session-bindings";
import { sendOpenClawPmChannelTurn } from "@/lib/agents/openclaw-pm-channel";
import {
  listAssignablePrincipals,
  type AssignablePrincipal,
} from "@/lib/principals";
import { uploadAttachment, deleteAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { deleteTask } from "@/lib/bin/actions";
import { reorderTasks } from "@/lib/tasks/reorder";
import SortableTaskList from "@/components/sortable-task-list";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import TaskRefresh from "./task-refresh";

async function requireActor(): Promise<{ id: string; kind: ActorKind }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, kind };
}

async function requireActorId(): Promise<string> {
  return (await requireActor()).id;
}

// ---- Server actions -------------------------------------------------

async function setTaskStatus(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const newStatus = String(formData.get("status") ?? "");
  if (!taskId || !slug || !COLUMN_IDS.includes(newStatus)) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      status: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.project.slug !== slug || task.status === newStatus) return;

  const check = checkStatusTransition({
    from: task.status,
    to: newStatus,
    actor,
  });
  if (!check.ok) throw new Error(check.message);

  const maxRank = await db.task.aggregate({
    where: { status: newStatus, deletedAt: null },
    _max: { rank: true },
  });

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: {
        status: newStatus,
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: new Date(),
      },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.move",
        payload: JSON.stringify({ from: task.status, to: newStatus }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function setTaskBranch(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const raw = String(formData.get("branchName") ?? "").trim();
  const branchName = raw === "" ? null : raw;
  if (!taskId || !slug) return;
  if (branchName !== null && branchName.length > 200) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      branchName: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if ((task.branchName ?? null) === branchName) return;

  await db.$transaction([
    db.task.update({ where: { id: taskId }, data: { branchName } }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.branch",
        payload: JSON.stringify({
          from: task.branchName ?? null,
          to: branchName,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
}

async function updateTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const titleRaw = String(formData.get("title") ?? "").trim();
  const descriptionRaw = String(formData.get("description") ?? "");
  if (!taskId || !slug || !titleRaw) return;
  if (titleRaw.length > 200) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;

  const newDescription = descriptionRaw.trim() === "" ? null : descriptionRaw;
  const titleChanged = task.title !== titleRaw;
  const descChanged = (task.description ?? null) !== newDescription;
  if (!titleChanged && !descChanged) return;

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { title: titleRaw, description: newDescription },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.update",
        payload: JSON.stringify({
          titleChanged,
          descChanged,
          from: { title: task.title, hasDescription: task.description !== null },
          to: { title: titleRaw, hasDescription: newDescription !== null },
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function setTaskEpic(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const raw = String(formData.get("epicId") ?? "");
  const newEpicId = raw === "" ? null : raw;
  if (!taskId || !slug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      epicId: true,
      project: { select: { slug: true } },
      epic: { select: { id: true, title: true, projectId: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if (task.epicId === newEpicId) return;

  // Scope-check: target epic must belong to the same project.
  let newEpicTitle: string | null = null;
  if (newEpicId !== null) {
    const target = await db.epic.findUnique({
      where: { id: newEpicId },
      select: { title: true, projectId: true },
    });
    if (!target || target.projectId !== task.projectId) {
      throw new Error("Epic not found in this project");
    }
    newEpicTitle = target.title;
  }

  await db.$transaction([
    db.task.update({ where: { id: taskId }, data: { epicId: newEpicId } }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.epic",
        payload: JSON.stringify({
          from: task.epic?.title ?? null,
          to: newEpicTitle,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function createComment(formData: FormData) {
  "use server";
  const actorId = await requireActorId();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!taskId || !slug || !body) return;
  if (body.length > 8000) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      project: { select: { slug: true } },
      assignee: {
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
  if (!task || task.project.slug !== slug) return;

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
  const actorUser = users.find((u) => u.id === actorId);
  const mentionedUsers = users.filter((u) => mentions.includes(u.username));
  const targetAgents = new Map<
    string,
    {
      slug: string;
      userId: string;
      username: string;
      gatewayPort: number | null;
      reasons: Set<"assigned" | "mentioned">;
    }
  >();
  function addTargetAgent(
    user:
      | {
          id: string;
          username: string;
          kind: string;
          status: string;
          agent: { slug: string; deactivatedAt: Date | null; gatewayPort: number | null } | null;
        }
      | null
      | undefined,
    reason: "assigned" | "mentioned",
  ) {
    if (
      !user ||
      user.kind !== "agent" ||
      user.status !== "active" ||
      !user.agent ||
      user.agent.deactivatedAt
    ) {
      return;
    }
    const existing = targetAgents.get(user.agent.slug);
    if (existing) {
      existing.reasons.add(reason);
      return;
    }
    targetAgents.set(user.agent.slug, {
      slug: user.agent.slug,
      userId: user.id,
      username: user.username,
      gatewayPort: user.agent.gatewayPort,
      reasons: new Set([reason]),
    });
  }
  addTargetAgent(task.assignee, "assigned");
  for (const user of mentionedUsers) addTargetAgent(user, "mentioned");
  const mirroredBody = [
    `Task comment from @${actorUser?.username ?? "unknown"}:`,
    "",
    body,
  ].join("\n");

  const { commentId, mirroredMessages } = await db.$transaction(async (tx) => {
    const comment = await tx.comment.create({
      data: { taskId, userId: actorId, body },
      select: { id: true, createdAt: true },
    });
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actorId,
        kind: "task.comment",
        payload: mentions.length > 0 ? JSON.stringify({ mentions }) : null,
      },
    });
    const mirrored: Array<{
      id: string;
      agentSlug: string;
      reason: string[];
      commentCreatedAt: Date;
    }> = [];
    for (const target of targetAgents.values()) {
      const msg = await tx.agentChatMessage.create({
        data: {
          projectId: task.projectId,
          taskId,
          epicId: null,
          agentSlug: target.slug,
          senderUserId: actorId,
          body: mirroredBody,
          allowDescriptionEdit: false,
          originChannel: "comment",
          originCommentId: comment.id,
        },
        select: { id: true },
      });
      const reason = [...target.reasons];
      mirrored.push({
        id: msg.id,
        agentSlug: target.slug,
        reason,
        commentCreatedAt: comment.createdAt,
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId,
          userId: actorId,
          kind: "task.chat.send",
          targetAgent: target.slug,
          payload: JSON.stringify({
            messageId: msg.id,
            agentSlug: target.slug,
            mirroredFromCommentId: comment.id,
            reason,
          }),
        },
      });
    }
    return { commentId: comment.id, mirroredMessages: mirrored };
  });

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);

  const taskRef: EventTaskRef = {
    id: task.id,
    key: task.id,
    projectKey: task.project.slug,
    title: task.title,
  };
  const actor = {
    id: actorId,
    kind: (users.find((u) => u.id === actorId)?.kind === "agent"
      ? "agent"
      : "human") as "human" | "agent",
  };
  const occurredAt = new Date().toISOString();
  await notifyDispatch(
    buildTaskCommented(
      { id: randomUUID(), occurredAt, actor, task: taskRef },
      {
        commentId,
        bodyMarkdown: body,
        mentions: mentionedUsers.map((u) => ({
          id: u.id,
          kind: u.kind === "agent" ? "agent" : "human",
        })),
      },
    ),
  );
  const mentionedNonAgentUsers = mentionedUsers.filter(
    (u) => u.kind !== "agent" || !u.agent || u.agent.deactivatedAt,
  );
  for (const u of mentionedNonAgentUsers) {
    await notifyDispatch(
      buildTaskMentioned(
        { id: randomUUID(), occurredAt, actor, task: taskRef },
        {
          commentId,
          mentioned: { id: u.id, kind: u.kind === "agent" ? "agent" : "human" },
          bodyMarkdown: body,
        },
      ),
    );
  }
  for (const msg of mirroredMessages) {
    const userMessage = await buildTaskAgentUserMessage({
      taskId: task.id,
      agentSlug: msg.agentSlug,
      currentTurn: {
        id: commentId,
        agentChatMessageId: msg.id,
        source: "task comment",
        actorUsername: actorUser?.username,
        actorKind: actor.kind,
        body,
        createdAt: msg.commentCreatedAt,
      },
    });
    const sessionBinding = await getOrCreateAgentSessionBinding({
      scopeType: "task",
      scopeId: task.id,
      agentSlug: msg.agentSlug,
    });
    const target = targetAgents.get(msg.agentSlug);
    const delivery = await sendOpenClawPmChannelTurn({
      gatewayPort: target?.gatewayPort ?? null,
      agentSlug: msg.agentSlug,
      sessionKey: sessionBinding.openclawSessionKey,
      kind: "task-comment",
      text: body,
      contextText: userMessage,
      systemPrompt: buildTaskNativeChannelPrompt(task.title, msg.agentSlug),
      actor: {
        id: actor.id,
        username: actorUser?.username,
        kind: actor.kind,
      },
      replyTarget: {
        kind: "task-comment",
        agentSlug: msg.agentSlug,
        taskId: task.id,
        messageId: msg.id,
        projectSlug: task.project.slug,
      },
    });
    await db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor.id,
        kind: delivery.ok ? "task.comment.dispatch" : "task.comment.dispatch_failed",
        targetAgent: msg.agentSlug,
        payload: JSON.stringify({
          commentId,
          messageId: msg.id,
          agentSlug: msg.agentSlug,
          reason: msg.reason,
          driver: delivery.driver,
          status: delivery.status ?? null,
          error: delivery.error ?? null,
        }),
      },
    });
  }
}

// Human-only comment removal (HOMELAB-41). Agents post comments but
// cannot delete them — moderation stays a human action. Scoped by the
// URL slug + task so a comment id from another project can't be removed.
async function deleteComment(formData: FormData) {
  "use server";
  const actor = await requireActor();
  if (actor.kind !== "human") return;
  const commentId = String(formData.get("commentId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  if (!commentId || !slug || !taskId) return;

  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: {
      id: true,
      task: {
        select: {
          id: true,
          projectId: true,
          project: { select: { slug: true } },
        },
      },
    },
  });
  if (
    !comment ||
    comment.task.id !== taskId ||
    comment.task.project.slug !== slug
  ) {
    return;
  }

  await db.$transaction([
    db.comment.delete({ where: { id: commentId } }),
    db.activityLog.create({
      data: {
        projectId: comment.task.projectId,
        taskId: comment.task.id,
        userId: actor.id,
        kind: "task.comment.delete",
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function assignTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const raw = String(formData.get("assigneeId") ?? "");
  const newAssigneeId = raw === "" ? null : raw;
  if (!taskId || !slug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      assigneeId: true,
      title: true,
      project: { select: { slug: true } },
      assignee: { select: { id: true, username: true, kind: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if (task.assigneeId === newAssigneeId) return;

  const check = checkAssignment({ actor, newAssigneeId });
  if (!check.ok) throw new Error(check.message);

  let toUsername: string | null = null;
  let target: { id: string; username: string; kind: string } | null = null;
  if (newAssigneeId !== null) {
    const row = await db.user.findUnique({
      where: { id: newAssigneeId },
      select: { id: true, username: true, kind: true, status: true },
    });
    if (!row || row.status !== "active") {
      throw new Error("Assignee not found or inactive");
    }
    target = { id: row.id, username: row.username, kind: row.kind };
    toUsername = row.username;
  }

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { assigneeId: newAssigneeId },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        kind: "task.assign",
        payload: JSON.stringify({
          from: task.assignee?.username ?? null,
          to: toUsername,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);

  await notifyDispatch(
    buildTaskAssigned(
      {
        id: randomUUID(),
        occurredAt: new Date().toISOString(),
        actor,
        task: {
          id: task.id,
          key: task.id,
          projectKey: task.project.slug,
          title: task.title,
        },
      },
      {
        assignee: target
          ? {
              id: target.id,
              kind: target.kind === "agent" ? "agent" : "human",
              name: target.username,
            }
          : null,
        previousAssignee: task.assignee
          ? {
              id: task.assignee.id,
              kind: task.assignee.kind === "agent" ? "agent" : "human",
              name: task.assignee.username,
            }
          : null,
      },
    ),
  );
}

async function setReviewer(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const raw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = raw === "" ? null : raw;
  if (!taskId || !slug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      actingManagerId: true,
      project: { select: { slug: true } },
      actingManager: { select: { username: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;
  if (task.actingManagerId === newActingManagerId) return;

  const check = checkActingManager({ actor, newActingManagerId });
  if (!check.ok) throw new Error(check.message);

  let toUsername: string | null = null;
  if (newActingManagerId !== null) {
    const target = await db.user.findUnique({
      where: { id: newActingManagerId },
      select: { username: true, status: true },
    });
    if (!target || target.status !== "active") {
      throw new Error("Reviewer not found or inactive");
    }
    toUsername = target.username;
  }

  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { actingManagerId: newActingManagerId },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actor.id,
        // Activity kind stays "task.acting_manager" so the historical
        // feed renders unchanged; UI labels it "Reviewer" only.
        kind: "task.acting_manager",
        payload: JSON.stringify({
          from: task.actingManager?.username ?? null,
          to: toUsername,
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);
}

async function createSubtask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const parentTaskId = String(formData.get("parentTaskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!parentTaskId || !slug || !title) return;
  if (title.length > 200) return;

  const parent = await db.task.findUnique({
    where: { id: parentTaskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      epicId: true,
      parentTaskId: true,
      project: {
        select: {
          slug: true,
          defaultAssigneeId: true,
          defaultReviewerId: true,
        },
      },
    },
  });
  if (!parent || parent.project.slug !== slug) return;

  if (parent.parentTaskId !== null) {
    throw new Error("Cannot create sub-task under another sub-task");
  }

  const check = checkHierarchy({ level: "subtask", parentTaskId });
  if (!check.ok) throw new Error(check.message);

  const maxRank = await db.task.aggregate({
    where: { projectId: parent.projectId, status: "Backlog", deletedAt: null },
    _max: { rank: true },
  });

  const child = await db.task.create({
    data: {
      projectId: parent.projectId,
      epicId: parent.epicId,
      parentTaskId,
      title,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      assigneeId: parent.project.defaultAssigneeId ?? null,
      actingManagerId: parent.project.defaultReviewerId ?? null,
    },
    select: { id: true, title: true },
  });

  await db.activityLog.create({
    data: {
      projectId: parent.projectId,
      taskId: child.id,
      userId: actor.id,
      kind: "task.create",
      payload: JSON.stringify({
        title: child.title,
        parentTaskId,
        parentTitle: parent.title,
      }),
    },
  });

  revalidatePath(`/projects/${slug}/tasks/${parentTaskId}`);
  revalidatePath(`/projects/${slug}/tasks/${child.id}`);
  revalidatePath(`/projects/${slug}`);
}

// ---- Helpers --------------------------------------------------------

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

function timeAgo(d: Date): string {
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toISOString().slice(0, 10);
}

function activityMessageIds(rows: Array<{ kind: string; payload: string | null }>) {
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as {
        inReplyToMessageId?: unknown;
        messageId?: unknown;
      };
      if (typeof payload.inReplyToMessageId === "string") ids.add(payload.inReplyToMessageId);
      if (typeof payload.messageId === "string" && row.kind.endsWith(".dispatch_failed")) ids.add(payload.messageId);
    } catch {
      // Ignore old or malformed audit payloads.
    }
  }
  return ids;
}

function PrincipalOption({ p }: { p: AssignablePrincipal }) {
  return (
    <option value={p.id}>
      {p.username}
      {p.kind === "agent" ? " (agent)" : ""}
    </option>
  );
}

// ---- Page -----------------------------------------------------------

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; taskId: string }>;
  searchParams: Promise<{ chat?: string }>;
}) {
  const [{ slug, taskId }, { chat = "" }] = await Promise.all([
    params,
    searchParams,
  ]);

  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      project: { select: { id: true, slug: true, name: true } },
      assignee: {
        select: {
          username: true,
          kind: true,
          agent: { select: { slug: true } },
        },
      },
      actingManager: { select: { username: true, kind: true } },
      epic: { select: { id: true, title: true } },
      parent: { select: { id: true, title: true } },
      subtasks: {
        where: { deletedAt: null },
        orderBy: { rank: "asc" },
        select: {
          id: true,
          title: true,
          status: true,
          updatedAt: true,
          assignee: { select: { username: true } },
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        include: { user: { select: { username: true } } },
      },
      attachments: {
        orderBy: { createdAt: "desc" },
        include: { uploader: { select: { username: true } } },
      },
    },
  });
  if (!task || task.project.slug !== slug || task.deletedAt) notFound();

  // Only human viewers get comment-delete controls (see deleteComment).
  const viewer = await requireActor();
  const canDeleteComments = viewer.kind === "human";

  const [principals, projectEpics, mentionableUsers, recentTaskChatMessages, recentReplyActivity] = await Promise.all([
    listAssignablePrincipals(),
    db.epic.findMany({
      where: {
        projectId: task.project.id,
        status: { not: "archived" },
        deletedAt: null,
      },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      select: { id: true, title: true, status: true },
    }),
    db.user.findMany({ select: { username: true } }),
    db.agentChatMessage.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: {
        id: true,
        agentSlug: true,
        originChannel: true,
        originCommentId: true,
        createdAt: true,
        sender: { select: { kind: true } },
      },
    }),
    db.activityLog.findMany({
      where: {
        taskId: task.id,
        kind: {
          in: [
            "task.chat.reply",
            "task.comment",
            "task.chat.dispatch_failed",
            "task.comment.dispatch_failed",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 160,
      select: { kind: true, payload: true },
    }),
  ]);
  const mentionables = mentionableUsers.map((u) => ({ username: u.username }));
  const settledMessageIds = activityMessageIds(recentReplyActivity);
  let pendingAgentSlug: string | null = null;
  const seenChatAgents = new Set<string>();
  for (const message of recentTaskChatMessages) {
    if (seenChatAgents.has(message.agentSlug)) continue;
    seenChatAgents.add(message.agentSlug);
    if (message.sender.kind !== "agent" && !settledMessageIds.has(message.id)) {
      pendingAgentSlug = message.agentSlug;
      break;
    }
  }
  const pendingAgentReply = pendingAgentSlug !== null;
  const pendingCommentMessages = recentTaskChatMessages
    .filter((message) => (
      message.originChannel === "comment"
      && message.sender.kind !== "agent"
      && !settledMessageIds.has(message.id)
    ))
    .filter((message, index, all) => all.findIndex((item) => item.agentSlug === message.agentSlug) === index)
    .slice(0, 4);
  const selectedAgentSlug = chat || pendingAgentSlug || task.assignee?.agent?.slug || null;

  async function reorderSubtasks(orderedIds: string[]): Promise<void> {
    "use server";
    await reorderTasks(orderedIds);
    revalidatePath(`/projects/${slug}/tasks/${taskId}`);
    revalidatePath(`/projects/${slug}`);
  }

  return (
    <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <TaskRefresh active={pendingAgentReply} />
      {/* ----- Main column ------------------------------------------- */}
      <div className="min-w-0 space-y-6">
        <nav className="text-sm">
          <Link
            href={`/projects/${slug}`}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
          >
            ← {task.project.name}
          </Link>
        </nav>

        {/* Title + description editor */}
        <form
          action={updateTask}
          className="space-y-3 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <input
            name="title"
            defaultValue={task.title}
            required
            maxLength={200}
            className="w-full rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight outline-none transition focus:border-[var(--color-line)] focus:bg-[var(--color-bg)]"
            aria-label="Task title"
          />
          {task.description ? (
            <div className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-3">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Preview
              </div>
              <div
                className="md"
                dangerouslySetInnerHTML={renderFullMarkdown(task.description)}
              />
            </div>
          ) : null}
          <textarea
            name="description"
            defaultValue={task.description ?? ""}
            // Sub-tasks (parentTaskId !== null) get a taller editor —
            // they're where most of the day-to-day work detail lands,
            // so the larger box matches actual use (HOMELAB-48).
            rows={task.parentTaskId !== null ? 24 : 12}
            placeholder="Add a description — markdown supported (headings, lists, code fences, tables)"
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[13px] leading-relaxed outline-none focus:border-[var(--color-accent)]"
          />
          <div className="flex items-center justify-between text-xs text-[var(--color-text-muted)]">
            <span>
              Last updated <time dateTime={task.updatedAt.toISOString()} title={task.updatedAt.toISOString()}>{timeAgo(task.updatedAt)}</time>
            </span>
            <button
              type="submit"
              className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
            >
              Save changes
            </button>
          </div>
        </form>

        {/* Sub-tasks */}
        <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-text)]">
              Sub-tasks
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">
              {task.subtasks.length} total
            </span>
          </div>
          {task.subtasks.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No sub-tasks yet.
            </p>
          ) : (
            <SortableTaskList
              ariaLabel="Sub-tasks"
              reorderAction={reorderSubtasks}
              showAssignee
              showStatusBadge
              items={task.subtasks.map((st) => ({
                id: st.id,
                title: st.title,
                status: st.status,
                href: `/projects/${slug}/tasks/${st.id}`,
                assigneeName: st.assignee?.username ?? null,
              }))}
            />
          )}

          {task.parentTaskId === null ? (
            <form action={createSubtask} className="mt-4 flex gap-2">
              <input type="hidden" name="parentTaskId" value={task.id} />
              <input type="hidden" name="projectSlug" value={slug} />
              <input
                name="title"
                required
                maxLength={200}
                placeholder="New sub-task title"
                className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-sm outline-none focus:border-[var(--color-accent)]"
              />
              <button
                type="submit"
                className="rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Add
              </button>
            </form>
          ) : (
            <p className="mt-4 text-xs text-[var(--color-text-muted)]">
              Sub-tasks of sub-tasks are not allowed. Add sub-tasks on the
              parent task.
            </p>
          )}
        </section>

        {/* Attachments */}
        <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-[var(--color-text)]">
              Attachments
            </h2>
            <span className="text-xs text-[var(--color-text-muted)]">
              Max {formatBytes(attachmentMaxBytes())} per file
            </span>
          </div>
          {task.attachments.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No attachments yet.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {task.attachments.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <a
                      href={`/api/attachments/${a.id}`}
                      className="truncate font-medium hover:underline"
                    >
                      {a.filename}
                    </a>
                    <div className="text-xs text-[var(--color-text-muted)]">
                      {formatBytes(a.sizeBytes)} · {a.mimeType} · uploaded by{" "}
                      @{a.uploader.username} ·{" "}
                      <time
                        dateTime={a.createdAt.toISOString()}
                        title={a.createdAt.toISOString()}
                      >
                        {timeAgo(a.createdAt)}
                      </time>
                    </div>
                  </div>
                  <form action={deleteAttachment}>
                    <input type="hidden" name="projectSlug" value={slug} />
                    <input type="hidden" name="attachmentId" value={a.id} />
                    <button
                      type="submit"
                      className="rounded border border-transparent px-2 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-line)] hover:text-[var(--color-crit)]"
                    >
                      Remove
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}

          <form
            action={uploadAttachment}
            encType="multipart/form-data"
            className="mt-4 flex flex-wrap items-center gap-2"
          >
            <input type="hidden" name="projectSlug" value={slug} />
            <input type="hidden" name="taskId" value={task.id} />
            <input
              type="file"
              name="file"
              required
              className="text-xs file:mr-2 file:rounded file:border-0 file:bg-[var(--color-accent)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--color-bg)] hover:file:opacity-90"
            />
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1.5 text-xs font-medium hover:border-[var(--color-accent)]"
            >
              Upload
            </button>
          </form>
        </section>

        {/* Comments */}
        <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold tracking-wide text-[var(--color-text)]">
            Comments
          </h2>
          {task.comments.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No comments yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {task.comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm"
                >
                  <div className="mb-1 flex items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                    <div className="flex items-center gap-2">
                      <strong className="font-medium text-[var(--color-text)]">
                        {c.user.username}
                      </strong>
                      <time
                        dateTime={c.createdAt.toISOString()}
                        title={c.createdAt.toISOString()}
                        className="tabular-nums"
                      >
                        {timeAgo(c.createdAt)}
                      </time>
                    </div>
                    {canDeleteComments ? (
                      <form action={deleteComment}>
                        <input type="hidden" name="commentId" value={c.id} />
                        <input type="hidden" name="taskId" value={task.id} />
                        <input
                          type="hidden"
                          name="projectSlug"
                          value={slug}
                        />
                        <button
                          type="submit"
                          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
                          title="Delete comment"
                          aria-label="Delete comment"
                        >
                          Delete
                        </button>
                      </form>
                    ) : null}
                  </div>
                  <div>{renderCommentBody(c.body, mentionables)}</div>
                </li>
              ))}
            </ul>
          )}

          {pendingCommentMessages.length > 0 ? (
            <div className="mt-3 space-y-2">
              {pendingCommentMessages.map((message) => (
                <StreamingAgentReply
                  key={message.id}
                  targetKind="task-comment"
                  agentSlug={message.agentSlug}
                  taskId={task.id}
                  messageId={message.id}
                  label={`@${message.agentSlug}`}
                />
              ))}
            </div>
          ) : null}

          <form action={createComment} className="mt-4 space-y-2">
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="projectSlug" value={slug} />
            <textarea
              name="body"
              required
              rows={3}
              placeholder="Write a comment — **markdown** and @mentions supported"
              className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Add comment
              </button>
            </div>
          </form>
        </section>
      </div>

      {/* ----- Sidebar (right) --------------------------------------- */}
      <aside className="space-y-4">
        <form
          action={setTaskStatus}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Status
          </div>
          <select
            name="status"
            defaultValue={task.status}
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
            aria-label="Status"
          >
            {COLUMN_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
            >
              Save
            </button>
          </div>
        </form>

        <form
          action={setTaskBranch}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Branch
          </div>
          <input
            name="branchName"
            defaultValue={task.branchName ?? ""}
            maxLength={200}
            placeholder="e.g. feature/HOMELAB-99"
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--color-accent)]"
            aria-label="Branch name"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
            >
              Save
            </button>
          </div>
        </form>

        <SidebarPicker
          title="Assignee"
          name="assigneeId"
          formAction={assignTask}
          slug={slug}
          taskId={task.id}
          selectedId={task.assigneeId}
          selectedLabel={task.assignee?.username ?? null}
          principals={principals}
          emptyOption="Unassigned"
        />

        <SidebarPicker
          title="Reviewer"
          name="actingManagerId"
          formAction={setReviewer}
          slug={slug}
          taskId={task.id}
          selectedId={task.actingManagerId}
          selectedLabel={task.actingManager?.username ?? null}
          principals={principals}
          emptyOption="No reviewer"
        />

        {/* Epic picker — independent of any Epic.assignee. Tasks may
            live without an Epic, and switching epics is reversible. */}
        <form
          action={setTaskEpic}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Epic
          </div>
          <select
            name="epicId"
            defaultValue={task.epicId ?? ""}
            className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
          >
            <option value="">No epic</option>
            {projectEpics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
                {e.status !== "open" ? ` · ${e.status}` : ""}
              </option>
            ))}
          </select>
          <div className="flex justify-end">
            <button
              type="submit"
              className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
            >
              Save
            </button>
          </div>
          {task.epic ? (
            <Link
              href={`/projects/${slug}/epics/${task.epic.id}`}
              className="block text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
            >
              Open epic →
            </Link>
          ) : null}
        </form>

        {task.parent ? (
          <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              Parent task
            </div>
            <Link
              href={`/projects/${slug}/tasks/${task.parent.id}`}
              className="mt-2 block text-sm hover:underline"
            >
              {task.parent.title}
            </Link>
          </div>
        ) : null}

        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Dates
          </div>
          <dl className="mt-2 space-y-1 text-xs">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Created</dt>
              <dd>
                <time
                  dateTime={task.createdAt.toISOString()}
                  title={task.createdAt.toISOString()}
                  className="tabular-nums"
                >
                  {timeAgo(task.createdAt)}
                </time>
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-[var(--color-text-muted)]">Updated</dt>
              <dd>
                <time
                  dateTime={task.updatedAt.toISOString()}
                  title={task.updatedAt.toISOString()}
                  className="tabular-nums"
                >
                  {timeAgo(task.updatedAt)}
                </time>
              </dd>
            </div>
          </dl>
        </div>

        {/* Soft delete — moves the task (and any sub-tasks) to the bin
            for 7 days, then hard-deletes. Restore from /projects/<slug>/bin. */}
        <form
          action={deleteTask}
          className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectSlug" value={slug} />
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-crit)]">
            Danger zone
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">
            Move this task to the bin. Sub-tasks ({task.subtasks.length}) go
            with it. Auto-purged after 7 days.
          </p>
          <button
            type="submit"
            className="w-full rounded-lg border border-[var(--color-crit)] bg-transparent px-3 py-1.5 text-xs font-medium text-[var(--color-crit)] hover:bg-[var(--color-crit)] hover:text-[var(--color-bg)]"
          >
            Delete task
          </button>
        </form>
      </aside>
    </div>
  );
}

// Sidebar picker shell — used for Assignee + Reviewer so both look
// identical and pull from the same principal pool. Server action
// references stay in the page so Next can pick them up as server
// actions (vs. importing from a client module).
function SidebarPicker({
  title,
  name,
  formAction,
  slug,
  taskId,
  selectedId,
  selectedLabel,
  principals,
  emptyOption,
}: {
  title: string;
  name: "assigneeId" | "actingManagerId";
  formAction: (formData: FormData) => Promise<void>;
  slug: string;
  taskId: string;
  selectedId: string | null;
  selectedLabel: string | null;
  principals: AssignablePrincipal[];
  emptyOption: string;
}) {
  return (
    <form
      action={formAction}
      className="space-y-2 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"
    >
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="projectSlug" value={slug} />
      <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {title}
      </div>
      <div className="text-sm">
        {selectedLabel ? (
          <span className="font-medium">@{selectedLabel}</span>
        ) : (
          <span className="text-[var(--color-text-muted)]">{emptyOption}</span>
        )}
      </div>
      <select
        name={name}
        defaultValue={selectedId ?? ""}
        className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs outline-none focus:border-[var(--color-accent)]"
        aria-label={title}
      >
        <option value="">{emptyOption}</option>
        {principals.map((p) => (
          <PrincipalOption key={p.id} p={p} />
        ))}
      </select>
      <div className="flex justify-end">
        <button
          type="submit"
          className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-1 text-xs font-medium hover:border-[var(--color-accent)]"
        >
          Save
        </button>
      </div>
    </form>
  );
}
