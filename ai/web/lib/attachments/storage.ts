// Attachment storage (HOMELAB-47).
//
// Bytes land on disk; metadata lives in the Attachment table. Layout:
//
//   <root>/<projectId>/<sha256>
//
// where <root> is /srv/Data/projects on the deploy host (next to the
// per-project README under Project.readmePath) and ./.data/attachments
// locally so dev works without /srv/Data. Files are content-addressed
// by sha256 — re-uploading the same bytes from a different filename
// reuses the existing on-disk blob; metadata rows still distinguish
// taskId/epicId/filename per upload.
//
// One-of-target invariant (taskId XOR epicId) is enforced here, not in
// the DB, because SQLite has no portable check constraint.

import { createReadStream, type ReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MiB

function attachmentsRoot(): string {
  if (process.env.PM_ATTACHMENT_ROOT) return process.env.PM_ATTACHMENT_ROOT;
  // Local-dev fallback so /srv/Data isn't required on a laptop.
  if (process.env.NODE_ENV !== "production") {
    return path.resolve(process.cwd(), ".data/attachments");
  }
  return "/srv/Data/projects";
}

function maxBytes(): number {
  const raw = process.env.PM_ATTACHMENT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

export interface AttachmentTarget {
  projectId: string;
  taskId: string | null;
  epicId: string | null;
}

// Throws on the XOR violation. Server actions should call this before
// touching the DB so an invalid target never produces a half-written row.
export function assertOneTarget(t: AttachmentTarget): void {
  const taskSet = t.taskId !== null && t.taskId !== "";
  const epicSet = t.epicId !== null && t.epicId !== "";
  if (taskSet === epicSet) {
    throw new Error(
      "Attachment must reference exactly one of taskId or epicId",
    );
  }
}

export interface WrittenAttachment {
  storagePath: string; // relative to attachmentsRoot()
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
}

// Writes bytes to a temp file while hashing, then atomic-renames into
// place at <root>/<projectId>/<sha256>. If the destination already
// exists (same content hash) the temp file is removed and the existing
// blob is reused. Enforces maxBytes; raises if exceeded mid-stream.
export async function writeAttachment(params: {
  projectId: string;
  filename: string;
  mimeType: string;
  data: Buffer;
}): Promise<WrittenAttachment> {
  const root = attachmentsRoot();
  const cap = maxBytes();

  if (params.data.byteLength > cap) {
    throw new Error(
      `Attachment exceeds size cap (${params.data.byteLength} > ${cap})`,
    );
  }

  const projectDir = path.join(root, params.projectId);
  await mkdir(projectDir, { recursive: true });

  const sha = createHash("sha256").update(params.data).digest("hex");
  const finalAbs = path.join(projectDir, sha);

  const existing = await stat(finalAbs).catch(() => null);
  if (!existing) {
    const tmpAbs = path.join(
      tmpdir(),
      `pm-attach-${sha}-${process.pid}-${Date.now()}`,
    );
    await writeFile(tmpAbs, params.data, { mode: 0o640 });
    try {
      await rename(tmpAbs, finalAbs);
    } catch (err) {
      await rm(tmpAbs, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  return {
    storagePath: path.posix.join(params.projectId, sha),
    absolutePath: finalAbs,
    sizeBytes: params.data.byteLength,
    sha256: sha,
    mimeType: params.mimeType || "application/octet-stream",
  };
}

export function attachmentReadStream(row: {
  storagePath: string;
}): ReadStream {
  const abs = path.join(attachmentsRoot(), row.storagePath);
  return createReadStream(abs);
}

// Removes the on-disk blob iff no other Attachment row still references
// the same storagePath. Caller is expected to have already deleted the
// row in the same transaction; passing the in-flight count via
// `otherRefs` keeps the helper synchronous-ish and DB-free.
export async function deleteAttachmentFile(row: {
  storagePath: string;
  otherRefs: number;
}): Promise<void> {
  if (row.otherRefs > 0) return;
  const abs = path.join(attachmentsRoot(), row.storagePath);
  await rm(abs, { force: true }).catch(() => undefined);
}

export function attachmentMaxBytes(): number {
  return maxBytes();
}
