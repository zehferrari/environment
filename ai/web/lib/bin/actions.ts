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
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

async function requireActorId(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  return id;
}

// ---- Delete --------------------------------------------------------

export async function deleteTask(formData: FormData) {
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
}

export async function deleteEpic(formData: FormData) {
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
  revalidatePath(`/projects/${slug}/bin`);
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
