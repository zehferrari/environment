// Attachment download route (HOMELAB-47).
//
// Streams the on-disk blob with the original filename. Browser users need a
// normal session; on-host agents may also read via a context grant or
// per-agent bearer token when their PM role / mention history permits it.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  authenticateAgentBearer,
  authenticateAgentContextRequest,
  isLoopbackRequest,
} from "@/lib/agents/context/api/auth";
import { checkAgentAttachmentReadAccess } from "@/lib/attachments/agent-access";
import { attachmentAbsolutePath } from "@/lib/attachments/storage";
import { normalizeAttachmentMimeType } from "@/lib/attachments/mime";
import {
  canAccessEpic,
  canAccessProject,
  canAccessTask,
  getViewer,
} from "@/lib/auth/permissions";

type AttachmentGrantScope = { type: "task" | "epic"; id: string };

function contentDisposition(disposition: "attachment" | "inline", filename: string) {
  const fallback = filename.replace(/["\r\n\\]/g, "").trim() || "attachment";
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function parseRange(header: string | null, size: number) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid" as const;

  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return "invalid" as const;

  let start: number;
  let end: number;

  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return "invalid" as const;
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return "invalid" as const;
  }

  return { start, end: Math.min(end, size - 1) };
}

function nodeStreamToWeb(stream: NodeJS.ReadableStream) {
  if (typeof Readable.toWeb === "function") {
    return Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer | string) => {
        controller.enqueue(
          typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
        );
      });
      stream.on("end", () => controller.close());
      stream.on("error", (error) => controller.error(error));
    },
    cancel() {
      if ("destroy" in stream && typeof stream.destroy === "function") {
        stream.destroy();
      }
    },
  });
}

async function grantScopeCanReachAttachment(
  candidate: AttachmentGrantScope,
  scope: { taskId: string | null; epicId: string | null },
) {
  if (candidate.type === "task") {
    if (scope.taskId) return candidate.id === scope.taskId;
    if (!scope.epicId) return false;
    const count = await db.task.count({
      where: {
        id: candidate.id,
        epicId: scope.epicId,
        archivedAt: null,
        deletedAt: null,
      },
    });
    return count > 0;
  }

  if (scope.epicId) return candidate.id === scope.epicId;
  if (!scope.taskId) return false;
  const count = await db.task.count({
    where: {
      id: scope.taskId,
      epicId: candidate.id,
      archivedAt: null,
      deletedAt: null,
    },
  });
  return count > 0;
}

async function authorizeAttachmentRead(
  req: NextRequest,
  attachmentId: string,
  scope: { projectId: string; taskId: string | null; epicId: string | null },
) {
  const session = await auth();
  if (session?.user?.id) {
    const viewer = await getViewer();
    const canAccessItem = viewer
      ? scope.taskId
        ? await canAccessTask(viewer, scope.taskId)
        : scope.epicId
          ? await canAccessEpic(viewer, scope.epicId)
          : false
      : false;
    if (viewer && canAccessItem && await canAccessProject(viewer, { id: scope.projectId })) {
      return { ok: true as const };
    }
    return { ok: false as const, status: 404, error: "Not found" };
  }

  if (!isLoopbackRequest(req)) {
    return { ok: false as const, status: 401, error: "Unauthenticated" };
  }

  const grant = req.nextUrl.searchParams.get("grant");
  let identity = null;
  if (grant) {
    const grantScopes: AttachmentGrantScope[] = [];
    const scopeType = req.nextUrl.searchParams.get("scopeType");
    const scopeId = req.nextUrl.searchParams.get("scopeId");
    if ((scopeType === "task" || scopeType === "epic") && scopeId) {
      grantScopes.push({ type: scopeType, id: scopeId });
    }
    if (scope.taskId) grantScopes.push({ type: "task", id: scope.taskId });
    if (scope.epicId) grantScopes.push({ type: "epic", id: scope.epicId });

    for (const candidate of grantScopes) {
      if (!(await grantScopeCanReachAttachment(candidate, scope))) continue;
      identity = await authenticateAgentContextRequest(req, candidate.type, candidate.id);
      if (identity) break;
    }
  } else {
    identity = await authenticateAgentBearer(req.headers.get("authorization"));
  }

  if (!identity) {
    return { ok: false as const, status: 401, error: "Invalid or missing agent attachment credential" };
  }
  if (!identity.agentSlug) {
    return { ok: false as const, status: 403, error: "Agent-specific credential required" };
  }

  const access = await checkAgentAttachmentReadAccess({
    attachmentId,
    agentSlug: identity.agentSlug,
  });
  if (!access.allowed) {
    return {
      ok: false as const,
      status: access.reason === "attachment-not-found" ? 404 : 403,
      error: "Agent cannot read this attachment",
    };
  }

  return { ok: true as const };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const row = await db.attachment.findUnique({
    where: { id },
    select: {
      projectId: true,
      taskId: true,
      epicId: true,
      filename: true,
      storagePath: true,
      mimeType: true,
      sizeBytes: true,
    },
  });
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const authorization = await authorizeAttachmentRead(req, id, {
    projectId: row.projectId,
    taskId: row.taskId,
    epicId: row.epicId,
  });
  if (!authorization.ok) {
    return NextResponse.json(
      { error: authorization.error },
      { status: authorization.status },
    );
  }

  // Sanity: confirm the on-disk file is still there before promising a stream.
  const abs = attachmentAbsolutePath(row);
  const st = await stat(abs).catch(() => null);
  if (!st) {
    return NextResponse.json(
      { error: "Attachment blob missing" },
      { status: 410 },
    );
  }

  const inline = (
    req.nextUrl.searchParams.get("inline") === "1" ||
    req.nextUrl.searchParams.get("preview") === "1"
  ) && req.nextUrl.searchParams.get("download") !== "1";
  const disposition = inline ? "inline" : "attachment";
  const contentType = normalizeAttachmentMimeType(row.filename, row.mimeType);
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=0, no-cache",
    "Content-Disposition": contentDisposition(disposition, row.filename),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
  const range = parseRange(req.headers.get("range"), st.size);

  if (range === "invalid") {
    return new NextResponse(null, {
      status: 416,
      headers: {
        ...commonHeaders,
        "Content-Range": `bytes */${st.size}`,
      },
    });
  }

  const stream = range
    ? createReadStream(abs, { start: range.start, end: range.end })
    : createReadStream(abs);
  const webStream = nodeStreamToWeb(stream);

  return new NextResponse(webStream, {
    status: range ? 206 : 200,
    headers: {
      ...commonHeaders,
      "Content-Length": String(range ? range.end - range.start + 1 : st.size),
      ...(range
        ? { "Content-Range": `bytes ${range.start}-${range.end}/${st.size}` }
        : {}),
    },
  });
}
