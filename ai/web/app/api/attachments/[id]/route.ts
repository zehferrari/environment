// Attachment download route (HOMELAB-47).
//
// Streams the on-disk blob with the original filename. Auth-gated by
// middleware; no per-row ACL beyond "you can sign in" since attachments
// don't expose anything more sensitive than the task/epic they're
// pinned to (which is itself sign-in-only). If row-level ACL ever
// matters, add it here — readAttachmentStream is unaware of identity.

import { stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { attachmentReadStream } from "@/lib/attachments/storage";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const { id } = await ctx.params;
  const row = await db.attachment.findUnique({
    where: { id },
    select: {
      filename: true,
      storagePath: true,
      mimeType: true,
      sizeBytes: true,
    },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // sanity: confirm the on-disk file is still there before promising a stream.
  const root =
    process.env.PM_ATTACHMENT_ROOT ??
    (process.env.NODE_ENV !== "production"
      ? path.resolve(process.cwd(), ".data/attachments")
      : "/srv/Data/projects");
  const abs = path.join(root, row.storagePath);
  const st = await stat(abs).catch(() => null);
  if (!st) {
    return NextResponse.json(
      { error: "Attachment blob missing" },
      { status: 410 },
    );
  }

  const stream = attachmentReadStream({ storagePath: row.storagePath });
  // Node Readable → Web ReadableStream for NextResponse.
  // Node 18+ exposes Readable.toWeb; cast keeps TS happy.
  const { Readable } = await import("node:stream");
  const webStream = (Readable as unknown as {
    toWeb: (r: NodeJS.ReadableStream) => ReadableStream<Uint8Array>;
  }).toWeb(stream);

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": row.mimeType || "application/octet-stream",
      "Content-Length": String(row.sizeBytes),
      "Content-Disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=0, no-cache",
    },
  });
}
