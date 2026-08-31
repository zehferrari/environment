import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  issueOwnerPreviewToken,
} from "@/lib/auth/preview";
import { PREVIEW_COOKIE_NAME, PREVIEW_TOKEN_TTL_SECONDS } from "@/lib/auth/preview-cookie";
import { absolutePublicUrl, publicOriginFromHeaders } from "@/lib/http/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  return origin === publicOriginFromHeaders(request.headers);
}

function secureCookie(request: NextRequest): boolean {
  return publicOriginFromHeaders(request.headers)?.startsWith("https://") ?? false;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Preview is unavailable" }, { status: 403 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const formData = await request.formData();
  const targetUserId = String(formData.get("userId") ?? "").trim();
  if (!targetUserId) {
    return NextResponse.json({ error: "A preview user is required" }, { status: 400 });
  }

  const token = await issueOwnerPreviewToken(session.user.id, targetUserId);
  // Deliberately use one response for non-Owner actors and invalid/ineligible
  // targets so this endpoint never becomes a user/role discovery oracle.
  if (!token) {
    return NextResponse.json({ error: "Preview is unavailable" }, { status: 403 });
  }

  const response = NextResponse.redirect(
    absolutePublicUrl("/workspaces", publicOriginFromHeaders(request.headers)),
    303,
  );
  response.cookies.set(PREVIEW_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookie(request),
    path: "/",
    maxAge: PREVIEW_TOKEN_TTL_SECONDS,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
