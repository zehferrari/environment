import type { PmChannelReplyTarget, PmChannelTurnKind } from "@/lib/agents/openclaw-pm-channel";

export type PmChannelWarmPoolStatus = "hit" | "miss" | "disabled";

export interface PmChannelWarmAgentHint {
  version: 1;
  key: string;
  sessionKey: string;
  status: PmChannelWarmPoolStatus;
  ttlMs: number;
  maxEntries: number;
  expiresAt: string | null;
}

export interface PmChannelWarmPoolLease {
  hint: PmChannelWarmAgentHint;
  hit: boolean;
  release(success?: boolean): void;
}

interface WarmPoolEntry {
  key: string;
  sessionKey: string;
  lastUsedAt: number;
  expiresAt: number;
  activeLeases: number;
  useCount: number;
}

interface WarmPoolStore {
  entries: Map<string, WarmPoolEntry>;
}

type GlobalWithWarmPool = typeof globalThis & {
  __vixiPmChannelWarmPool?: WarmPoolStore;
};

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4;

function flagDisabled(value: string | undefined) {
  return value === "0" || value === "false" || value === "no" || value === "off";
}

function intFromEnv(value: string | undefined, fallback: number, min: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

export function pmChannelWarmPoolEnabled(env: NodeJS.ProcessEnv = process.env) {
  return !flagDisabled(env.PM_CHANNEL_WARM_POOL_ENABLED);
}

export function pmChannelWarmPoolTtlMs(env: NodeJS.ProcessEnv = process.env) {
  return intFromEnv(env.PM_CHANNEL_WARM_POOL_TTL_MS, DEFAULT_TTL_MS, 30_000);
}

export function pmChannelWarmPoolMaxEntries(env: NodeJS.ProcessEnv = process.env) {
  return intFromEnv(env.PM_CHANNEL_WARM_POOL_MAX_ENTRIES, DEFAULT_MAX_ENTRIES, 1);
}

function store(): WarmPoolStore {
  const globalStore = globalThis as GlobalWithWarmPool;
  globalStore.__vixiPmChannelWarmPool ??= { entries: new Map() };
  return globalStore.__vixiPmChannelWarmPool;
}

function stripTurnSuffix(sessionKey: string) {
  const marker = ":turn:";
  const idx = sessionKey.indexOf(marker);
  return idx >= 0 ? sessionKey.slice(0, idx) : sessionKey;
}

function safeKeyPart(value: string | null | undefined) {
  return (value ?? "-").trim().replace(/[^A-Za-z0-9_.:-]/g, "_") || "-";
}

export function pmChannelWarmPoolKey(args: {
  agentSlug: string;
  kind: PmChannelTurnKind;
  sessionKey: string;
  replyTarget: PmChannelReplyTarget;
}) {
  const target = args.replyTarget;
  const scope = target.kind === "direct"
    ? "direct"
    : target.kind === "epic-chat"
      ? `epic:${target.epicId}`
      : `task:${target.taskId}`;
  return [
    "pm-warm",
    safeKeyPart(args.agentSlug),
    safeKeyPart(args.kind),
    safeKeyPart(scope),
    safeKeyPart(stripTurnSuffix(args.sessionKey)),
  ].join(":");
}

function warmSessionKey(baseSessionKey: string, key: string) {
  const base = stripTurnSuffix(baseSessionKey);
  const suffix = Buffer.from(key).toString("base64url").slice(0, 32);
  return `${base}:warm:${suffix}`;
}

function sweepExpired(now: number) {
  const entries = store().entries;
  for (const [key, entry] of entries) {
    if (entry.activeLeases <= 0 && entry.expiresAt <= now) {
      entries.delete(key);
    }
  }
}

function evictLru(maxEntries: number) {
  const entries = store().entries;
  while (entries.size > maxEntries) {
    const idle = [...entries.values()]
      .filter((entry) => entry.activeLeases <= 0)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (!idle) break;
    entries.delete(idle.key);
  }
}

function makeHint(entry: WarmPoolEntry, status: PmChannelWarmPoolStatus, ttlMs: number, maxEntries: number): PmChannelWarmAgentHint {
  return {
    version: 1,
    key: entry.key,
    sessionKey: entry.sessionKey,
    status,
    ttlMs,
    maxEntries,
    expiresAt: Number.isFinite(entry.expiresAt) ? new Date(entry.expiresAt).toISOString() : null,
  };
}

export function acquirePmChannelWarmAgent(args: {
  agentSlug: string;
  kind: PmChannelTurnKind;
  sessionKey: string;
  replyTarget: PmChannelReplyTarget;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): PmChannelWarmPoolLease {
  const env = args.env ?? process.env;
  const ttlMs = pmChannelWarmPoolTtlMs(env);
  const maxEntries = pmChannelWarmPoolMaxEntries(env);
  const now = args.now ?? Date.now();
  const key = pmChannelWarmPoolKey(args);

  if (!pmChannelWarmPoolEnabled(env)) {
    const disabled: WarmPoolEntry = {
      key,
      sessionKey: warmSessionKey(args.sessionKey, key),
      lastUsedAt: now,
      expiresAt: Number.NaN,
      activeLeases: 0,
      useCount: 0,
    };
    return { hint: makeHint(disabled, "disabled", ttlMs, maxEntries), hit: false, release: () => undefined };
  }

  sweepExpired(now);
  const entries = store().entries;
  const existing = entries.get(key);
  const hit = Boolean(existing && existing.expiresAt > now);
  const entry = existing ?? {
    key,
    sessionKey: warmSessionKey(args.sessionKey, key),
    lastUsedAt: now,
    expiresAt: now + ttlMs,
    activeLeases: 0,
    useCount: 0,
  };

  entry.lastUsedAt = now;
  entry.expiresAt = now + ttlMs;
  entry.activeLeases += 1;
  entry.useCount += 1;
  entries.set(key, entry);
  evictLru(maxEntries);

  let released = false;
  return {
    hint: makeHint(entry, hit ? "hit" : "miss", ttlMs, maxEntries),
    hit,
    release(success = true) {
      if (released) return;
      released = true;
      const current = entries.get(key);
      if (!current) return;
      current.activeLeases = Math.max(0, current.activeLeases - 1);
      current.lastUsedAt = Date.now();
      if (!success) {
        entries.delete(key);
        return;
      }
      current.expiresAt = Date.now() + ttlMs;
      entries.set(key, current);
      sweepExpired(Date.now());
      evictLru(maxEntries);
    },
  };
}

export function pmChannelWarmPoolSnapshot(now = Date.now()) {
  sweepExpired(now);
  return [...store().entries.values()].map((entry) => ({
    key: entry.key,
    sessionKey: entry.sessionKey,
    activeLeases: entry.activeLeases,
    useCount: entry.useCount,
    expiresInMs: Math.max(0, entry.expiresAt - now),
    lastUsedAgoMs: Math.max(0, now - entry.lastUsedAt),
  }));
}

export function __resetPmChannelWarmPoolForTests() {
  store().entries.clear();
}
