import { NextResponse, type NextRequest } from "next/server";
import { createWorkspace, listWorkspaces, selectableWorkspaceAgents } from "@/lib/workspaces/service";
import { getViewer, requireOwner } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const viewer = await getViewer();
  if (!viewer) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
  return NextResponse.json({
    workspaces: await listWorkspaces(includeArchived, viewer),
    selectableAgents: viewer.isOwner ? await selectableWorkspaceAgents() : [],
  });
}

export async function POST(req: NextRequest) {
  try { await requireOwner(); } catch { return NextResponse.json({ error: "forbidden" }, { status: 403 }); }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  try {
    const workspace = await createWorkspace(body);
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
