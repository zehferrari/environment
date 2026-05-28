// Bearer-token auth for the agent-facing PM read API
// (GET /api/agents/context/{task,epic,project}/<id>).
//
// Reuses the existing per-agent PM-channel bearer secret — the same token
// OpenClaw uses to call PM back on /api/openclaw/pm-channel/reply. Agents
// already have this token in their ~/.openclaw/openclaw.json at
// channels.pm.token, so adding a read API doesn't introduce a new auth
// surface for operators to manage.
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

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
  "::1",
]);

/**
 * Verify the request reached PM directly over loopback (no nginx hop). The
 * agent context API is for ON-HOST agents only — if nginx is in the path,
 * we have an X-Forwarded-* header and we reject. Mirrors the policy on
 * pm-channel/ingest (loopback-only on the OpenClaw side).
 */
export function isLoopbackRequest(req: NextRequest): boolean {
  // Any X-Forwarded-* header → request came through a proxy. Reject.
  if (req.headers.get("x-forwarded-for")) return false;
  if (req.headers.get("x-forwarded-host")) return false;
  if (req.headers.get("x-forwarded-proto")) return false;
  // Host header must name a loopback target.
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (!host) return false;
  const bare = host.replace(/:\d+$/, "");
  return LOOPBACK_HOSTS.has(bare);
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
