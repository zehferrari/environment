// OpenClaw gateway client for the per-agent /hooks/wake endpoint.
//
// Each agent on this host runs an openclaw-gateway process listening
// on 127.0.0.1:<gateway_port>. /hooks/wake takes
// { text, mode? } and enqueues a system event on the agent's main
// session — the same surface OpenClaw cron jobs and webhook routers
// already use (see docs/automation/cron-jobs.md POST /hooks/wake).
//
// Bearer tokens are per-agent and must not be reused across agents.
// We resolve them from a JSON map at PM_CONSUMER_HOOK_TOKEN_FILE
// (default /etc/openclaw/pm-consumer-tokens.json), with a per-agent
// env override PM_CONSUMER_HOOK_TOKEN_<UPPERCASE_SLUG> for local-dev
// and test setups. An unresolved token surfaces as a delivery error
// without falling back to an empty Authorization header.

import { readFile } from "fs/promises";

export interface WakeArgs {
  gatewayPort: number;
  slug: string;
  text: string;
  mode?: "now" | "next-heartbeat";
  // Test seam — fetch impl override.
  fetchImpl?: typeof fetch;
}

export interface WakeResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const DEFAULT_TOKEN_FILE =
  process.env.PM_CONSUMER_HOOK_TOKEN_FILE ??
  "/etc/openclaw/pm-consumer-tokens.json";

let tokenCache:
  | { at: number; tokens: Record<string, string> }
  | null = null;
const TOKEN_CACHE_MS = 10_000;

async function loadTokenMap(path: string): Promise<Record<string, string>> {
  const now = Date.now();
  if (tokenCache && now - tokenCache.at < TOKEN_CACHE_MS) {
    return tokenCache.tokens;
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, string>;
    tokenCache = { at: now, tokens: parsed };
    return parsed;
  } catch (err) {
    // File-missing is a normal local-dev state — fall through to env vars.
    tokenCache = { at: now, tokens: {} };
    return {};
  }
}

export function __resetGatewayTokenCacheForTests(): void {
  tokenCache = null;
}

export async function resolveHookToken(slug: string): Promise<string | null> {
  const envKey = `PM_CONSUMER_HOOK_TOKEN_${slug.toUpperCase()}`;
  const env = process.env[envKey];
  if (env) return env;
  const file =
    process.env.PM_CONSUMER_HOOK_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  const map = await loadTokenMap(file);
  return map[slug] ?? null;
}

export async function wakeAgent(args: WakeArgs): Promise<WakeResult> {
  const token = await resolveHookToken(args.slug);
  if (!token) {
    return {
      ok: false,
      error: `missing hook token for agent "${args.slug}" (set PM_CONSUMER_HOOK_TOKEN_${args.slug.toUpperCase()} or add to PM_CONSUMER_HOOK_TOKEN_FILE)`,
    };
  }
  const url = `http://127.0.0.1:${args.gatewayPort}/hooks/wake`;
  const f = args.fetchImpl ?? fetch;
  try {
    const res = await f(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ text: args.text, mode: args.mode ?? "now" }),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, error: `gateway ${res.status}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
