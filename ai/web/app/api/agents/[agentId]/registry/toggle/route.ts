import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/management/profile";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ToggleBody = { kind?: unknown; key?: unknown; value?: unknown };

async function proxyAtlas(path: string, init: RequestInit) {
  const res = await fetch(`http://127.0.0.1:3013${path}`, { ...init, cache: "no-store" });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const { agentId } = await params;
  const allowed = await canEditProfile({ name: session.user.name, kind: session.user.kind }, agentId);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await request.json()) as ToggleBody;
  if ((body.kind !== "integrations" && body.kind !== "capabilities") || typeof body.key !== "string" || typeof body.value !== "boolean") {
    return NextResponse.json({ error: "kind, key, and boolean value are required" }, { status: 400 });
  }
  const response = await proxyAtlas("/agents/registry/toggle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: agentId, kind: body.kind, key: body.key, value: body.value }),
  });
  await db.activityLog.create({
    data: {
      userId: session.user.id,
      kind: response.ok ? "agent.registry.toggle" : "agent.registry.toggle_failed",
      targetAgent: agentId,
      payload: JSON.stringify({
        driver: "atlas",
        status: response.status,
        kind: body.kind,
        key: body.key,
        value: body.value,
      }),
    },
  });
  return response;
}
