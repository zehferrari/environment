import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { canEditProfile } from "@/lib/agents/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const { agentId } = await params;
  const allowed = await canEditProfile({ name: session.user.name, kind: session.user.kind }, agentId);
  if (!allowed) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await request.json()) as { service?: unknown };
  if (typeof body.service !== "string" || !body.service) {
    return NextResponse.json({ error: "service is required" }, { status: 400 });
  }
  const res = await fetch("http://127.0.0.1:3013/agents/services/restart", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: agentId, service: body.service }),
    cache: "no-store",
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
