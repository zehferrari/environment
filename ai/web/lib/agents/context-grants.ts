import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

export type ContextScopeType = "task" | "epic" | "project";

const DEFAULT_TTL_MS = Number.parseInt(process.env.PM_CONTEXT_GRANT_TTL_MS ?? "900000", 10);
const DEFAULT_MAX_BYTES = Number.parseInt(process.env.PM_CONTEXT_GRANT_MAX_BYTES ?? "2000000", 10);
const DEFAULT_MAX_USES = Number.parseInt(process.env.PM_CONTEXT_GRANT_MAX_USES ?? "20", 10);

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function eq(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function boundedPositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export async function createContextGrant(args: {
  agentSlug: string;
  scopeType: ContextScopeType;
  scopeId: string;
  turnId: string;
  runId?: string | null;
  includes?: string[];
  ttlMs?: number;
  maxBytes?: number;
  maxUses?: number;
}) {
  const token = randomBytes(32).toString("base64url");
  const ttlMs = boundedPositive(args.ttlMs ?? DEFAULT_TTL_MS, 15 * 60_000);
  const maxBytes = boundedPositive(args.maxBytes ?? DEFAULT_MAX_BYTES, 2_000_000);
  const maxUses = boundedPositive(args.maxUses ?? DEFAULT_MAX_USES, 20);
  const grant = await db.contextGrant.create({
    data: {
      tokenHash: hashToken(token),
      runId: args.runId ?? null,
      agentSlug: args.agentSlug,
      scopeType: args.scopeType,
      scopeId: args.scopeId,
      turnId: args.turnId,
      includes: JSON.stringify(args.includes ?? ["full"]),
      maxBytes,
      maxUses,
      expiresAt: new Date(Date.now() + ttlMs),
    },
    select: { id: true, expiresAt: true, maxBytes: true, maxUses: true },
  });
  return { token, grant };
}

export async function createContextGrantUrl(args: {
  baseUrl: string;
  agentSlug: string;
  scopeType: ContextScopeType;
  scopeId: string;
  turnId: string;
  runId?: string | null;
  includes?: string[];
}) {
  const { token } = await createContextGrant(args);
  const url = new URL(`/api/agents/context/${args.scopeType}/${args.scopeId}`, args.baseUrl);
  url.searchParams.set("grant", token);
  return url.toString();
}

export async function authenticateContextGrant(args: {
  scopeType: ContextScopeType;
  scopeId: string;
  token: string;
}) {
  if (!args.token) return null;
  const tokenHash = hashToken(args.token);
  const grant = await db.contextGrant.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tokenHash: true,
      agentSlug: true,
      scopeType: true,
      scopeId: true,
      maxUses: true,
      usedCount: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  const now = new Date();
  if (
    !grant ||
    !eq(grant.tokenHash, tokenHash) ||
    grant.scopeType !== args.scopeType ||
    grant.scopeId !== args.scopeId ||
    grant.revokedAt ||
    grant.expiresAt <= now ||
    grant.usedCount >= grant.maxUses
  ) {
    return null;
  }

  await db.contextGrant.update({
    where: { id: grant.id },
    data: {
      usedCount: { increment: 1 },
      lastUsedAt: now,
    },
  });
  return {
    grantId: grant.id,
    agentSlug: grant.agentSlug,
  };
}

export interface ContextGrantSummary {
  total: number;
  active: number;
  expired: number;
  revoked: number;
  exhausted: number;
  oldestActiveAgeMs: number | null;
  maxUsedCount: number;
}

/**
 * Read-only inventory of context grants for token age/rotation visibility.
 * A grant is "active" when it is not revoked, not past expiry, and still has
 * uses remaining. Buckets are mutually exclusive in priority order
 * revoked > expired > exhausted > active so each grant counts once.
 */
export async function summarizeContextGrants(now: Date = new Date()): Promise<ContextGrantSummary> {
  const grants = await db.contextGrant.findMany({
    select: {
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      maxUses: true,
      usedCount: true,
    },
  });

  const summary: ContextGrantSummary = {
    total: grants.length,
    active: 0,
    expired: 0,
    revoked: 0,
    exhausted: 0,
    oldestActiveAgeMs: null,
    maxUsedCount: 0,
  };

  for (const grant of grants) {
    if (grant.usedCount > summary.maxUsedCount) summary.maxUsedCount = grant.usedCount;

    if (grant.revokedAt) {
      summary.revoked += 1;
      continue;
    }
    if (grant.expiresAt <= now) {
      summary.expired += 1;
      continue;
    }
    if (grant.usedCount >= grant.maxUses) {
      summary.exhausted += 1;
      continue;
    }
    summary.active += 1;
    const ageMs = now.getTime() - grant.createdAt.getTime();
    if (summary.oldestActiveAgeMs === null || ageMs > summary.oldestActiveAgeMs) {
      summary.oldestActiveAgeMs = ageMs;
    }
  }

  return summary;
}
