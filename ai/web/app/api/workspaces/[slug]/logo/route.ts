import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { MAX_WORKSPACE_LOGO_BYTES, deleteWorkspaceLogo, normalizeLogoMimeType, validateLogoMimeType, writeWorkspaceLogo } from "@/lib/workspaces/storage";
import { getWorkspaceBySlug, normalizeWorkspaceSlug, serializeWorkspace } from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function nodeStreamToWeb(stream: NodeJS.ReadableStream) {
  return Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
}

async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug: rawSlug } = await ctx.params;
  const workspace = await db.workspace.findUnique({ where: { slug: normalizeWorkspaceSlug(rawSlug) }, select: { logoPath: true, logoMimeType: true, logoSizeBytes: true } });
  if (!workspace?.logoPath || !workspace.logoMimeType) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try { await stat(workspace.logoPath); } catch { return NextResponse.json({ error: "not_found" }, { status: 404 }); }
  return new NextResponse(nodeStreamToWeb(createReadStream(workspace.logoPath)), {
    headers: {
      "Content-Type": workspace.logoMimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
      ...(workspace.logoSizeBytes ? { "Content-Length": String(workspace.logoSizeBytes) } : {}),
    },
  });
}

async function readLogoUpload(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    const form = await req.formData();
    const uploaded = form.get("logo");
    if (!(uploaded instanceof File)) return { error: "logo_file_required" as const };
    const mimeType = normalizeLogoMimeType(uploaded.type, uploaded.name);
    const bytes = Buffer.from(await uploaded.arrayBuffer());
    return { mimeType, bytes };
  }

  const mimeType = normalizeLogoMimeType(contentType, req.headers.get("x-file-name"));
  const bytes = Buffer.from(await req.arrayBuffer());
  return { mimeType, bytes };
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { slug: rawSlug } = await ctx.params;
  const slug = normalizeWorkspaceSlug(rawSlug);
  const workspace = await db.workspace.findUnique({ where: { slug }, select: { id: true, logoPath: true } });
  if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const upload = await readLogoUpload(req);
  if ("error" in upload) return NextResponse.json({ error: upload.error }, { status: 400 });
  if (!validateLogoMimeType(upload.mimeType)) return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  if (upload.bytes.length === 0 || upload.bytes.length > MAX_WORKSPACE_LOGO_BYTES) return NextResponse.json({ error: "logo_size_invalid" }, { status: 400 });

  await deleteWorkspaceLogo(workspace.logoPath);
  const filePath = await writeWorkspaceLogo(workspace.id, upload.mimeType, upload.bytes);
  const updated = await db.workspace.update({
    where: { id: workspace.id },
    data: { logoPath: filePath, logoMimeType: upload.mimeType, logoSizeBytes: upload.bytes.length, logoUpdatedAt: new Date() },
  });
  const full = await getWorkspaceBySlug(updated.slug);
  return NextResponse.json({ workspace: full ? serializeWorkspace(full) : null });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { slug: rawSlug } = await ctx.params;
  const slug = normalizeWorkspaceSlug(rawSlug);
  const workspace = await db.workspace.findUnique({ where: { slug }, select: { id: true, logoPath: true } });
  if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await deleteWorkspaceLogo(workspace.logoPath);
  const updated = await db.workspace.update({ where: { id: workspace.id }, data: { logoPath: null, logoMimeType: null, logoSizeBytes: null, logoUpdatedAt: null } });
  const full = await getWorkspaceBySlug(updated.slug);
  return NextResponse.json({ workspace: full ? serializeWorkspace(full) : null });
}
