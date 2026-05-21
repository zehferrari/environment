type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

let lastSweep = 0;
function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

function hit(key: string, limit: number, windowMs: number, now: number): {
  ok: boolean;
  retryAfterSec: number;
} {
  sweep(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSec: 0 };
  }
  if (existing.count >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((existing.resetAt - now) / 1000) };
  }
  existing.count += 1;
  return { ok: true, retryAfterSec: 0 };
}

export type RateLimitResult = {
  ok: boolean;
  reason?: "ip" | "username";
  retryAfterSec?: number;
};

/**
 * Sliding-fixed-window login rate limit for v1 (single host, in-process).
 * Per-IP: 10 attempts / 5 min. Per-username: 5 attempts / 5 min.
 * Both buckets are decremented on every authorize call (success or failure)
 * — easier audit than failure-only and still allows ~5 good logins per user
 * before a forced cooldown. Aborts the auth flow before any DB lookup.
 */
export function checkLoginRateLimit(
  ip: string | null,
  username: string,
  now = Date.now(),
): RateLimitResult {
  const ipKey = `ip:${ip ?? "unknown"}`;
  const userKey = `user:${username.toLowerCase()}`;

  const ipHit = hit(ipKey, 10, 5 * 60_000, now);
  if (!ipHit.ok) return { ok: false, reason: "ip", retryAfterSec: ipHit.retryAfterSec };

  const userHit = hit(userKey, 5, 5 * 60_000, now);
  if (!userHit.ok) return { ok: false, reason: "username", retryAfterSec: userHit.retryAfterSec };

  return { ok: true };
}

export function clientIpFromRequest(req: Request | undefined): string | null {
  const h = req?.headers;
  if (!h) return null;
  const xff = h.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const realIp = h.get("x-real-ip");
  if (realIp) return realIp.trim();
  return null;
}

/** Test-only — reset the in-memory store. */
export function __resetRateLimitForTests() {
  buckets.clear();
  lastSweep = 0;
}
