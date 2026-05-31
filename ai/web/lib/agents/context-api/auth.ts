// Bearer-token auth for the agent-facing PM read API
// (GET /api/agents/context/{task,epic,project}/<id>).
//
// Preferred auth is a short-lived context grant handed to the agent in the
// current turn. A legacy per-agent bearer fallback remains during rollout.
//
// We do NOT require the caller to identify themselves by slug. The data
// returned is the same for every active agent (the soft-delete contract
// in lib/agents/context/* is applied server-side regardless of caller),
// so "valid agent bearer" is all we need. We DO return the resolved slug
// when the token matches a per-agent secret — handy for audit logging.

import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  authenticateContextGrant,
  type ContextScopeType,
} from "@/lib/agents/context-grants";

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
  "::1",
]);

/**
 * Verify the request reached PM directly over loopback (no nginx hop). The
 * agent context API is for ON-HOST agents only.
 *
 * pm.service binds to 127.0.0.1:3000 — so any request that arrives at all
 * either came in directly on loopback (no x-forwarded-for) or was proxied
 * through nginx (x-forwarded-for points at the external client IP). We
 * accept the first case and reject the second.
 *
 * NOTE: Next.js 15 itself sometimes stamps x-forwarded-host/proto on
 * internal RSC navigations even for direct loopback requests, so we look
 * specifically at x-forwarded-for (which only nginx populates here) and
 * trust the loopback bind for the rest. The host header is informational.
 */
export function isLoopbackRequest(req: NextRequest): boolean {
  // Defense in depth (HOMELAB-41): don't trust a single header. The
  // agents.vixi.au nginx vhost sets BOTH X-Forwarded-For and X-Real-IP to the
  // real client IP on every proxied request, while a direct on-host agent curl
  // to 127.0.0.1:3000 sends neither. Collect every client-IP signal and reject
  // as soon as ANY of them is non-loopback.
  //
  // We deliberately do NOT key off X-Forwarded-Host/Proto: Next.js 15 can stamp
  // those on internal RSC navigations even for direct loopback requests.
  // X-Real-IP is set only by nginx here, so it has no such ambiguity.
  const candidates: string[] = [];
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    candidates.push(...xff.split(",").map((s) => s.trim()).filter(Boolean));
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp?.trim()) candidates.push(realIp.trim());

  // No client-IP header at all → a direct loopback request. Accept.
  if (candidates.length === 0) return true;
  // Otherwise every signal must be loopback.
  return candidates.every((ip) => LOOPBACK_HOSTS.has(ip));
}

const DEFAULT_TOKEN_FILE =
  process.env.PM_OPENCLAW_CHANNEL_TOKEN_FILE ??
  "/etc/openclaw/pm-channel-tokens.json";

const TOKEN_CACHE_MS = 10_000;
let tokenCache: { at: number; tokens: Record<string, string> } | null = null;

function envTokenKey(slug: string) {
  return `PM_OPENCLAW_CHANNEL_TOKEN_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

async function loadTokenMap(): Promise<Record<string, string>> {
  const now = Date.now();
  if (tokenCache && now - tokenCache.at < TOKEN_CACHE_MS) return tokenCache.tokens;
  try {
    const raw = await readFile(DEFAULT_TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    tokenCache = { at: now, tokens: parsed };
    return parsed;
  } catch {
    tokenCache = { at: now, tokens: {} };
    return {};
  }
}

function eq(a: string, b: string) {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface AgentBearerIdentity {
  /** Resolved agent slug if the bearer matched a per-agent token. null when the shared token matched. */
  agentSlug: string | null;
  /** Was this the shared PM_OPENCLAW_CHANNEL_TOKEN rather than a per-agent secret? */
  shared: boolean;
  /** Context grant id when auth used a short-lived prompt-visible grant. */
  grantId?: string;
}

/**
 * Validate a Bearer token from an incoming request and resolve which active
 * agent (if any) it belongs to. Returns null when nothing matches — caller
 * should reply 401.
 */
export async function authenticateAgentBearer(authorizationHeader: string | null): Promise<AgentBearerIdentity | null> {
  const raw = (authorizationHeader ?? "").trim();
  if (!raw.startsWith("Bearer ")) return null;
  const presented = raw.slice("Bearer ".length).trim();
  if (!presented) return null;

  // 1. Try each active agent's per-agent token (env var first, then file map).
  const activeAgents = await db.agent.findMany({
    where: { deactivatedAt: null, user: { is: { status: "active" } } },
    select: { slug: true },
  });
  const tokenMap = await loadTokenMap();
  for (const { slug } of activeAgents) {
    const fromEnv = process.env[envTokenKey(slug)];
    if (fromEnv && eq(presented, fromEnv)) return { agentSlug: slug, shared: false };
    const fromFile = tokenMap[slug];
    if (fromFile && eq(presented, fromFile)) return { agentSlug: slug, shared: false };
  }

  // 2. Shared fallback — anyone with this token authenticates as "any agent".
  const shared = process.env.PM_OPENCLAW_CHANNEL_TOKEN
    ?? process.env.PM_OPENCLAW_CHANNEL_CALLBACK_TOKEN
    ?? tokenMap.default
    ?? "";
  if (shared && eq(presented, shared)) return { agentSlug: null, shared: true };

  return null;
}

function contextGrantsRequired() {
  const value = process.env.PM_CONTEXT_GRANTS_REQUIRED;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export async function authenticateAgentContextRequest(
  req: NextRequest,
  scopeType: ContextScopeType,
  scopeId: string,
): Promise<AgentBearerIdentity | null> {
  const grantToken = req.nextUrl.searchParams.get("grant") ?? "";
  if (grantToken) {
    const grant = await authenticateContextGrant({ scopeType, scopeId, token: grantToken });
    return grant
      ? { agentSlug: grant.agentSlug, shared: false, grantId: grant.grantId }
      : null;
  }

  if (contextGrantsRequired()) return null;
  return authenticateAgentBearer(req.headers.get("authorization"));
}
