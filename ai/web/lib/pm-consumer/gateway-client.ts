// OpenClaw gateway client for per-agent wake delivery.
//
// Each agent on this host runs an openclaw-gateway process listening
// on 127.0.0.1:<gateway_port>. /hooks/wake takes
// { text, mode?, sessionKey? } and enqueues a system event on the
// addressed session — the same surface OpenClaw cron jobs and webhook
// routers already use (see docs/automation/cron-jobs.md POST
// /hooks/wake).
// Newer local OpenClaw installs may omit that HTTP hook; in that case
// the consumer falls back to the monitor agent's host-local
// openclaw-control bridge.
//
// Bearer tokens are per-agent and must not be reused across agents.
// We resolve them from a JSON map at PM_CONSUMER_HOOK_TOKEN_FILE
// (default /etc/openclaw/pm-consumer-tokens.json), with a per-agent
// env override PM_CONSUMER_HOOK_TOKEN_<UPPERCASE_SLUG> for local-dev
// and test setups. An unresolved token never produces an empty
// Authorization header; it goes straight to the monitor fallback.

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface WakeArgs {
  gatewayPort: number;
  slug: string;
  text: string;
  mode?: "now" | "next-heartbeat";
  sessionKey?: string | null;
  // Test seam — fetch impl override.
  fetchImpl?: typeof fetch;
}

export interface WakeResult {
  ok: boolean;
  status?: number;
  error?: string;
  driver?: "gateway-http" | "karen-control";
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
    return wakeViaKarenControl(
      args,
      `missing hook token for agent "${args.slug}"`,
    );
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
      body: JSON.stringify({
        text: args.text,
        mode: args.mode ?? "now",
        ...(args.sessionKey ? { sessionKey: args.sessionKey } : {}),
      }),
    });
    if (!res.ok) {
      return wakeViaKarenControl(args, `gateway ${res.status}`, res.status);
    }
    return { ok: true, status: res.status, driver: "gateway-http" };
  } catch (err) {
    return wakeViaKarenControl(
      args,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function karenFallbackEnabled() {
  return (
    process.env.PM_CONSUMER_MONITOR_WAKE_FALLBACK
      ?? process.env.PM_CONSUMER_KAREN_WAKE_FALLBACK
  ) !== "off";
}

function karenWakeHelperPath() {
  return process.env.PM_MONITOR_WAKE_HELPER
    ?? process.env.PM_KAREN_WAKE_HELPER
    ?? "/usr/local/sbin/pm-karen-wake-agent";
}

async function wakeViaKarenControl(
  args: WakeArgs,
  reason: string,
  status?: number,
): Promise<WakeResult> {
  if (!karenFallbackEnabled()) {
    return { ok: false, status, error: reason, driver: "gateway-http" };
  }
  try {
    const commandArgs = [
      "-n",
      karenWakeHelperPath(),
      args.slug,
    ];
    if (args.sessionKey) {
      commandArgs.push("--session-key", args.sessionKey);
    }
    commandArgs.push(args.text);

    await execFileAsync("sudo", commandArgs, {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, status, driver: "karen-control" };
  } catch (err) {
    const fallbackError = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status,
      driver: "karen-control",
      error: `${reason}; monitor wake fallback failed: ${fallbackError}`,
    };
  }
}
