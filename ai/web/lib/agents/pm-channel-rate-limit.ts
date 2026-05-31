type Bucket = {
  tokens: number;
  updatedAt: number;
};

type BucketPlan = {
  key: string;
  next: Bucket;
  retryAfterSeconds: number;
};

type CallbackKind = "reply" | "stream";

const buckets = new Map<string, Bucket>();

function numberFromEnv(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function limitsForKind(kind: CallbackKind) {
  const windowMs = numberFromEnv("PM_CHANNEL_RATE_WINDOW_MS", 10_000);
  if (kind === "reply") {
    return {
      windowMs,
      agent: numberFromEnv("PM_CHANNEL_REPLY_RATE_AGENT", 60),
      target: numberFromEnv("PM_CHANNEL_REPLY_RATE_TARGET", 6),
    };
  }
  return {
    windowMs,
    agent: numberFromEnv("PM_CHANNEL_STREAM_RATE_AGENT", 1_500),
    target: numberFromEnv("PM_CHANNEL_STREAM_RATE_TARGET", 300),
  };
}

function planBucket(
  key: string,
  capacity: number,
  windowMs: number,
  nowMs: number,
): BucketPlan {
  const current = buckets.get(key) ?? { tokens: capacity, updatedAt: nowMs };
  const refillRate = capacity / windowMs;
  const elapsed = Math.max(0, nowMs - current.updatedAt);
  const tokens = Math.min(capacity, current.tokens + elapsed * refillRate);
  if (tokens < 1) {
    return {
      key,
      next: { tokens, updatedAt: nowMs },
      retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillRate / 1000)),
    };
  }
  return {
    key,
    next: { tokens: tokens - 1, updatedAt: nowMs },
    retryAfterSeconds: 0,
  };
}

export function checkPmChannelCallbackRateLimit(args: {
  kind: CallbackKind;
  agentSlug: string;
  targetKey: string;
  nowMs?: number;
  limits?: { agent: number; target: number; windowMs: number };
}) {
  const nowMs = args.nowMs ?? Date.now();
  const limits = args.limits ?? limitsForKind(args.kind);
  const agentPlan = planBucket(
    `pm-channel:${args.kind}:agent:${args.agentSlug}`,
    limits.agent,
    limits.windowMs,
    nowMs,
  );
  const targetPlan = planBucket(
    `pm-channel:${args.kind}:target:${args.targetKey}`,
    limits.target,
    limits.windowMs,
    nowMs,
  );

  if (agentPlan.retryAfterSeconds > 0 || targetPlan.retryAfterSeconds > 0) {
    return {
      allowed: false as const,
      retryAfterSeconds: Math.max(agentPlan.retryAfterSeconds, targetPlan.retryAfterSeconds),
    };
  }

  buckets.set(agentPlan.key, agentPlan.next);
  buckets.set(targetPlan.key, targetPlan.next);
  return {
    allowed: true as const,
    remaining: Math.floor(Math.min(agentPlan.next.tokens, targetPlan.next.tokens)),
  };
}

export function resetPmChannelCallbackRateLimitsForTest() {
  buckets.clear();
}
