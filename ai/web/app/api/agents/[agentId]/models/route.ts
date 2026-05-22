import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/profile";
import { readAgentModelSettings, updateAgentActiveModel } from "@/lib/agents/model-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const { agentId } = await params;
  const settings = await readAgentModelSettings(agentId);
  return NextResponse.json(settings);
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const { agentId } = await params;
  const allowed = await canEditProfile({ name: session.user.name, kind: session.user.kind }, agentId);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as { model?: unknown } | null;
  if (!body || typeof body.model !== "string") return NextResponse.json({ error: "model is required" }, { status: 400 });
  try {
    const result = await updateAgentActiveModel(agentId, body.model, session.user.id);
    return NextResponse.json({ ok: true, model: body.model, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
