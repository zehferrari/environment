"use server";

// Attachment server actions (HOMELAB-47).
//
// Wire-side glue between the form upload, the lib/attachments
// filesystem helper, and the Attachment DB row. Attachments may target a
// Task, an Epic, or the Project itself (neither scoped id); setting both
// scoped ids is rejected before any I/O. Files are content-addressed;
// metadata rows can outnumber on-disk blobs when the same bytes are uploaded
// twice.

import { revalidatePath } from "next/cache";
import {
  requireEpicAccess,
  requireProjectAccess,
  requireTaskAccess,
  requireViewer,
} from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import {
  assertOneTarget,
  attachmentMaxBytes,
  deleteAttachmentFile,
  writeAttachment,
} from "@/lib/attachments/storage";
import { normalizeAttachmentMimeType } from "@/lib/attachments/mime";
import { revalidateTaskAttachments } from "@/lib/tasks/cache";

function uploadedFiles(formData: FormData): File[] {
  return [...formData.getAll("files"), ...formData.getAll("file")].filter(
    (entry): entry is File => entry instanceof File && entry.size > 0,
  );
}

export async function uploadAttachment(formData: FormData) {
  const actor = await requireViewer();
  const slug = String(formData.get("projectSlug") ?? "");
  const taskIdRaw = String(formData.get("taskId") ?? "");
  const epicIdRaw = String(formData.get("epicId") ?? "");
  const taskId = taskIdRaw === "" ? null : taskIdRaw;
  const epicId = epicIdRaw === "" ? null : epicIdRaw;
  const files = uploadedFiles(formData);
  if (!slug) throw new Error("Missing project slug");
  if (files.length === 0) throw new Error("No files were selected to upload");
  await requireProjectAccess(actor, { slug });

  const project = await db.project.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!project) throw new Error(`Unknown project: ${slug}`);

  assertOneTarget({ projectId: project.id, taskId, epicId });
  if (taskId) await requireTaskAccess(actor, taskId);
  if (epicId) await requireEpicAccess(actor, epicId);

  // Scope-check the target lives in the same project as the slug.
  if (taskId) {
    const t = await db.task.findUnique({
      where: { id: taskId },
      select: { projectId: true, title: true },
    });
    if (!t || t.projectId !== project.id) {
      throw new Error("Task does not belong to this project");
    }
  } else if (epicId) {
    const e = await db.epic.findUnique({
      where: { id: epicId },
      select: { projectId: true, title: true },
    });
    if (!e || e.projectId !== project.id) {
      throw new Error("Epic does not belong to this project");
    }
  }

  const maxBytes = attachmentMaxBytes();
  for (const file of files) {
    if (file.size > maxBytes) {
      throw new Error(
        `Attachment exceeds size cap (${file.name}: ${file.size} > ${maxBytes})`,
      );
    }
  }

  for (const file of files) {
    const filename = file.name || "attachment";
    const mimeType = normalizeAttachmentMimeType(filename, file.type);
    const buffer = Buffer.from(await file.arrayBuffer());
    let written;
    try {
      written = await writeAttachment({
        projectId: project.id,
        filename,
        mimeType,
        data: buffer,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        throw new Error(
          `Cannot write attachment "${filename}" — the storage directory is not writable by the server (${code}). Check permissions on the attachment root.`,
        );
      }
      throw err;
    }

    const row = await db.attachment.create({
      data: {
        projectId: project.id,
        taskId,
        epicId,
        uploaderId: actor.id,
        filename,
        storagePath: written.storagePath,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
      },
      select: { id: true },
    });

    await db.activityLog.create({
      data: {
        projectId: project.id,
        taskId,
        userId: actor.id,
        kind: taskId
          ? "task.attachment.add"
          : epicId
            ? "epic.attachment.add"
            : "project.attachment.add",
        payload: JSON.stringify({
          attachmentId: row.id,
          filename,
          sizeBytes: written.sizeBytes,
          sha256: written.sha256,
        }),
      },
    });
  }

  if (taskId) {
    revalidateTaskAttachments(taskId);
  }
  if (epicId) {
    revalidatePath(`/projects/${slug}/epics/${epicId}`);
  }
  revalidatePath(`/projects/${slug}/library`);
  revalidatePath(`/projects/${slug}`);
}

export async function deleteAttachment(formData: FormData) {
  const actor = await requireViewer();
  const slug = String(formData.get("projectSlug") ?? "");
  const attachmentId = String(formData.get("attachmentId") ?? "");
  if (!slug || !attachmentId) return;
  await requireProjectAccess(actor, { slug });

  const row = await db.attachment.findUnique({
    where: { id: attachmentId },
    include: { project: { select: { slug: true } } },
  });
  if (!row || row.project.slug !== slug) return;
  if (row.taskId) await requireTaskAccess(actor, row.taskId);
  if (row.epicId) await requireEpicAccess(actor, row.epicId);

  const otherRefs = await db.attachment.count({
    where: { storagePath: row.storagePath, id: { not: row.id } },
  });

  await db.$transaction([
    db.attachment.delete({ where: { id: attachmentId } }),
    db.activityLog.create({
      data: {
        projectId: row.projectId,
        taskId: row.taskId,
        userId: actor.id,
        kind: row.taskId
          ? "task.attachment.delete"
          : row.epicId
            ? "epic.attachment.delete"
            : "project.attachment.delete",
        payload: JSON.stringify({
          attachmentId,
          filename: row.filename,
        }),
      },
    }),
  ]);

  await deleteAttachmentFile({
    storagePath: row.storagePath,
    otherRefs,
  });

  if (row.taskId) {
    revalidateTaskAttachments(row.taskId);
  }
  if (row.epicId) {
    revalidatePath(`/projects/${slug}/epics/${row.epicId}`);
  }
  revalidatePath(`/projects/${slug}/library`);
  revalidatePath(`/projects/${slug}`);
}
