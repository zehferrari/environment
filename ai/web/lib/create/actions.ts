"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  accessibleEpicWhere,
  assertAgentAssignmentAllowed,
  requireOwner,
  requireProjectAccess,
  requireTaskAccess,
  requireViewer,
} from "@/lib/auth/permissions";
import { allocateWorkItemKey, normalizeWorkItemKeyPrefix } from "@/lib/work-items/keys";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { randomBoardColor } from "@/lib/board-colors";
import {
  sendTaskCommentNotifications,
  sendTaskWorkflowNotification,
} from "@/lib/agents/workflow/notifications/task";
import { extractMentions } from "@/lib/markdown";
import { revalidateTaskReplyScope } from "@/lib/tasks/cache";
import { createWorkspace } from "@/lib/workspaces/service";
import { uploadAttachment } from "@/lib/attachments/actions";
import type { CreateResult } from "@/lib/create/result";

// Unified create-FAB server actions. Each reads a FormData, does the same auth +
// validation + persistence the old per-page flows did, then RETURNS a
// CreateResult (message + href) instead of redirecting — the FAB shows a toast
// and the page revalidates in place. The Epic action lives in lib/epics/actions
// (it already returns CreateResult) and the FAB imports it directly from there.

// ---- Task -----------------------------------------------------------------
// Faithful port of the former inline createTask (projects/[slug]/page.tsx):
// same role gating, epic scoping, work-item numbering, and assignee/reviewer
// notifications — only the terminal void is replaced by a CreateResult.
export async function createTaskFromFab(formData: FormData): Promise<CreateResult> {
  const actor = await requireViewer();
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!projectId || !title) return { ok: false, error: "A task title and project are required." };
  if (title.length > 200) return { ok: false, error: "Task title must be 200 characters or fewer." };
  const projectSlug = String(formData.get("projectSlug") ?? "");
  const description = String(formData.get("description") ?? "").trim() || null;
  const epicRaw = String(formData.get("epicId") ?? "");
  if (
    !actor.isOwner &&
    (formData.has("reporterId") || formData.has("assigneeId") || formData.has("actingManagerId"))
  ) {
    throw new Error("Only the Mission Control owner can set task roles.");
  }
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const reviewerRaw = String(formData.get("actingManagerId") ?? "");
  if (formData.has("private") && !actor.isOwner) throw new Error("Not authorized");
  const isPrivate = actor.isOwner && formData.get("private") === "on";

  const maxRank = await db.task.aggregate({
    where: { projectId, status: "Backlog", archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });

  let epicId: string | null = epicRaw === "" ? null : epicRaw;
  if (epicId) {
    const epic = await db.epic.findFirst({
      where: accessibleEpicWhere(actor, { id: epicId, projectId, archivedAt: null, deletedAt: null }),
      select: { id: true },
    });
    if (!epic) epicId = null;
  }
  const taskTitle = epicId ? await nextEpicTaskTitle(epicId, title) : title;

  const assigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const actingManagerId = reviewerRaw === "" ? null : reviewerRaw;
  await requireProjectAccess(actor, { id: projectId });
  await assertAgentAssignmentAllowed(actor, [assigneeId, actingManagerId]);

  const task = await db.task.create({
    data: {
      projectId,
      workItemKey: await allocateWorkItemKey(projectId),
      title: taskTitle,
      description,
      private: isPrivate,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      epicId,
      assigneeId,
      actingManagerId,
      reporterId: actor.id,
      branchName: null,
      commitPrefix: null,
    },
    select: { id: true, title: true },
  });

  await db.activityLog.create({
    data: {
      projectId,
      taskId: task.id,
      userId: actor.id,
      kind: "task.create",
      payload: JSON.stringify({ title: task.title, epicId }),
    },
  });

  if (assigneeId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: assigneeId,
      actor,
      reason: "backlog_plan_requested",
      body: [
        `You have been assigned to "${task.title}" while it is in Backlog.`,
        "Read the full task context and existing comments. Post one concise technical implementation plan in Action Plan.",
        "Do not change task status and do not start work until the task is moved to To Do.",
      ].join("\n"),
    });
  }
  if (actingManagerId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: actingManagerId,
      actor,
      reason: "reviewer_plan_requested",
      body: [
        `You have been set as Reviewer for "${task.title}".`,
        "If the task has no assignee, read the full task context and post one reviewer plan of action in Action Plan, including the subtasks/topics/items that must be addressed or watched.",
        "Do not start implementation or move status. After the reporter approves the plan, call action=assign_after_plan_approval so PM can assign an eligible coding agent and move Backlog to To Do if needed.",
      ].join("\n"),
    });
  }

  revalidatePath(`/projects/${projectSlug}`);
  return {
    ok: true,
    message: `Task "${task.title}" created`,
    href: `/projects/${projectSlug}/tasks/${task.id}`,
  };
}

// ---- Project ---------------------------------------------------------------
// Faithful port of the former inline createProject (projects/page.tsx).
export async function createProjectFromFab(formData: FormData): Promise<CreateResult> {
  try {
    await requireOwner();
    const name = String(formData.get("name") ?? "").trim();
    if (!name || name.length > 200) throw new Error("Project name is required and must be 200 characters or fewer.");
    const description = String(formData.get("description") ?? "").trim() || null;
    const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
    if (!slug || !/^[a-zA-Z0-9\-_]+$/.test(slug)) {
      throw new Error("Project slug is required and may only contain letters, numbers, hyphens, and underscores.");
    }
    const workspaceId = String(formData.get("workspaceId") ?? "").trim();
    const workspace = workspaceId
      ? await db.workspace.findFirst({ where: { id: workspaceId, archivedAt: null }, select: { id: true, slug: true } })
      : null;
    if (!workspace) throw new Error("Choose an active workspace for this project.");

    const repositoryPath = String(formData.get("repositoryPath") ?? "").trim();
    if (!repositoryPath) throw new Error("Repository folder is required.");
    const workItemKeyPrefix = normalizeWorkItemKeyPrefix(String(formData.get("workItemKeyPrefix") ?? "").trim());
    if (!workItemKeyPrefix) {
      throw new Error("Project key must start with a letter and contain only 2-10 letters or numbers.");
    }
    const defaultGitUserName = String(formData.get("defaultGitUserName") ?? "").trim() || null;
    const defaultGitUserEmail = String(formData.get("defaultGitUserEmail") ?? "").trim() || null;
    const defaultAssigneeId = String(formData.get("defaultAssigneeId") ?? "").trim() || null;
    const defaultReviewerId = String(formData.get("defaultReviewerId") ?? "").trim() || null;
    const doneTtlRaw = String(formData.get("doneTtlDays") ?? "").trim();
    const doneTtlDays = doneTtlRaw === "" ? null : Math.max(1, Math.min(365, Number(doneTtlRaw) || 5));

    if (await db.project.findUnique({ where: { slug }, select: { id: true } })) {
      throw new Error("Project slug is already in use.");
    }
    if (await db.project.findUnique({ where: { workItemKeyPrefix }, select: { id: true } })) {
      throw new Error("Project key is already in use.");
    }

    const project = await db.project.create({
      data: {
        slug,
        name,
        description,
        repositoryPath,
        workItemKeyPrefix,
        defaultGitUserName,
        defaultGitUserEmail,
        defaultAssigneeId,
        defaultReviewerId,
        doneTtlDays,
        backgroundColor: randomBoardColor(),
        workspaces: { create: { workspaceId: workspace.id } },
      },
      select: { slug: true, name: true },
    });

    revalidatePath("/");
    revalidatePath("/projects");
    revalidatePath("/workspaces");
    revalidatePath(`/workspaces/${workspace.slug}`);
    return { ok: true, message: `Project "${project.name}" created`, href: `/projects/${project.slug}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Project could not be created." };
  }
}

// ---- Workspace -------------------------------------------------------------
export async function createWorkspaceFromFab(formData: FormData): Promise<CreateResult> {
  try {
    await requireOwner();
    const workspace = await createWorkspace({
      name: formData.get("name"),
      slug: formData.get("slug"),
      type: formData.get("type"),
      description: formData.get("description"),
    });
    revalidatePath("/workspaces");
    revalidatePath("/");
    return { ok: true, message: `Workspace "${workspace.name}" created`, href: `/workspaces/${workspace.slug}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Workspace could not be created." };
  }
}

// ---- Attachment ------------------------------------------------------------
export async function uploadAttachmentFromFab(formData: FormData): Promise<CreateResult> {
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const fileCount = [...formData.getAll("files"), ...formData.getAll("file")].filter(
    (f) => f instanceof File && f.size > 0,
  ).length;

  await uploadAttachment(formData);

  const href = taskId
    ? `/projects/${slug}/tasks/${taskId}`
    : epicId
      ? `/projects/${slug}/epics/${epicId}`
      : `/projects/${slug}/library`;
  return {
    ok: true,
    message: fileCount === 1 ? "Attachment uploaded" : `${fileCount} attachments uploaded`,
    href,
  };
}

// ---- Comment ---------------------------------------------------------------
// Faithful port of the task page's inline createComment (mentions + owner
// notifications) and the epic createEpicComment, unified so the create FAB can
// post a comment onto either a task or an epic and return a CreateResult. The
// target (taskId XOR epicId) is chosen by the FAB's "On" picker.
export async function postCommentFromFab(formData: FormData): Promise<CreateResult> {
  const actor = await requireViewer();
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!slug || (!taskId && !epicId)) return { ok: false, error: "Choose a task or epic to comment on." };
  if (!body) return { ok: false, error: "Write a comment first." };
  if (body.length > 8000) return { ok: false, error: "Comment must be 8000 characters or fewer." };

  if (taskId) {
    await requireTaskAccess(actor, taskId);
    const task = await db.task.findUnique({
      where: { id: taskId },
      select: { id: true, projectId: true, title: true, project: { select: { slug: true } } },
    });
    if (!task || task.project.slug !== slug) return { ok: false, error: "Task not found." };
    await requireProjectAccess(actor, { id: task.projectId });

    const users = await db.user.findMany({ select: { id: true, username: true } });
    const mentions = extractMentions(body, users.map((u) => ({ username: u.username })));

    const comment = await db.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: { taskId, userId: actor.id, body },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId,
          userId: actor.id,
          kind: "task.comment",
          payload: mentions.length > 0 ? JSON.stringify({ mentions }) : null,
        },
      });
      return created;
    });

    revalidateTaskReplyScope(taskId, "comment");
    if (actor.isOwner) {
      await sendTaskCommentNotifications({
        taskId: task.id,
        commentId: comment.id,
        body,
        actor: { id: actor.id, kind: actor.kind, username: actor.username },
      });
    }
    return { ok: true, message: `Comment added to "${task.title}"`, href: `/projects/${slug}/tasks/${taskId}` };
  }

  const epic = await db.epic.findFirst({
    where: accessibleEpicWhere(actor, { id: epicId }),
    select: { id: true, projectId: true, title: true, deletedAt: true, project: { select: { slug: true } } },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) return { ok: false, error: "Epic not found." };
  await requireProjectAccess(actor, { id: epic.projectId });

  await db.$transaction([
    db.comment.create({ data: { epicId, userId: actor.id, body } }),
    db.activityLog.create({
      data: { projectId: epic.projectId, userId: actor.id, kind: "epic.comment", payload: JSON.stringify({ epicId }) },
    }),
  ]);
  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  return { ok: true, message: `Comment added to "${epic.title}"`, href: `/projects/${slug}/epics/${epicId}` };
}
