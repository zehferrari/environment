import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { archiveWorkspace, getWorkspaceBySlug, normalizeWorkspaceSlug, serializeWorkspace, updateWorkspace } from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { slug: rawSlug } = await ctx.params;
  const workspace = await getWorkspaceBySlug(normalizeWorkspaceSlug(rawSlug));
  if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ workspace: serializeWorkspace(workspace) });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { slug: rawSlug } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  try {
    const workspace = await updateWorkspace(normalizeWorkspaceSlug(rawSlug), body);
    if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ workspace });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { slug: rawSlug } = await ctx.params;
  const workspace = await archiveWorkspace(normalizeWorkspaceSlug(rawSlug), session.user.id!);
  if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ workspace });
}
