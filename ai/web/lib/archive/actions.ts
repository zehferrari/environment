"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { revalidateTaskShell } from "@/lib/tasks/cache";

async function requireActor() {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  return { id };
}

export async function archiveTask(formData: FormData) {
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const projectSlug = String(formData.get("projectSlug") ?? "");
  if (!taskId || !projectSlug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      archivedAt: true,
      deletedAt: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.deletedAt || task.project.slug !== projectSlug || task.archivedAt) return;

  const archivedAt = new Date();
  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: { archivedAt, archivedById: actor.id },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor.id,
        kind: "task.archive",
        payload: JSON.stringify({ taskId: task.id, title: task.title, archivedAt: archivedAt.toISOString() }),
      },
    }),
  ]);

  revalidateTaskShell(task.id);
  revalidatePath(`/projects/${projectSlug}`);
  revalidatePath(`/projects/${projectSlug}/tasks`);
  revalidatePath(`/projects/${projectSlug}/tasks/${task.id}`);
}

export async function unarchiveTask(formData: FormData) {
  const actor = await requireActor();
  const taskId = String(formData.get("taskId") ?? "");
  const projectSlug = String(formData.get("projectSlug") ?? "");
  if (!taskId || !projectSlug) return;

  const task = await db.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      projectId: true,
      archivedAt: true,
      deletedAt: true,
      project: { select: { slug: true } },
    },
  });
  if (!task || task.deletedAt || task.project.slug !== projectSlug || !task.archivedAt) return;

  await db.$transaction([
    db.task.update({
      where: { id: task.id },
      data: { archivedAt: null, archivedById: null },
    }),
    db.activityLog.create({
      data: {
        projectId: task.projectId,
        taskId: task.id,
        userId: actor.id,
        kind: "task.unarchive",
        payload: JSON.stringify({ taskId: task.id, title: task.title }),
      },
    }),
  ]);

  revalidateTaskShell(task.id);
  revalidatePath(`/projects/${projectSlug}`);
  revalidatePath(`/projects/${projectSlug}/tasks`);
  revalidatePath(`/projects/${projectSlug}/tasks/${task.id}`);
}

export async function archiveEpic(formData: FormData) {
  const actor = await requireActor();
  const epicId = String(formData.get("epicId") ?? "");
  const projectSlug = String(formData.get("projectSlug") ?? "");
  if (!epicId || !projectSlug) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      title: true,
      projectId: true,
      archivedAt: true,
      deletedAt: true,
      project: { select: { slug: true } },
    },
  });
  if (!epic || epic.deletedAt || epic.project.slug !== projectSlug || epic.archivedAt) return;

  const archivedAt = new Date();
  await db.$transaction([
    db.epic.update({
      where: { id: epic.id },
      data: { archivedAt, archivedById: actor.id },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: actor.id,
        kind: "epic.archive",
        payload: JSON.stringify({ epicId: epic.id, title: epic.title, archivedAt: archivedAt.toISOString() }),
      },
    }),
  ]);

  revalidatePath(`/projects/${projectSlug}`);
  revalidatePath(`/projects/${projectSlug}/epics`);
  revalidatePath(`/projects/${projectSlug}/epics/${epic.id}`);
}

export async function unarchiveEpic(formData: FormData) {
  const actor = await requireActor();
  const epicId = String(formData.get("epicId") ?? "");
  const projectSlug = String(formData.get("projectSlug") ?? "");
  if (!epicId || !projectSlug) return;

  const epic = await db.epic.findUnique({
    where: { id: epicId },
    select: {
      id: true,
      title: true,
      projectId: true,
      archivedAt: true,
      deletedAt: true,
      project: { select: { slug: true } },
    },
  });
  if (!epic || epic.deletedAt || epic.project.slug !== projectSlug || !epic.archivedAt) return;

  await db.$transaction([
    db.epic.update({
      where: { id: epic.id },
      data: { archivedAt: null, archivedById: null },
    }),
    db.activityLog.create({
      data: {
        projectId: epic.projectId,
        userId: actor.id,
        kind: "epic.unarchive",
        payload: JSON.stringify({ epicId: epic.id, title: epic.title }),
      },
    }),
  ]);

  revalidatePath(`/projects/${projectSlug}`);
  revalidatePath(`/projects/${projectSlug}/epics`);
  revalidatePath(`/projects/${projectSlug}/epics/${epic.id}`);
}
