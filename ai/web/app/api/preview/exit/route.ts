import { NextRequest, NextResponse } from "next/server";
import { PREVIEW_COOKIE_NAME } from "@/lib/auth/preview-cookie";
import { absolutePublicUrl, publicOriginFromHeaders } from "@/lib/http/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.redirect(
    absolutePublicUrl("/workspaces", publicOriginFromHeaders(request.headers)),
    303,
  );
  response.cookies.set(PREVIEW_COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: publicOriginFromHeaders(request.headers)?.startsWith("https://") ?? false,
    path: "/",
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
