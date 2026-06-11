import { NextResponse } from "next/server";
import { webPushPublicKey } from "@/lib/push/web-push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The client fetches the VAPID public key from the running server (rather than
// a build-time NEXT_PUBLIC_* var) so enabling push does not require a rebuild.
export async function GET() {
  const key = webPushPublicKey();
  if (!key) {
    return NextResponse.json({ enabled: false }, { status: 200 });
  }
  return NextResponse.json({ enabled: true, publicKey: key }, { status: 200 });
}
