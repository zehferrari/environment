import { type NextRequest, NextResponse } from "next/server";
import {
  AUTH_SESSION_COOKIE_BASE_NAMES,
  isAuthSessionCookieName,
} from "@/lib/auth/session-recovery";

export const dynamic = "force-dynamic";

function configuredPublicOrigin(): URL | null {
  const publicUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? process.env.APP_URL;
  if (!publicUrl) return null;

  try {
    const url = new URL(publicUrl);
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch {
    // Fall through to the trusted reverse-proxy request headers.
  }

  return null;
}

function publicRequestOrigin(request: NextRequest): URL {
  const configured = configuredPublicOrigin();
  if (configured) return configured;

  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  const protocol = forwarded === "https" || forwarded === "http"
    ? forwarded
    : request.nextUrl.protocol === "https:" ? "https" : "http";
  const host = (
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    request.nextUrl.host
  ).split(",")[0].trim();
  return new URL(`${protocol}://${host}`);
}

export function GET(request: NextRequest) {
  const publicOrigin = publicRequestOrigin(request);
  const loginUrl = new URL("/login", publicOrigin);
  loginUrl.searchParams.set("expired", "1");

  const response = NextResponse.redirect(loginUrl);
  response.headers.set("Cache-Control", "no-store");

  const cookieNames = new Set<string>(AUTH_SESSION_COOKIE_BASE_NAMES);
  for (const cookie of request.cookies.getAll()) {
    if (isAuthSessionCookieName(cookie.name)) cookieNames.add(cookie.name);
  }

  const secureRequest = publicOrigin.protocol === "https:";
  for (const name of cookieNames) {
    response.cookies.set({
      name,
      value: "",
      path: "/",
      expires: new Date(0),
      maxAge: 0,
      httpOnly: true,
      sameSite: "lax",
      // Chrome rejects __Secure- Set-Cookie headers without this attribute,
      // including deletion headers.
      secure: name.startsWith("__Secure-") || secureRequest,
    });
  }

  return response;
}
