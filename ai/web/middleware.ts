import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

const PUBLIC_PATHS = ["/login", "/accept-invite", "/set-password", "/api/auth", "/_next", "/favicon.ico"];

function isPublic(path: string) {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + "/"));
}

// Agent callbacks are not browser-session routes. They authenticate inside
// the route handler with a per-agent Bearer token or a one-shot HMAC grant.
function isTokenScopedAgentReply(path: string) {
  return /^\/api\/agents\/[^/]+\/chat\/reply$/.test(path);
}

function isTokenScopedTaskReply(path: string) {
  return /^\/api\/tasks\/[^/]+\/chat\/reply$/.test(path);
}

function isTokenScopedTaskDescription(path: string) {
  return /^\/api\/tasks\/[^/]+\/description$/.test(path);
}

function isTokenScopedEpicDescription(path: string) {
  return /^\/api\/epics\/[^/]+\/description$/.test(path);
}

function isTokenScopedProjectProposal(path: string) {
  return /^\/api\/agent\/projects\/[^/]+\/proposals$/.test(path);
}

function isTokenScopedTaskWorkflow(path: string) {
  return /^\/api\/agent\/tasks\/[^/]+\/workflow$/.test(path);
}

function isTokenScopedEpicWorkflow(path: string) {
  return /^\/api\/agent\/epics\/[^/]+\/workflow$/.test(path);
}

// Loopback-only, agent-bearer-auth read API. Authenticates inside the
// route handler — see ai/web/docs/agent-pm-api.md.
function isTokenScopedAgentContextRead(path: string) {
  return /^\/api\/agents\/context\/(task|epic|project)\/[^/]+$/.test(path);
}

function isTokenScopedAttachmentRead(req: NextRequest, path: string) {
  return (
    /^\/api\/attachments\/[^/]+$/.test(path) &&
    (
      req.nextUrl.searchParams.has("grant") ||
      req.headers.get("authorization")?.trim().startsWith("Bearer ")
    )
  );
}

function isTokenScopedAgentCallback(path: string) {
  return (
    isTokenScopedAgentReply(path) ||
    isTokenScopedTaskReply(path) ||
    isTokenScopedTaskDescription(path) ||
    isTokenScopedEpicDescription(path) ||
    isTokenScopedProjectProposal(path) ||
    isTokenScopedTaskWorkflow(path) ||
    isTokenScopedEpicWorkflow(path) ||
    isTokenScopedAgentContextRead(path)
  );
}

function isOpenClawPmChannelReply(path: string) {
  return path === "/api/openclaw/pm-channel/reply";
}

function isOpenClawPmChannelStream(path: string) {
  return path === "/api/openclaw/pm-channel/stream";
}

function isOpenClawPmChannelEvents(path: string) {
  return path === "/api/openclaw/pm-channel/events";
}

function forwardedProtocol(req: NextRequest): "http" | "https" {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwarded === "https" || forwarded === "http") return forwarded;
  return req.nextUrl.protocol === "https:" ? "https" : "http";
}

function forwardedUrl(req: NextRequest, pathname: string) {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  return new URL(pathname, `${forwardedProtocol(req)}://${host}`);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (
    isPublic(pathname) ||
    isTokenScopedAgentCallback(pathname) ||
    isTokenScopedAttachmentRead(req, pathname) ||
    isOpenClawPmChannelReply(pathname) ||
    isOpenClawPmChannelStream(pathname) ||
    isOpenClawPmChannelEvents(pathname)
  ) {
    return NextResponse.next();
  }

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: forwardedProtocol(req) === "https",
  });
  if (!token) {
    const url = forwardedUrl(req, "/login");
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Avoid running middleware on Next internals and the events streaming route.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/auth|api/openclaw/pm-channel/events).*)"],
};
