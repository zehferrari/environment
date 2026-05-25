// Bin purge (HOMELAB-48).
//
// Hard-deletes Task and Epic rows whose deletedAt is older than the
// configured TTL (default 7 days). Runs in two phases:
//
//   1. Find Attachment rows whose owning Task or Epic is about to be
//      purged. The DB cascade will delete the rows on its own, but we
//      need to know which on-disk blobs may become unreferenced.
//   2. Issue the deletes. Prisma FK cascades clean up Comment, sub-tasks,
//      AgentChatMessage, and Attachment rows.
//   3. For each storagePath that no longer has any Attachment referencing
//      it, remove the blob from disk.
//
// Audit a single `bin.purge` ActivityLog row per pass with the totals
// so the system feed shows the job ran.

import { db } from "@/lib/db";
import { deleteAttachmentFile } from "@/lib/attachments/storage";
import { resolveBinTtlMs } from "@/lib/settings/system";

const DEFAULT_TTL_DAYS = 7;

export interface PurgeResult {
  purgedEpics: number;
  purgedTasks: number;
  removedBlobs: number;
  errors: string[];
}

export async function purgeBin(): Promise<PurgeResult> {
  const cutoff = new Date(Date.now() - (await resolveBinTtlMs("PM_BIN_TTL_DAYS", DEFAULT_TTL_DAYS)));
  const result: PurgeResult = {
    purgedEpics: 0,
    purgedTasks: 0,
    removedBlobs: 0,
    errors: [],
  };

  // ---- Phase 1: pre-collect storage paths that may go orphan -----
  const expiringEpics = await db.epic.findMany({
    where: { deletedAt: { lt: cutoff, not: null } },
    select: { id: true },
  });
  const expiringTasks = await db.task.findMany({
    where: { deletedAt: { lt: cutoff, not: null } },
    select: { id: true },
  });
  const epicIds = expiringEpics.map((e) => e.id);
  const taskIds = expiringTasks.map((t) => t.id);

  // Attachments that will be cascade-deleted by Prisma when the Epic
  // or Task row goes away. We snapshot storagePath now; after the
  // delete, we re-count refs to decide whether to remove the blob.
  const attachmentsAtRisk = await db.attachment.findMany({
    where: {
      OR: [
        epicIds.length ? { epicId: { in: epicIds } } : undefined,
        taskIds.length ? { taskId: { in: taskIds } } : undefined,
      ].filter(Boolean) as object[],
    },
    select: { id: true, storagePath: true },
  });

  // ---- Phase 2: hard-delete via Prisma; FK cascades take care of
  //              sub-tasks, comments, attachments, chat messages.
  if (epicIds.length > 0) {
    try {
      const r = await db.epic.deleteMany({ where: { id: { in: epicIds } } });
      result.purgedEpics = r.count;
    } catch (err) {
      result.errors.push(`epic purge: ${(err as Error).message}`);
    }
  }
  if (taskIds.length > 0) {
    try {
      const r = await db.task.deleteMany({ where: { id: { in: taskIds } } });
      result.purgedTasks = r.count;
    } catch (err) {
      result.errors.push(`task purge: ${(err as Error).message}`);
    }
  }

  // ---- Phase 3: remove blobs whose last reference is gone --------
  const seenPath = new Set<string>();
  for (const a of attachmentsAtRisk) {
    if (seenPath.has(a.storagePath)) continue;
    seenPath.add(a.storagePath);
    const stillRef = await db.attachment.count({
      where: { storagePath: a.storagePath },
    });
    if (stillRef === 0) {
      try {
        await deleteAttachmentFile({ storagePath: a.storagePath, otherRefs: 0 });
        result.removedBlobs += 1;
      } catch (err) {
        result.errors.push(`blob ${a.storagePath}: ${(err as Error).message}`);
      }
    }
  }

  // ---- Audit -------------------------------------------------------
  if (
    result.purgedEpics > 0 ||
    result.purgedTasks > 0 ||
    result.removedBlobs > 0 ||
    result.errors.length > 0
  ) {
    await db.activityLog
      .create({
        data: {
          kind: "bin.purge",
          payload: JSON.stringify(result),
        },
      })
      .catch((err) =>
        result.errors.push(`audit: ${(err as Error).message}`),
      );
  }

  return result;
}
