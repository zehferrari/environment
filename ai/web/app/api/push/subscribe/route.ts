import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SubscribeBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: SubscribeBody;
  try {
    body = (await req.json()) as SubscribeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth256 = typeof body.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint || !p256dh || !auth256) {
    return NextResponse.json({ error: "endpoint and keys.p256dh / keys.auth are required" }, { status: 400 });
  }

  const userAgent = req.headers.get("user-agent")?.slice(0, 255) ?? null;

  // Keyed by the unique endpoint so re-subscribing the same browser updates
  // the owner/keys instead of creating duplicates (and re-homes an endpoint to
  // the current user if they sign in on a shared device).
  await db.webPushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh, auth: auth256, userAgent },
    update: { userId, p256dh, auth: auth256, userAgent, lastUsedAt: new Date() },
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
