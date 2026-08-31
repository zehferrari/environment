import { NextResponse, type NextRequest } from "next/server";
import { archiveWorkspace, getWorkspaceBySlug, normalizeWorkspaceSlug, restoreWorkspace, serializeWorkspace, updateWorkspace } from "@/lib/workspaces/service";
import { getViewer, requireOwner } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { slug: rawSlug } = await ctx.params;
  const workspace = await getWorkspaceBySlug(normalizeWorkspaceSlug(rawSlug), viewer);
  if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ workspace: serializeWorkspace(workspace, viewer.canAccessOwnerFeatures) });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  let owner;
  try { owner = await requireOwner(); } catch { return NextResponse.json({ error: "forbidden" }, { status: 403 }); }
  const { slug: rawSlug } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  try {
    const normalizedSlug = normalizeWorkspaceSlug(rawSlug);
    if ((body as { archived?: unknown }).archived === false && Object.keys(body).length === 1) {
      const workspace = await restoreWorkspace(normalizedSlug);
      if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return NextResponse.json({ workspace });
    }
    const workspace = await updateWorkspace(normalizedSlug, body, owner.id);
    if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ workspace });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  let owner;
  try { owner = await requireOwner(); } catch { return NextResponse.json({ error: "forbidden" }, { status: 403 }); }
  const { slug: rawSlug } = await ctx.params;
  const workspace = await archiveWorkspace(normalizeWorkspaceSlug(rawSlug), owner.id);
  if (!workspace) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ workspace });
}
