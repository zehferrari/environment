import { db } from "@/lib/db";
import { normalizeAttachmentMimeType } from "@/lib/attachments/mime";
import { attachmentMaxBytes, writeAttachment } from "@/lib/attachments/storage";

export type StoredAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: Date;
};

/** Shared persistence boundary for browser and scoped agent uploads. */
export async function storeAttachment(params: {
  projectId: string;
  taskId: string | null;
  epicId: string | null;
  uploaderId: string;
  filename: string;
  declaredMimeType?: string | null;
  data: Buffer;
}): Promise<StoredAttachment> {
  const filename = params.filename.trim() || "attachment";
  const maxBytes = attachmentMaxBytes();
  if (params.data.byteLength === 0) throw new Error("Attachment is empty");
  if (params.data.byteLength > maxBytes) {
    throw new Error(`Attachment exceeds size cap (${params.data.byteLength} > ${maxBytes})`);
  }
  const mimeType = normalizeAttachmentMimeType(filename, params.declaredMimeType ?? "");
  let written;
  try {
    written = await writeAttachment({ projectId: params.projectId, filename, mimeType, data: params.data });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Cannot write attachment "${filename}" — attachment storage is not writable (${code}).`);
    }
    throw error;
  }

  return db.$transaction(async (tx) => {
    const row = await tx.attachment.create({
      data: {
        projectId: params.projectId,
        taskId: params.taskId,
        epicId: params.epicId,
        uploaderId: params.uploaderId,
        filename,
        storagePath: written.storagePath,
        mimeType: written.mimeType,
        sizeBytes: written.sizeBytes,
        sha256: written.sha256,
      },
      select: { id: true, filename: true, mimeType: true, sizeBytes: true, sha256: true, createdAt: true },
    });
    await tx.activityLog.create({
      data: {
        projectId: params.projectId,
        taskId: params.taskId,
        userId: params.uploaderId,
        kind: params.taskId ? "task.attachment.add" : params.epicId ? "epic.attachment.add" : "project.attachment.add",
        payload: JSON.stringify({
          attachmentId: row.id,
          filename: row.filename,
          sizeBytes: row.sizeBytes,
          sha256: row.sha256,
        }),
      },
    });
    return row;
  });
}
