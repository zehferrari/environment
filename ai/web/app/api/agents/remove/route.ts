import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function proxyAtlas(path: string, payload: unknown) {
  const res = await fetch(`http://127.0.0.1:3013${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  if (session.user.name !== "zeh") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object" || !payload.user) {
    return NextResponse.json({ error: "invalid json payload or missing user slug" }, { status: 400 });
  }

  const response = await proxyAtlas("/agents/registry/remove", payload);
  
  if (response.ok) {
    await db.activityLog.create({
      data: {
        userId: session.user.id,
        kind: "agent.registry.remove",
        targetAgent: payload.user,
        payload: JSON.stringify({
          driver: "atlas",
          status: response.status,
          payload,
        }),
      },
    });
  }

  return response;
}
