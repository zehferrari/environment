import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { createWorkspace, listWorkspaces, selectableWorkspaceAgents } from "@/lib/workspaces/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requireSession() {
  const session = await auth();
  if (!session?.user?.id) return null;
  return session;
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
  return NextResponse.json({ workspaces: await listWorkspaces(includeArchived), selectableAgents: await selectableWorkspaceAgents() });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  try {
    const workspace = await createWorkspace(body);
    return NextResponse.json({ workspace }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
