import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = ["/login", "/api/auth", "/_next", "/favicon.ico"];

function isPublic(path: string) {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

function forwardedUrl(req: NextRequest, pathname: string) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = host === "agents.vixi.au"
    ? "https"
    : req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return new URL(pathname, `${proto}://${host}`);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: req.headers.get("x-forwarded-host") === "agents.vixi.au" || req.headers.get("host") === "agents.vixi.au",
  });
  if (!token) {
    const url = forwardedUrl(req, "/login");
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Force password rotation on first login for seeded accounts (must_rotate_password).
  if (token.mustRotatePassword && pathname !== "/rotate-password") {
    const url = forwardedUrl(req, "/rotate-password");
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Avoid running middleware on Next internals + the rotate page itself.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth).*)"],
};
