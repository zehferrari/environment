import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = ["/login", "/api/auth", "/_next", "/favicon.ico"];

function isPublic(path: string) {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublic(pathname)) return NextResponse.next();

  const token = await getToken({ req, secret: process.env.AUTH_SECRET });
  if (!token) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Force password rotation on first login for seeded accounts (must_rotate_password).
  if (token.mustRotatePassword && pathname !== "/rotate-password") {
    const url = req.nextUrl.clone();
    url.pathname = "/rotate-password";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Avoid running middleware on Next internals + the rotate page itself.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth).*)"],
};
