import { discoverAgentModels } from "@/lib/agents/management/model-discovery";
import { previewAgentModelRotation, promoteAgentModel } from "@/lib/agents/management/model-settings";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/management/profile";
import { readAgentModelSettings, updateAgentModelSettings } from "@/lib/agents/management/model-settings";
import { isOwnerUserId } from "@/lib/auth/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauth" }, { status: 401 });
  if (!(await isOwnerUserId(session.user.id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { agentId } = await params;
  const url = new URL(_request.url);
  if (url.searchParams.has("discover")) {
    try { return NextResponse.json(await discoverAgentModels(agentId, url.searchParams.get("provider") ?? "")); }
    catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 }); }
  }
  const settings = await readAgentModelSettings(agentId);
  return NextResponse.json(settings);
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const { agentId } = await params;
  const allowed = await canEditProfile({ name: session.user.name, kind: session.user.kind }, agentId);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as { operation?: unknown; provider?: unknown; revision?: unknown; active?: unknown; defaultModel?: unknown; fallbacks?: unknown; model?: unknown } | null;
  if (!body) return NextResponse.json({ error: "model settings are required" }, { status: 400 });
  try {
    if (body.operation === "preview" || body.operation === "promote") {
      if (!(await isOwnerUserId(session.user.id))) return NextResponse.json({ error: "forbidden" }, { status: 403 });
      if (typeof body.provider !== "string" || typeof body.model !== "string") throw new Error("Provider and model are required");
      if (body.operation === "preview") return NextResponse.json(await previewAgentModelRotation(agentId, body.provider, body.model));
      if (typeof body.revision !== "string" || !body.revision) throw new Error("Preview the update first");
      const result = await promoteAgentModel(agentId, body.provider, body.model, body.revision, session.user.id);
      return NextResponse.json({ ok: true, ...result });
    }
    const result = await updateAgentModelSettings(agentId, {
      expectedRevision: typeof body.revision === "string" ? body.revision : undefined,
      active: typeof body.active === "string" ? body.active : typeof body.model === "string" ? body.model : undefined,
      defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
      fallbacks: Array.isArray(body.fallbacks) ? body.fallbacks.filter((item): item is string => typeof item === "string") : undefined,
    }, session.user.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
