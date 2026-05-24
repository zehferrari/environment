// Project bin purge — hard-deletes Project rows past the configured
// TTL (default 30 days). Cascades (via Prisma's onDelete: Cascade on
// the child relations) take care of Epic, Task, ProjectMember,
// Attachment, AgentChatMessage. ActivityLog rows survive because the
// projectId FK is SetNull.
//
// Blob cleanup mirrors lib/bin/purge.ts: snapshot storagePaths before
// the delete, then remove on-disk blobs that no longer have any
// Attachment referencing them.

import { db } from "@/lib/db";
import { deleteAttachmentFile } from "@/lib/attachments/storage";

const DEFAULT_TTL_DAYS = 30;

function ttlMs(): number {
  const raw = process.env.PM_PROJECT_BIN_TTL_DAYS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n * 86400_000;
  }
  return DEFAULT_TTL_DAYS * 86400_000;
}

export interface ProjectPurgeResult {
  purgedProjects: number;
  removedBlobs: number;
  errors: string[];
}

export async function purgeProjectBin(): Promise<ProjectPurgeResult> {
  const cutoff = new Date(Date.now() - ttlMs());
  const result: ProjectPurgeResult = {
    purgedProjects: 0,
    removedBlobs: 0,
    errors: [],
  };

  const expiringProjects = await db.project.findMany({
    where: { deletedAt: { lt: cutoff, not: null } },
    select: { id: true },
  });
  const projectIds = expiringProjects.map((p) => p.id);
  if (projectIds.length === 0) return result;

  const attachmentsAtRisk = await db.attachment.findMany({
    where: { projectId: { in: projectIds } },
    select: { id: true, storagePath: true },
  });

  try {
    const r = await db.project.deleteMany({ where: { id: { in: projectIds } } });
    result.purgedProjects = r.count;
  } catch (err) {
    result.errors.push(`project purge: ${(err as Error).message}`);
  }

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

  if (
    result.purgedProjects > 0 ||
    result.removedBlobs > 0 ||
    result.errors.length > 0
  ) {
    await db.activityLog
      .create({
        data: { kind: "project.bin.purge", payload: JSON.stringify(result) },
      })
      .catch((err) =>
        result.errors.push(`audit: ${(err as Error).message}`),
      );
  }

  return result;
}
