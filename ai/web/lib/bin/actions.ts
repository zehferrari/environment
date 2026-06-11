"use server";

// Soft-delete + restore server actions (HOMELAB-48).
//
// Delete cascades: an Epic delete soft-deletes all of its non-deleted
// Tasks (and through them their non-deleted sub-tasks). A Task delete
// soft-deletes its non-deleted sub-tasks. Soft-deleted rows are hidden
// from every active read by a `deletedAt: null` filter. The hourly
// purge job in instrumentation.node.ts hard-deletes anything past the
// 7-day TTL.
//
// Restore is per-row by default. The bin UI offers an optional
// "restore children too" path: when an Epic or parent Task was deleted
// as a cascade, the children share the parent's deletedAt timestamp,
// so we can pick them out by exact timestamp match. Anything deleted
// independently before or after has a different timestamp and stays
// in the bin.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { deleteAttachmentFile } from "@/lib/attachments/storage";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { cleanupEpicGitRefs } from "@/lib/bin/git-cleanup";

async function requireActorId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  return id;
}

// ---- Delete --------------------------------------------------------

export async function binTask(formData: FormData): Promise<void> {
  const actorId = await requireActorId();
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  if (!slug || !taskId) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    include: {
      project: { select: { slug: true } },
      subtasks: { where: { deletedAt: null }, select: { id: true } },
    },
  });
  if (!task || task.project.slug !== slug || task.deletedAt) return;

  const now = new Date();
  const subtaskIds = task.subtasks.map((s) => s.id);

  await db.$transaction([
    db.task.updateMany({
      where: { id: { in: [taskId, ...subtaskIds] }, deletedAt: null },
      data: { deletedAt: now, deletedById: actorId },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actorId,
        kind: "task.delete",
        payload: JSON.stringify({
          cascadedSubtaskIds: subtaskIds,
          deletedAt: now.toISOString(),
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/bin`);
  if (task.epicId) revalidatePath(`/projects/${slug}/epics/${task.epicId}`);
  publishBoardTouch(task.projectId);
}

export async function deleteTask(formData: FormData) {
  const slug = String(formData.get("projectSlug") ?? "");
  await binTask(formData);
  if (!slug) return;

  // The task page we were on now points at a binned task — send the user
  // back to the board. redirect() throws NEXT_REDIRECT, so it must come
  // after all DB work + revalidation.
  redirect(`/projects/${slug}`);
}

export async function binEpic(formData: FormData): Promise<void> {
  const actorId = await requireActorId();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  if (!slug || !epicId) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    include: {
      project: { select: { slug: true } },
      tasks: {
        where: { deletedAt: null },
        include: { subtasks: { where: { deletedAt: null }, select: { id: true } } },
      },
    },
  });
  if (!epic || epic.project.slug !== slug || epic.deletedAt) return;

  const now = new Date();
  const taskIds = epic.tasks.map((t) => t.id);
  const subtaskIds = epic.tasks.flatMap((t) => t.subtasks.map((s) => s.id));
  const allTaskIds = [...taskIds, ...subtaskIds];

  await db.$transaction([
    db.epic.update({
      where: { id: epicId },
      data: { deletedAt: now, deletedById: actorId },
    }),
    db.task.updateMany({
      where: { id: { in: allTaskIds }, deletedAt: null },
      data: { deletedAt: now, deletedById: actorId },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: actorId,
        kind: "epic.delete",
        payload: JSON.stringify({
          epicId,
          cascadedTaskIds: allTaskIds,
          deletedAt: now.toISOString(),
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/epics`);
  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}/bin`);
}

export async function deleteEpic(formData: FormData) {
  const slug = String(formData.get("projectSlug") ?? "");
  await binEpic(formData);
  if (!slug) return;

  // Back to the board — the epic page we were on is now binned.
  redirect(`/projects/${slug}`);
}

// ---- Restore -------------------------------------------------------

export async function restoreTask(formData: FormData) {
  const actorId = await requireActorId();
  const slug = String(formData.get("projectSlug") ?? "");
  const taskId = String(formData.get("taskId") ?? "");
  const withChildren = formData.get("withChildren") === "true";
  if (!slug || !taskId) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    include: { project: { select: { slug: true } } },
  });
  if (!task || task.project.slug !== slug || !task.deletedAt) return;

  const cascadeTs = task.deletedAt;
  let restoredChildren: string[] = [];

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: taskId },
      data: { deletedAt: null, deletedById: null },
    });
    if (withChildren) {
      const children = await tx.task.findMany({
        where: {
          parentTaskId: taskId,
          deletedAt: cascadeTs, // exact match — children of THIS delete
        },
        select: { id: true },
      });
      restoredChildren = children.map((c) => c.id);
      if (restoredChildren.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: restoredChildren } },
          data: { deletedAt: null, deletedById: null },
        });
      }
    }
    await tx.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId,
        userId: actorId,
        kind: "task.restore",
        payload: JSON.stringify({ restoredChildren, withChildren }),
      },
    });
  });

  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/bin`);
  revalidatePath(`/projects/${slug}/tasks/${taskId}`);
}

export async function restoreEpic(formData: FormData) {
  const actorId = await requireActorId();
  const slug = String(formData.get("projectSlug") ?? "");
  const epicId = String(formData.get("epicId") ?? "");
  const withChildren = formData.get("withChildren") === "true";
  if (!slug || !epicId) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    include: { project: { select: { slug: true } } },
  });
  if (!epic || epic.project.slug !== slug || !epic.deletedAt) return;

  const cascadeTs = epic.deletedAt;
  let restoredTasks: string[] = [];

  await db.$transaction(async (tx) => {
    await tx.epic.update({
      where: { id: epicId },
      data: { deletedAt: null, deletedById: null },
    });
    if (withChildren) {
      const tasks = await tx.task.findMany({
        where: { epicId, deletedAt: cascadeTs },
        select: { id: true },
      });
      restoredTasks = tasks.map((t) => t.id);
      if (restoredTasks.length > 0) {
        await tx.task.updateMany({
          where: { id: { in: restoredTasks } },
          data: { deletedAt: null, deletedById: null },
        });
        // Also lift sub-tasks of restored tasks that were part of this
        // same cascade. Parent restore implies the entire chain.
        await tx.task.updateMany({
          where: {
            parentTaskId: { in: restoredTasks },
            deletedAt: cascadeTs,
          },
          data: { deletedAt: null, deletedById: null },
        });
      }
    }
    await tx.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: actorId,
        kind: "epic.restore",
        payload: JSON.stringify({ epicId, restoredTasks, withChildren }),
      },
    });
  });

  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/epics`);
  revalidatePath(`/projects/${slug}/epics/${epicId}`);
  revalidatePath(`/projects/${slug}/bin`);
}

// ---- Manual purge --------------------------------------------------

export async function emptyProjectBin(formData: FormData) {
  const actorId = await requireActorId();
  const slug = String(formData.get("projectSlug") ?? "");
  if (!slug) return;

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true, slug: true, repositoryPath: true },
  });
  if (!project) return;

  const [deletedEpics, deletedTasks] = await Promise.all([
    db.epic.findMany({
      where: { projectId: project.id, deletedAt: { not: null } },
      select: { id: true, branchName: true },
    }),
    db.task.findMany({
      where: { projectId: project.id, deletedAt: { not: null } },
      select: { id: true },
    }),
  ]);
  const epicIds = deletedEpics.map((epic) => epic.id);
  const taskIds = deletedTasks.map((task) => task.id);
  if (epicIds.length === 0 && taskIds.length === 0) return;

  const attachmentsAtRisk = await db.attachment.findMany({
    where: {
      projectId: project.id,
      OR: [
        epicIds.length ? { epicId: { in: epicIds } } : undefined,
        taskIds.length ? { taskId: { in: taskIds } } : undefined,
      ].filter(Boolean) as object[],
    },
    select: { storagePath: true },
  });

  const result = {
    purgedEpics: 0,
    purgedTasks: 0,
    removedBlobs: 0,
    errors: [] as string[],
    gitCleanup: { cleaned: [] as string[], skipped: [] as string[], errors: [] as string[] },
    manual: true,
  };

  try {
    await db.$transaction(async (tx) => {
      if (epicIds.length > 0) {
        await tx.epic.deleteMany({ where: { id: { in: epicIds } } });
      }
      if (taskIds.length > 0) {
        await tx.task.deleteMany({ where: { id: { in: taskIds } } });
      }
    });
    result.purgedEpics = epicIds.length;
    result.purgedTasks = taskIds.length;
  } catch (err) {
    result.errors.push(`project bin empty: ${(err as Error).message}`);
  }

  if (result.errors.length === 0 && epicIds.length > 0) {
    result.gitCleanup = await cleanupEpicGitRefs({
      repositoryPath: project.repositoryPath,
      branches: deletedEpics.map((epic) => epic.branchName),
    });
    result.errors.push(...result.gitCleanup.errors.map((msg) => `git cleanup: ${msg}`));
  }

  if (result.errors.length === 0) {
    const seenPath = new Set<string>();
    for (const attachment of attachmentsAtRisk) {
      if (seenPath.has(attachment.storagePath)) continue;
      seenPath.add(attachment.storagePath);
      const stillRef = await db.attachment.count({
        where: { storagePath: attachment.storagePath },
      });
      if (stillRef === 0) {
        try {
          await deleteAttachmentFile({ storagePath: attachment.storagePath, otherRefs: 0 });
          result.removedBlobs += 1;
        } catch (err) {
          result.errors.push(`blob ${attachment.storagePath}: ${(err as Error).message}`);
        }
      }
    }
  }

  await db.activityLog
    .create({
      data: {
        projectId: project.id,
        userId: actorId,
        kind: "bin.purge",
        payload: JSON.stringify(result),
      },
    })
    .catch((err) => {
      result.errors.push(`audit: ${(err as Error).message}`);
    });

  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/epics`);
  revalidatePath(`/projects/${slug}/bin`);
}

export async function bulkBinTasks(taskIds: string[], slug: string): Promise<void> {
  const actorId = await requireActorId();
  if (!slug || !taskIds || taskIds.length === 0) return;

  const tasks = await db.task.findMany({
    where: { id: { in: taskIds }, project: { slug } },
    include: {
      subtasks: { where: { deletedAt: null }, select: { id: true } },
    },
  });
  if (tasks.length === 0) return;

  const now = new Date();
  const allSubtaskIds = tasks.flatMap((t) => t.subtasks.map((s) => s.id));
  const idsToBin = Array.from(new Set([...tasks.map((t) => t.id), ...allSubtaskIds]));

  await db.$transaction([
    db.task.updateMany({
      where: { id: { in: idsToBin }, deletedAt: null },
      data: { deletedAt: now, deletedById: actorId },
    }),
    db.activityLog.create({
      data: {
        projectId: tasks[0].projectId,
        userId: actorId,
        kind: "task.delete",
        payload: JSON.stringify({
          bulkIds: tasks.map((t) => t.id),
          cascadedSubtaskIds: allSubtaskIds,
          deletedAt: now.toISOString(),
        }),
      },
    }),
  ]);

  revalidatePath(`/projects/${slug}`);
  revalidatePath(`/projects/${slug}/bin`);

  const epicIds = Array.from(new Set(tasks.map((t) => t.epicId).filter(Boolean) as string[]));
  for (const epicId of epicIds) {
    revalidatePath(`/projects/${slug}/epics/${epicId}`);
  }
  publishBoardTouch(tasks[0].projectId);
}
