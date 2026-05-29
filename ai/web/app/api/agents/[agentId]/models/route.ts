import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/profile";
import { readAgentModelSettings, updateAgentModelSettings } from "@/lib/agents/model-settings";

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
  const body = await request.json().catch(() => null) as { active?: unknown; defaultModel?: unknown; fallbacks?: unknown; model?: unknown } | null;
  if (!body) return NextResponse.json({ error: "model settings are required" }, { status: 400 });
  try {
    const result = await updateAgentModelSettings(agentId, {
      active: typeof body.active === "string" ? body.active : typeof body.model === "string" ? body.model : undefined,
      defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
      fallbacks: Array.isArray(body.fallbacks) ? body.fallbacks.filter((item): item is string => typeof item === "string") : undefined,
    }, session.user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
