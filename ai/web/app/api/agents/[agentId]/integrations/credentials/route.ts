import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = new Set(["jira", "bitbucket", "gmail", "openaiAuth", "webhook"]);

async function allowedFor(agentId: string) {
  const session = await auth();
  if (!session?.user) return { ok: false as const, status: 401, error: "unauth" };
  const ok = await canEditProfile({ name: session.user.name, kind: session.user.kind }, agentId);
  if (!ok) return { ok: false as const, status: 403, error: "forbidden" };
  return { ok: true as const };
}

export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const gate = await allowedFor(agentId);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const integration = new URL(request.url).searchParams.get("integration") ?? "";
  if (!ALLOWED.has(integration)) return NextResponse.json({ error: "unknown integration" }, { status: 400 });
  const res = await fetch(`http://127.0.0.1:3013/agents/integrations/credentials?user=${encodeURIComponent(agentId)}&integration=${encodeURIComponent(integration)}`, { cache: "no-store" });
  const text = await res.text();
  return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const gate = await allowedFor(agentId);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  const body = (await request.json()) as { integration?: unknown; fields?: unknown };
  if (typeof body.integration !== "string" || !ALLOWED.has(body.integration) || typeof body.fields !== "object" || body.fields == null) {
    return NextResponse.json({ error: "integration and fields are required" }, { status: 400 });
  }
  const res = await fetch("http://127.0.0.1:3013/agents/integrations/credentials", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: agentId, integration: body.integration, fields: body.fields }),
    cache: "no-store",
  });
  const text = await res.text();
  return new NextResponse(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
}
