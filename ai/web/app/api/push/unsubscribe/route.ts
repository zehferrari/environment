import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let endpoint = "";
  try {
    const body = (await req.json()) as { endpoint?: unknown };
    endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!endpoint) {
    return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
  }

  // Only delete the caller's own subscription for this endpoint.
  await db.webPushSubscription.deleteMany({ where: { endpoint, userId } });
  return NextResponse.json({ ok: true }, { status: 200 });
}
