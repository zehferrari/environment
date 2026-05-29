import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Serves a human user's uploaded avatar (resized PNG stored on the User
// row). Auth-gated by middleware — only authenticated sessions can fetch
// it, which is fine since the <img> request carries the session cookie.
// Returns 404 when the user has no avatar so the caller can fall back to
// initials.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await db.user.findUnique({
    where: { id },
    select: { avatar: true, avatarUpdatedAt: true },
  });
  if (!user?.avatar) {
    return new NextResponse(null, { status: 404 });
  }
  const bytes = Buffer.from(user.avatar);
  return new NextResponse(bytes, {
    headers: {
      "content-type": "image/png",
      "content-length": String(bytes.byteLength),
      // Per-user, not sensitive; short private cache keyed on last update.
      "cache-control": "private, max-age=300",
      etag: `"${user.avatarUpdatedAt?.getTime() ?? 0}"`,
    },
  });
}
