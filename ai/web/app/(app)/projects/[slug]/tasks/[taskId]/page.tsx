import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
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
} from "@/lib/pm-events";
import { notifyDispatch } from "@/lib/pm-dispatch";
import {
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
} from "@/lib/agents/task-workflow-notifications";
import {
  listAssignablePrincipals,
} from "@/lib/principals";
import { uploadAttachment, deleteAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import { deleteTask } from "@/lib/bin/actions";
import { reorderTasks } from "@/lib/tasks/reorder";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import SortableTaskList from "@/components/sortable-task-list";
import AttachmentUploadFab from "@/components/attachment-upload-fab";
import AutoScrollToLatest from "@/components/auto-scroll-to-latest";
import StreamingAgentReply from "@/components/streaming-agent-reply";
import ChatRoom from "@/components/chat-room";
import CommentComposerFab from "@/components/comment-composer-fab";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
} from "@/components/message-avatar";
import DescriptionField from "@/components/description-field";
import { TabsProvider, TabsNav, TabPanel } from "@/components/task-tabs";
import AvatarCombobox, { type AvatarComboboxOption } from "@/components/avatar-combobox";

type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
};

function serializeActor(actor: ActorRow | null) {
  if (!actor) return null;
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind,
    name: actor.name,
    avatarUpdatedAt: actor.avatarUpdatedAt?.toISOString() ?? null,
    agent: actor.agent,
  };
}

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

// Single task-form save. Persists title, description, status, epic,
// branch, commit prefix, assignee and reviewer in one transaction, with
// each field keeping the validation its standalone action used to do
// (workflow transition rules, project-scoped epic, no agent self-assign /
// self-review). Only changed fields are written + activity-logged; a hard
// rule violation throws (whole save fails) the same way the old per-field
// actions did. The assignment wake fires after commit, non-throwing.
async function updateTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const slug = String(formData.get("projectSlug") ?? "");
  if (!taskId || !slug) return;

  const titleRaw = String(formData.get("title") ?? "").trim();
  if (!titleRaw || titleRaw.length > 200) return;
  const descriptionRaw = String(formData.get("description") ?? "");
  const newDescription = descriptionRaw.trim() === "" ? null : descriptionRaw;
  const newStatus = String(formData.get("status") ?? "");
  const epicRaw = String(formData.get("epicId") ?? "");
  const newEpicId = epicRaw === "" ? null : epicRaw;
  const branchRaw = String(formData.get("branchName") ?? "").trim();
  const newBranch = branchRaw === "" ? null : branchRaw;
  const commitRaw = String(formData.get("commitPrefix") ?? "").trim();
  const newCommitPrefix = commitRaw === "" ? null : commitRaw;
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const newAssigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const reviewerRaw = String(formData.get("actingManagerId") ?? "");
  const newActingManagerId = reviewerRaw === "" ? null : reviewerRaw;
  const reporterRaw = String(formData.get("reporterId") ?? "");
  const newReporterId = reporterRaw === "" ? null : reporterRaw;

  if (newStatus !== "" && !COLUMN_IDS.includes(newStatus)) return;
  if (newBranch !== null && newBranch.length > 200) return;
  if (newCommitPrefix !== null && newCommitPrefix.length > 200) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      projectId: true,
      title: true,
      description: true,
      status: true,
      epicId: true,
      branchName: true,
      commitPrefix: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      project: { select: { slug: true } },
      epic: { select: { title: true, branchName: true, commitPrefix: true } },
      assignee: { select: { id: true, username: true, kind: true } },
      actingManager: { select: { username: true } },
      reporter: { select: { username: true } },
    },
  });
  if (!task || task.project.slug !== slug) return;

  const data: Prisma.TaskUpdateInput = {};
  const activity: { kind: string; payload: string }[] = [];
  let assignmentTarget: { id: string; kind: string; username: string } | null =
    null;
  let assignmentChanged = false;
  let statusChangedTo: string | null = null;

  // Title / description
  const titleChanged = task.title !== titleRaw;
  const descChanged = (task.description ?? null) !== newDescription;
  if (titleChanged || descChanged) {
    data.title = titleRaw;
    data.description = newDescription;
    activity.push({
      kind: "task.update",
      payload: JSON.stringify({
        titleChanged,
        descChanged,
        from: { title: task.title, hasDescription: task.description !== null },
        to: { title: titleRaw, hasDescription: newDescription !== null },
      }),
    });
  }

  // Status (workflow-validated, recomputes rank like the board move)
  if (newStatus !== "" && newStatus !== task.status) {
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
    data.status = newStatus;
    data.rank = (maxRank._max.rank ?? 0) + 1;
    data.statusChangedAt = new Date();
    statusChangedTo = newStatus;
    activity.push({
      kind: "task.move",
      payload: JSON.stringify({ from: task.status, to: newStatus }),
    });
  }

  // Epic (must belong to the same project)
  let selectedEpicDefaults =
    newEpicId === task.epicId
      ? { branchName: task.epic?.branchName ?? null, commitPrefix: task.epic?.commitPrefix ?? null }
      : null;

  if (newEpicId !== task.epicId) {
    let newEpicTitle: string | null = null;
    if (newEpicId !== null) {
      const target = await db.epic.findUnique({
        where: { id: newEpicId },
        select: { title: true, projectId: true, branchName: true, commitPrefix: true },
      });
      if (!target || target.projectId !== task.projectId) {
        throw new Error("Epic not found in this project");
      }
      newEpicTitle = target.title;
      selectedEpicDefaults = {
        branchName: target.branchName,
        commitPrefix: target.commitPrefix,
      };
    }
    data.epic =
      newEpicId === null ? { disconnect: true } : { connect: { id: newEpicId } };
    activity.push({
      kind: "task.epic",
      payload: JSON.stringify({
        from: task.epic?.title ?? null,
        to: newEpicTitle,
      }),
    });
  }

  const effectiveNewBranch = newBranch ?? selectedEpicDefaults?.branchName ?? null;
  const effectiveNewCommitPrefix = newCommitPrefix ?? selectedEpicDefaults?.commitPrefix ?? null;

  // Branch
  if ((task.branchName ?? null) !== effectiveNewBranch) {
    data.branchName = effectiveNewBranch;
    activity.push({
      kind: "task.branch",
      payload: JSON.stringify({ from: task.branchName ?? null, to: effectiveNewBranch }),
    });
  }

  // Commit prefix (HOMELAB task-form redesign)
  if ((task.commitPrefix ?? null) !== effectiveNewCommitPrefix) {
    data.commitPrefix = effectiveNewCommitPrefix;
    activity.push({
      kind: "task.commit_prefix",
      payload: JSON.stringify({
        from: task.commitPrefix ?? null,
        to: effectiveNewCommitPrefix,
      }),
    });
  }

  // Assignee (no agent self-assign; target must be active)
  if (newAssigneeId !== task.assigneeId) {
    const check = checkAssignment({ actor, newAssigneeId });
    if (!check.ok) throw new Error(check.message);
    if (newAssigneeId !== null) {
      const row = await db.user.findUnique({
        where: { id: newAssigneeId },
        select: { id: true, username: true, kind: true, status: true },
      });
      if (!row || row.status !== "active") {
        throw new Error("Assignee not found or inactive");
      }
      assignmentTarget = { id: row.id, username: row.username, kind: row.kind };
    }
    data.assignee =
      newAssigneeId === null
        ? { disconnect: true }
        : { connect: { id: newAssigneeId } };
    assignmentChanged = true;
    activity.push({
      kind: "task.assign",
      payload: JSON.stringify({
        from: task.assignee?.username ?? null,
        to: assignmentTarget?.username ?? null,
      }),
    });
  }

  // Reviewer / acting manager (no agent self-review; target must be active)
  if (newActingManagerId !== task.actingManagerId) {
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
    data.actingManager =
      newActingManagerId === null
        ? { disconnect: true }
        : { connect: { id: newActingManagerId } };
    activity.push({
      kind: "task.acting_manager",
      payload: JSON.stringify({
        from: task.actingManager?.username ?? null,
        to: toUsername,
      }),
    });
  }

  // Reporter (active User/Agent row; defaults to creator on new tasks)
  if (newReporterId !== task.reporterId) {
    let toUsername: string | null = null;
    if (newReporterId !== null) {
      const target = await db.user.findUnique({
        where: { id: newReporterId },
        select: { username: true, status: true },
      });
      if (!target || target.status !== "active") {
        throw new Error("Reporter not found or inactive");
      }
      toUsername = target.username;
    }
    data.reporter =
      newReporterId === null
        ? { disconnect: true }
        : { connect: { id: newReporterId } };
    activity.push({
      kind: "task.reporter",
      payload: JSON.stringify({
        from: task.reporter?.username ?? null,
        to: toUsername,
      }),
    });
  }

  if (activity.length === 0) return; // nothing changed

  await db.$transaction([
    db.task.update({ where: { id: taskId }, data }),
    ...activity.map((a) =>
      db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId,
          userId: actor.id,
          kind: a.kind,
          payload: a.payload,
        },
      }),
    ),
  ]);

  try {
    const { deleteDescriptionDraft } = await import("@/lib/description-drafts");
    // Save applied — clear THIS user's draft (others viewing the same
    // task with their own drafts keep them).
    await deleteDescriptionDraft({ scope: "task", targetId: taskId, requesterUserId: actor.id });
  } catch (e) {
    console.error("Failed to delete description draft:", e);
  }

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);

  // Assignment wake fires after the commit, non-throwing (mirrors the old
  // standalone assignTask path).
  if (assignmentChanged) {
    await notifyDispatch(
      buildTaskAssigned(
        {
          id: randomUUID(),
          occurredAt: new Date().toISOString(),
          actor,
          task: { id: task.id, key: task.id, projectKey: slug, title: titleRaw },
        },
        {
          assignee: assignmentTarget
            ? {
                id: assignmentTarget.id,
                kind: assignmentTarget.kind === "agent" ? "agent" : "human",
                name: assignmentTarget.username,
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

  const finalStatus = statusChangedTo ?? task.status;
  const finalAssigneeId = assignmentChanged ? newAssigneeId : task.assigneeId;
  if (
    finalAssigneeId &&
    (assignmentChanged || statusChangedTo === "To Do") &&
    (finalStatus === "Backlog" || finalStatus === "To Do")
  ) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: finalAssigneeId,
      actor,
      reason: finalStatus === "Backlog" ? "backlog_plan_requested" : "todo_start_required",
      body: finalStatus === "Backlog"
        ? [
            `You have been assigned to "${titleRaw}" while it is in Backlog.`,
            "Read the full task context and existing comments. Post a concise task comment with your implementation plan or opinion.",
            "Do not change task status and do not start work until the task is moved to To Do.",
          ].join("\n")
        : [
            `Task "${titleRaw}" is now in To Do and assigned to you.`,
            "Read the full task context, move it to In Progress through the workflow endpoint, and start work immediately.",
            "Do not post a visible acknowledgement unless you have new task information to add.",
          ].join("\n"),
    });
  }

  if (statusChangedTo === "Review") {
    const updatedTask = await db.task.findUnique({
      where: { id: task.id },
      select: {
        actingManagerId: true,
        reporterId: true,
        epic: { select: { status: true, actingManagerId: true } },
      },
    });
    const reviewerId = updatedTask ? resolveReviewOwnerId(updatedTask) : null;
    if (reviewerId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: reviewerId,
        actor,
        reason: "review_requested",
        body: [
          `Task "${titleRaw}" was moved to Review.`,
          "Review the completed work and full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, leave concise feedback while keeping it in Review.",
        ].join("\n"),
      });
    }
  }
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
      project: { select: { slug: true } },
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

  const comment = await db.$transaction(async (tx) => {
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
    return comment;
  });

  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
  revalidatePath(`/projects/${slug}`);

  const actor = {
    id: actorId,
    kind: (users.find((u) => u.id === actorId)?.kind === "agent"
      ? "agent"
      : "human") as "human" | "agent",
  };
  await sendTaskCommentNotifications({
    taskId: task.id,
    commentId: comment.id,
    body,
    actor: {
      id: actor.id,
      username: actorUser?.username,
      kind: actor.kind,
    },
  });
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
    !comment.task ||
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
      branchName: true,
      commitPrefix: true,
      parentTaskId: true,
      project: {
        select: {
          slug: true,
          defaultAssigneeId: true,
          defaultReviewerId: true,
        },
      },
      epic: { select: { branchName: true, commitPrefix: true } },
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
      reporterId: actor.id,
      branchName: parent.branchName ?? parent.epic?.branchName ?? null,
      commitPrefix: parent.commitPrefix ?? parent.epic?.commitPrefix ?? null,
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

  if (parent.project.defaultAssigneeId) {
    await sendTaskWorkflowNotification({
      taskId: child.id,
      targetUserId: parent.project.defaultAssigneeId,
      actor,
      reason: "backlog_plan_requested",
      body: [
        `You have been assigned to "${child.title}" while it is in Backlog.`,
        "Read the full task context and existing comments. Post a concise task comment with your implementation plan or opinion.",
        "Do not change task status and do not start work until the task is moved to To Do.",
      ].join("\n"),
    });
  }

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
        target?: { messageId?: unknown };
      };
      if (typeof payload.inReplyToMessageId === "string") ids.add(payload.inReplyToMessageId);
      if (row.kind.endsWith(".dispatch_failed") && typeof payload.messageId === "string") {
        ids.add(payload.messageId);
      }
      if (row.kind.endsWith(".stream_error") && typeof payload.target?.messageId === "string") {
        ids.add(payload.target.messageId);
      }
    } catch {
      // Ignore old or malformed audit payloads.
    }
  }
  return ids;
}

type WorkflowBubbleActor = {
  username?: string | null;
  kind?: string | null;
  agent?: { slug?: string | null } | null;
} | null;

type WorkflowBubbleTask = {
  status: string;
  assignee?: WorkflowBubbleActor;
  actingManager?: WorkflowBubbleActor;
  reporter?: WorkflowBubbleActor;
  epic?: {
    status?: string | null;
    actingManager?: WorkflowBubbleActor;
  } | null;
};

type PendingCommentMessage = {
  id: string;
  agentSlug: string;
  originChannel: string;
  sender: { kind: string };
  body: string;
};

type PendingCommentRun = {
  messageId: string;
  agentSlug: string;
  status: string;
};

function workflowActorSlug(actor: WorkflowBubbleActor | undefined) {
  if (!actor) return null;
  if (actor.kind === "agent" && actor.agent?.slug) return actor.agent.slug;
  return actor.username ?? null;
}

function workflowNotificationStatus(body: string) {
  if (!body.startsWith("PM workflow notification for @")) return null;
  if (body.includes(" while it is in Backlog.")) return "Backlog";
  if (body.includes(" is now in To Do ")) return "To Do";
  if (body.includes(" was moved to Review.")) return "Review";
  return null;
}

function workflowOwnerSlugs(task: WorkflowBubbleTask) {
  const slugs = new Set<string>();
  const add = (slug: string | null) => {
    if (slug) slugs.add(slug);
  };

  if (task.status === "Backlog" || task.status === "To Do" || task.status === "In Progress") {
    add(workflowActorSlug(task.assignee));
    return slugs;
  }

  if (task.status === "Review") {
    add(
      workflowActorSlug(task.actingManager)
        ?? (task.epic?.status === "Open" ? workflowActorSlug(task.epic?.actingManager) : null)
        ?? workflowActorSlug(task.reporter),
    );
  }

  return slugs;
}

function isCurrentWorkflowNotification(task: WorkflowBubbleTask, message: PendingCommentMessage) {
  const expectedStatus = workflowNotificationStatus(message.body);
  if (!expectedStatus) return true;
  if (task.status !== expectedStatus) return false;
  return workflowOwnerSlugs(task).has(message.agentSlug);
}

function shouldRenderPendingCommentMessage(args: {
  task: WorkflowBubbleTask;
  message: PendingCommentMessage;
  run?: PendingCommentRun;
  settledMessageIds: Set<string>;
}) {
  const { task, message, run, settledMessageIds } = args;
  if (message.originChannel !== "comment" || message.sender.kind === "agent") {
    return false;
  }

  const isWorkflowNotification = workflowNotificationStatus(message.body) !== null;
  const isCurrentWorkflow = isCurrentWorkflowNotification(task, message);
  if (isWorkflowNotification && !isCurrentWorkflow) return false;

  if (run?.status === "failed") {
    return isWorkflowNotification && isCurrentWorkflow;
  }
  if (run?.status === "complete") return false;
  if (settledMessageIds.has(message.id)) return false;

  return true;
}

function settledAgentSlugsForMessage(
  rows: Array<{ kind: string; payload: string | null; targetAgent?: string | null }>,
  messageId: string,
  runs: Array<{ messageId: string; agentSlug: string; status: string }> = [],
) {
  const slugs = new Set<string>();
  for (const run of runs) {
    if (run.messageId === messageId && run.status === "complete") {
      slugs.add(run.agentSlug);
    }
  }
  for (const row of rows) {
    if (!row.payload) continue;
    try {
      const payload = JSON.parse(row.payload) as {
        inReplyToMessageId?: unknown;
        messageId?: unknown;
        agentSlug?: unknown;
      };
      const agentSlug =
        typeof row.targetAgent === "string"
          ? row.targetAgent
          : typeof payload.agentSlug === "string"
            ? payload.agentSlug
            : null;
      if (!agentSlug) continue;
      if (
        (row.kind === "task.chat.reply" || row.kind === "task.chat.silent") &&
        payload.inReplyToMessageId === messageId
      ) {
        slugs.add(agentSlug);
      }
    } catch {
      // Ignore old or malformed audit payloads.
    }
  }
  return slugs;
}

function discussionTargetValue(
  principal: { id?: string | null; kind?: string | null; agent?: { slug?: string | null } | null } | null | undefined,
) {
  if (!principal?.id) return null;
  if (principal.kind === "agent" && principal.agent?.slug) return `agent:${principal.agent.slug}`;
  return `user:${principal.id}`;
}

// ---- Page -----------------------------------------------------------

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; taskId: string }>;
  searchParams: Promise<{ chat?: string; chatArchive?: string; chatRoom?: string }>;
}) {
  const [{ slug, taskId }, { chatArchive = "", chatRoom = "" }] = await Promise.all([
    params,
    searchParams,
  ]);

  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      project: { select: { id: true, slug: true, name: true } },
      assignee: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          status: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
        },
      },
      actingManager: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          status: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
        },
      },
      reporter: {
        select: {
          id: true,
          username: true,
          name: true,
          kind: true,
          status: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
        },
      },
      epic: {
        select: {
          id: true,
          title: true,
          status: true,
          branchName: true,
          commitPrefix: true,
          actingManager: {
            select: {
              id: true,
              username: true,
              name: true,
              kind: true,
              status: true,
              avatarUpdatedAt: true,
              agent: { select: { slug: true, role: true, deactivatedAt: true, name: true, avatar: true } },
            },
          },
        },
      },
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
        include: {
          user: {
            select: {
              id: true,
              username: true,
              kind: true,
              name: true,
              avatarUpdatedAt: true,
              agent: { select: { slug: true, name: true, avatar: true } },
            },
          },
        },
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

  const [principals, projectEpics, mentionableUsers, recentTaskChatMessages, recentReplyActivity, latestRepoVerify] = await Promise.all([
    listAssignablePrincipals(),
    db.epic.findMany({
      where: {
        projectId: task.project.id,
        status: { not: "Archive" },
        deletedAt: null,
      },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      select: { id: true, title: true, status: true },
    }),
    db.user.findMany({ select: { username: true } }),
    db.agentChatMessage.findMany({
      where: { taskId: task.id, archiveId: null },
      orderBy: { createdAt: "desc" },
      take: 80,
      select: {
        id: true,
        agentSlug: true,
        originChannel: true,
        originCommentId: true,
        createdAt: true,
        body: true,
        sender: { select: { kind: true } },
      },
    }),
    db.activityLog.findMany({
      where: {
        taskId: task.id,
        kind: {
          in: [
            "task.chat.reply",
            "task.chat.silent",
            "task.chat.dispatch",
            "task.comment",
            "task.comment.silent",
            "task.chat.dispatch_failed",
            "task.comment.dispatch_failed",
            "task.workflow.dispatch_failed",
            "task.chat.stream_error",
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      take: 160,
      select: { kind: true, payload: true, targetAgent: true },
    }),
    // Latest Karen branch-verification row, if any. Used by the Review-state
    // Repo verification panel below.
    db.activityLog.findFirst({
      where: {
        taskId: task.id,
        kind: { in: ["pm.repo.verify.ok", "pm.repo.verify.fail", "pm.repo.verify.enqueue"] },
      },
      orderBy: { createdAt: "desc" },
      select: { kind: true, payload: true, createdAt: true },
    }),
  ]);
  const mentionables = mentionableUsers.map((u) => ({ username: u.username }));
  const settledMessageIds = activityMessageIds(recentReplyActivity);
  const recentCommentMessages = recentTaskChatMessages.filter((message) => (
    message.originChannel === "comment"
    && message.sender.kind !== "agent"
  ));
  const recentCommentRuns = recentCommentMessages.length
    ? await db.pmChannelRun.findMany({
        where: {
          kind: "task-comment",
          taskId: task.id,
          messageId: { in: recentCommentMessages.map((message) => message.id) },
        },
        select: { messageId: true, agentSlug: true, status: true },
      })
    : [];
  const commentRunByTarget = new Map(
    recentCommentRuns.map((run) => [`${run.messageId}:${run.agentSlug}`, run]),
  );
  const pendingCommentMessages = recentCommentMessages
    .filter((message) => shouldRenderPendingCommentMessage({
      task,
      message,
      run: commentRunByTarget.get(`${message.id}:${message.agentSlug}`),
      settledMessageIds,
    }))
    .filter((message, index, all) => all.findIndex((item) => item.agentSlug === message.agentSlug) === index)
    .slice(0, 4);
  const chatMessages = await db.agentChatMessage.findMany({
    where: {
      taskId: task.id,
      agentSlug: "room",
      archiveId: null,
    },
    orderBy: { createdAt: "asc" },
    include: {
      sender: {
        select: {
          id: true,
          username: true,
          kind: true,
          name: true,
          avatarUpdatedAt: true,
          agent: { select: { slug: true, name: true, avatar: true } },
        },
      },
    },
  });
  const pendingProposals = await db.workItemProposal.findMany({
    where: {
      status: "pending",
      projectId: task.projectId,
      grantMessageId: { in: chatMessages.map((m) => m.id) },
    },
    include: {
      project: { select: { name: true } },
    },
  });
  const pendingDescriptionMessages = await db.agentChatMessage.findMany({
    where: {
      taskId: task.id,
      allowDescriptionEdit: true,
      editGrantUsedAt: null,
    },
    select: { id: true },
  });
  const pendingDescMsgIds = pendingDescriptionMessages.map((m) => m.id);
  const runningDescriptionRun = pendingDescMsgIds.length > 0
    ? await db.pmChannelRun.findFirst({
        where: {
          taskId: task.id,
          messageId: { in: pendingDescMsgIds },
          status: { in: ["queued", "accepted", "streaming"] },
        },
        select: { messageId: true, agentSlug: true },
      })
    : null;
  const isAiDescriptionRunning = runningDescriptionRun !== null;

  // Draft is requester-bound — anyone viewing the task other than the
  // human who clicked "Ask AI" sees null. The reaper inside
  // getDescriptionDraft() also returns null for stale drafts
  // (lastSeenAt > 60s ago) so a closed-tab requester doesn't leak
  // their draft into a later session.
  const { getDescriptionDraft } = await import("@/lib/description-drafts");
  const draftDescription = await getDescriptionDraft({
    scope: "task",
    targetId: task.id,
    requesterUserId: viewer.id,
  });

  const [chatArchives, binChatArchives, selectedChatArchive] = await Promise.all([
    db.agentChatRoomArchive.findMany({
      where: { projectId: task.project.id, taskId: task.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        messageCount: true,
      },
    }),
    db.agentChatRoomArchive.findMany({
      where: { projectId: task.project.id, taskId: task.id, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      take: 20,
      select: {
        id: true,
        summary: true,
        startedAt: true,
        endedAt: true,
        messageCount: true,
        deletedAt: true,
      },
    }),
    chatArchive
      ? db.agentChatRoomArchive.findFirst({
          where: { id: chatArchive, projectId: task.project.id, taskId: task.id },
          include: {
            messages: {
              orderBy: { createdAt: "asc" },
              include: {
                sender: {
                  select: {
                    id: true,
                    username: true,
                    kind: true,
                    name: true,
                    avatarUpdatedAt: true,
                    agent: { select: { slug: true, name: true, avatar: true } },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve(null),
  ]);
  const visibleChatMessages = selectedChatArchive?.messages ?? chatMessages;
  const viewingChatArchive = Boolean(selectedChatArchive);
  const selectedChatArchiveDeleted = Boolean(selectedChatArchive?.deletedAt);
  const humanChatMessageIds = chatMessages
    .filter((message) => message.sender.kind !== "agent")
    .map((message) => message.id);
  const completedChatRuns = humanChatMessageIds.length
    ? await db.pmChannelRun.findMany({
        where: {
          kind: "task-chat",
          taskId: task.id,
          messageId: { in: humanChatMessageIds },
          status: "complete",
        },
        select: { messageId: true, agentSlug: true, status: true },
      })
    : [];

  const pendingAgents: Array<{ slug: string; username: string }> = [];
  let pendingChatMessageId: string | null = null;

  if (chatMessages.some((message) => message.sender.kind !== "agent")) {
    const users = await db.user.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        kind: true,
        status: true,
        agent: { select: { slug: true, role: true, deactivatedAt: true, name: true } },
      },
    });

    for (const message of [...chatMessages].reverse()) {
      if (message.sender.kind === "agent") continue;
      const mentions = extractMentions(
        message.body,
        users.map((u) => ({ username: u.username })),
      );
      const targetAgents = new Map<string, { slug: string; username: string }>();
      const addPendingAgent = (u: (typeof users)[number] | null | undefined) => {
        if (
          u &&
          u.kind === "agent" &&
          u.status === "active" &&
          u.agent &&
          !u.agent.deactivatedAt
        ) {
          targetAgents.set(u.agent.slug, {
            slug: u.agent.slug,
            username: u.agent.name || u.username,
          });
        }
      };

      if (message.targetType === "all-coders") {
        for (const u of users) {
          if (u.agent?.role === "coding") addPendingAgent(u);
        }
      } else if (message.targetType === "agent" && message.targetValue?.startsWith("agent:")) {
        const agentSlug = message.targetValue.slice("agent:".length);
        addPendingAgent(users.find((u) => u.agent?.slug === agentSlug));
      } else if (message.targetType === "multi" && message.targetValue) {
        try {
          const targets = JSON.parse(message.targetValue) as unknown;
          if (Array.isArray(targets)) {
            for (const target of targets) {
              if (typeof target !== "string" || !target.startsWith("agent:")) continue;
              const agentSlug = target.slice("agent:".length);
              addPendingAgent(users.find((u) => u.agent?.slug === agentSlug));
            }
          }
        } catch {
          // Ignore malformed historical target payloads.
        }
      } else if (!message.targetType && mentions.length === 0) {
        const candidates = [
          task.actingManager,
          task.assignee,
        ];
        for (const cand of candidates) addPendingAgent(cand);
      }

      for (const u of users) {
        if (mentions.includes(u.username)) {
          addPendingAgent(u);
        }
      }

      const settled = settledAgentSlugsForMessage(recentReplyActivity, message.id, completedChatRuns);
      const stillPending = [...targetAgents.values()].filter((agent) => !settled.has(agent.slug));
      if (stillPending.length > 0) {
        pendingChatMessageId = message.id;
        pendingAgents.push(...stillPending);
        break;
      }
    }
  }

  const discussionTargets = principals.map((p) => ({
    value: p.kind === "agent" && p.agentSlug ? `agent:${p.agentSlug}` : `user:${p.id}`,
    label: p.name,
    group: p.kind === "agent" ? "Agents" as const : "Users" as const,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt,
      agent: p.kind === "agent"
        ? { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar }
        : null,
    },
  }));
  const defaultDiscussionTarget =
    discussionTargetValue(task.actingManager)
    ?? discussionTargetValue(task.assignee)
    ?? null;
  const principalOptions: AvatarComboboxOption[] = principals.map((p) => ({
    value: p.id,
    label: p.name,
    actor: {
      id: p.id,
      username: p.username,
      kind: p.kind,
      name: p.name,
      avatarUpdatedAt: p.avatarUpdatedAt,
      agent: p.kind === "agent"
        ? { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar }
        : null,
    },
  }));
  const reporterOptions = task.reporter && !principals.some((p) => p.id === task.reporterId)
    ? [
        ...principalOptions,
        {
          value: task.reporter.id,
          label: actorDisplayName(serializeActor(task.reporter)!),
          actor: serializeActor(task.reporter),
        },
      ]
      : principalOptions;
  const aiTargetOptions: AvatarComboboxOption[] = principals.flatMap((p) => {
    if (p.kind !== "agent" || !p.agentSlug) return [];
    return [{
      value: `agent:${p.agentSlug}`,
      label: p.name,
      actor: {
        id: p.id,
        username: p.username,
        kind: p.kind,
        name: p.name,
        avatarUpdatedAt: p.avatarUpdatedAt,
        agent: { slug: p.agentSlug, name: p.name, avatar: p.agentAvatar },
      },
    }];
  });
  const defaultAiTarget = [
    discussionTargetValue(task.actingManager),
    discussionTargetValue(task.assignee),
  ].find((value) => Boolean(value?.startsWith("agent:") && aiTargetOptions.some((option) => option.value === value)))
    ?? aiTargetOptions[0]?.value
    ?? "";

  async function reorderSubtasks(orderedIds: string[]): Promise<void> {
    "use server";
    await reorderTasks(orderedIds);
    revalidatePath(`/projects/${slug}/tasks/${taskId}`);
    revalidatePath(`/projects/${slug}`);
  }

  return (
    <div className="mx-auto w-full max-w-none">
      {/* ----- Main column ------------------------------------------- */}
      <div className="min-w-0">
        <section className="space-y-4 rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
          {/* Sticky one-row editor header: title, epic, status and save stay visible. */}
          <div className="sticky top-0 z-10 -mx-5 -mt-5 flex flex-wrap items-end gap-3 rounded-t-2xl border-b border-[var(--color-line)] bg-[var(--color-panel)] px-5 py-2 shadow-sm xl:flex-nowrap">
            <label className="min-w-[18rem] flex-1">
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Task title
              </span>
              <input
                form="taskMain"
                name="title"
                defaultValue={task.title}
                required
                maxLength={200}
                className="h-9 w-full rounded-lg border border-transparent bg-transparent px-2 text-xl font-semibold tracking-tight outline-none transition focus:border-[var(--color-line)] focus:bg-[var(--color-bg)]"
                aria-label="Task title"
              />
            </label>
            <label className="min-w-[12rem] flex-[0_1_16rem]">
              <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Epic
              </span>
              <select
                form="taskMain"
                name="epicId"
                defaultValue={task.epicId ?? ""}
                className="h-9 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 text-xs outline-none focus:border-[var(--color-accent)]"
                aria-label="Epic"
              >
                <option value="">No epic</option>
                {projectEpics.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.title}
                    {e.status !== "Open" ? ` · ${e.status}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="w-32 shrink-0">
              <span className="mb-0.5 block text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Status
              </span>
              <select
                form="taskMain"
                name="status"
                defaultValue={task.status}
                className="h-9 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 text-xs outline-none focus:border-[var(--color-accent)]"
                aria-label="Status"
              >
                {COLUMN_IDS.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex shrink-0 flex-col items-end gap-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                Updated{" "}
                <time dateTime={task.updatedAt.toISOString()} title={task.updatedAt.toISOString()}>
                  {timeAgo(task.updatedAt)}
                </time>
              </span>
              <button
                form="taskMain"
                type="submit"
                className="h-9 rounded-lg bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-bg)] hover:opacity-90"
              >
                Save changes
              </button>
            </div>
          </div>
          {/* Review verification panel — only shown on tasks in Review with
              a branchName set on the task or its epic. Surfaces Karen's
              latest pm.repo.verify.* result so the reviewer doesn't approve
              work that isn't on origin/<branch> yet. */}
          {task.status === "Review" && (task.branchName || task.epic?.branchName) ? (() => {
            const branchName = task.branchName ?? task.epic?.branchName ?? "";
            const commitPrefix = task.commitPrefix ?? task.epic?.commitPrefix ?? null;
            let kind: string | null = latestRepoVerify?.kind ?? null;
            let payload: { headSha?: string | null; matchSha?: string | null; branchName?: string | null; fetchError?: string | null; logError?: string | null } = {};
            try {
              payload = latestRepoVerify?.payload ? JSON.parse(latestRepoVerify.payload) : {};
            } catch { /* ignore */ }
            const tone =
              kind === "pm.repo.verify.ok" ? "ok" :
              kind === "pm.repo.verify.fail" ? "fail" :
              kind === "pm.repo.verify.enqueue" ? "pending" :
              "missing";
            const palette = {
              ok:      { border: "var(--color-line)", bg: "rgba(34,197,94,0.08)",  dot: "#22c55e", title: "✓ origin verified" },
              fail:    { border: "var(--color-line)", bg: "rgba(239,68,68,0.10)",  dot: "#ef4444", title: "⚠ origin not verified" },
              pending: { border: "var(--color-line)", bg: "rgba(59,130,246,0.08)", dot: "#3b82f6", title: "… Karen verifying" },
              missing: { border: "var(--color-line)", bg: "rgba(148,163,184,0.10)", dot: "#94a3b8", title: "Repo verification not yet requested" },
            }[tone];
            return (
              <div
                className="rounded-lg border px-4 py-3 text-sm"
                style={{ borderColor: palette.border, backgroundColor: palette.bg }}
              >
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: palette.dot }} aria-hidden="true" />
                  <strong className="text-[var(--color-text)]">{palette.title}</strong>
                  <span className="ml-auto text-xs text-[var(--color-text-muted)]">
                    branch <code className="text-[var(--color-text)]">{branchName}</code>
                    {commitPrefix ? <> · prefix <code className="text-[var(--color-text)]">{commitPrefix}</code></> : null}
                  </span>
                </div>
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {tone === "ok" && payload.headSha
                    ? <>HEAD <code className="text-[var(--color-text)]">{payload.headSha.slice(0, 10)}</code> matches the COMMIT_PREFIX — safe to review.</>
                    : null}
                  {tone === "fail"
                    ? <>{payload.fetchError ? <>fetch failed: <code className="text-[var(--color-text)]">{payload.fetchError}</code>.</> : null} See the latest <code className="text-[var(--color-text)]">pm.repo.verify.fail</code> comment below. Ask the assignee to push (with the prefix) before reviewing.</>
                    : null}
                  {tone === "pending"
                    ? <>Karen has been asked to verify <code className="text-[var(--color-text)]">origin/{branchName}</code>. The result will appear as a new task comment.</>
                    : null}
                  {tone === "missing"
                    ? <>No <code className="text-[var(--color-text)]">pm.repo.verify.*</code> activity yet — either the task pre-dates the verifier, or the assignee declared <code className="text-[var(--color-text)]">repoTouched: false</code> on ready_for_review.</>
                    : null}
                </div>
              </div>
            );
          })() : null}

          {/* One edit form for the whole card: every control below carries
              form="taskMain" so the single "Save changes" button persists
              Epic, Status, Title, Description, Branch, Commit Prefix,
              Assignee and Reviewer together. The form element itself is
              empty so the tab panels' own forms (sub-task/comment/upload)
              are never nested inside it. */}
          <form id="taskMain" action={updateTask} />
          <input form="taskMain" type="hidden" name="taskId" value={task.id} />
          <input form="taskMain" type="hidden" name="projectSlug" value={slug} />

          {/* Tabbed content */}
          <TabsProvider defaultTab={chatArchive || chatRoom === "current" ? "Discussion" : "Description"}>
            <TabsNav
              tabs={["Description", "Sub-Tasks", "Attachments", "Comments", "Discussion"]}
              sticky
            />
            <div className="pt-4">
              <TabPanel name="Description">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
                  <DescriptionField
                    formId="taskMain"
                    previewHtml={renderFullMarkdown(task.description ?? "").__html}
                    defaultValue={task.description ?? ""}
                    projectSlug={slug}
                    taskId={task.id}
                    aiTargets={aiTargetOptions}
                    defaultAiTarget={defaultAiTarget}
                    descriptionLabel="Task"
                    draftDescription={draftDescription}
                    aiRunning={isAiDescriptionRunning}
                    runningMessageId={runningDescriptionRun?.messageId ?? null}
                    runningAgentSlug={runningDescriptionRun?.agentSlug ?? null}
                    // Sub-tasks (parentTaskId !== null) get a taller editor —
                    // they're where most of the day-to-day work detail lands,
                    // so the larger box matches actual use (HOMELAB-48).
                    rows={task.parentTaskId !== null ? 24 : 12}
                  />

                  <aside className="space-y-4 xl:sticky xl:top-16 xl:self-start">
                    {/* Dates */}
                    <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
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

                    <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Report by
                        </span>
                        <AvatarCombobox
                          formId="taskMain"
                          name="reporterId"
                          defaultValue={task.reporterId ?? ""}
                          options={reporterOptions}
                          emptyLabel="No reporter"
                          ariaLabel="Report by"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Assignee
                        </span>
                        <AvatarCombobox
                          formId="taskMain"
                          name="assigneeId"
                          defaultValue={task.assigneeId ?? ""}
                          options={principalOptions}
                          emptyLabel="Unassigned"
                          ariaLabel="Assignee"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Reviewer
                        </span>
                        <AvatarCombobox
                          formId="taskMain"
                          name="actingManagerId"
                          defaultValue={task.actingManagerId ?? ""}
                          options={principalOptions}
                          emptyLabel="No reviewer"
                          ariaLabel="Reviewer"
                        />
                      </label>
                    </div>

                    {/* Branch + Commit prefix — persisted by the card's single Save. */}
                    <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Branch
                        </span>
                        <input
                          form="taskMain"
                          name="branchName"
                          defaultValue={task.branchName ?? task.epic?.branchName ?? ""}
                          maxLength={200}
                          placeholder="e.g. feature/HOMELAB-99"
                          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--color-accent)]"
                          aria-label="Branch name"
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          Commit prefix
                        </span>
                        <input
                          form="taskMain"
                          name="commitPrefix"
                          defaultValue={task.commitPrefix ?? task.epic?.commitPrefix ?? ""}
                          maxLength={200}
                          placeholder="e.g. HOMELAB-99"
                          className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-xs font-mono outline-none focus:border-[var(--color-accent)]"
                          aria-label="Commit prefix"
                        />
                      </label>
                    </div>

                    {task.epic ? (
                      <Link
                        href={`/projects/${slug}/epics/${task.epic.id}`}
                        className="block rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                      >
                        Open epic →
                      </Link>
                    ) : null}

                    {task.parent ? (
                      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4">
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

                    {/* Danger zone — soft delete moves the task (and any sub-tasks) to
                        the bin for 7 days, then hard-deletes. Its own form, separate
                        from the main edit form. Restore from /projects/<slug>/bin. */}
                    <form
                      action={deleteTask}
                      className="space-y-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-4"
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
              </TabPanel>

              <TabPanel name="Sub-Tasks">
                <div>
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
                </div>
              </TabPanel>

              <TabPanel name="Attachments">
                <div>
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

          <AttachmentUploadFab
            projectSlug={slug}
            taskId={task.id}
            maxLabel={formatBytes(attachmentMaxBytes())}
            uploadAction={uploadAttachment}
          />
                </div>
              </TabPanel>

              <TabPanel name="Comments">
                <div className="flex h-[calc(100dvh-14rem)] min-h-[560px] flex-col">
                  <h2 className="mb-3 text-sm font-semibold tracking-wide text-[var(--color-text)]">
                    Comments
                  </h2>
                  <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {task.comments.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)]">
              No comments yet.
            </p>
          ) : (
            <ul className="space-y-3">
              {task.comments.map((c) => (
                <li
                  key={c.id}
                  className="flex items-start gap-3 text-sm"
                >
                  <MessageAvatar actor={c.user} size="sm" />
                  <div className="min-w-0 flex-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-muted)]">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <strong className="truncate font-medium text-[var(--color-text)]">
                          {actorDisplayName(c.user)}
                        </strong>
                        <MessageTimestamp value={c.createdAt} />
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
                  </div>
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
          {task.comments.length > 0 || pendingCommentMessages.length > 0 ? (
            <AutoScrollToLatest
              whenTab="Comments"
              watchKey={[
                task.comments.length,
                task.comments.at(-1)?.id ?? "",
                pendingCommentMessages.map((message) => message.id).join(","),
              ].join(":")}
            />
          ) : null}
                  </div>

          <CommentComposerFab
            projectSlug={slug}
            taskId={task.id}
            action={createComment}
            title="Task Comment"
            placeholder="Write a comment — **markdown** and @mentions supported"
          />
                </div>
              </TabPanel>

              <TabPanel name="Discussion">
                <div className="pt-2">
                  <ChatRoom
                    projectSlug={slug}
                    taskId={task.id}
                    messages={visibleChatMessages}
                    activeMessageCount={chatMessages.length}
                    archives={chatArchives}
                    binArchives={binChatArchives}
                    selectedArchiveId={selectedChatArchive?.id ?? null}
                    selectedArchiveDeleted={selectedChatArchiveDeleted}
                    viewingArchive={viewingChatArchive}
                    discussionTargets={discussionTargets}
                    defaultDiscussionTarget={defaultDiscussionTarget}
                    pendingAgents={pendingAgents}
                    latestMessageId={viewingChatArchive ? null : pendingChatMessageId}
                    currentUserId={viewer.id}
                    pendingProposals={pendingProposals}
                  />
                </div>
              </TabPanel>
            </div>
          </TabsProvider>
        </section>
      </div>
    </div>
  );
}
