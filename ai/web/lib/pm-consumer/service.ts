// Long-running consumer service bootstrap. Reads env, starts the
// configured listeners, exposes a single stop() so an operator (or
// the test harness) can tear them all down cleanly.
//
// Transport selection follows HOMELAB-45 In Review:
//   - AF_UNIX socket: primary, always enabled when PM_CONSUMER_SOCKET
//     is set.
//   - File-drop: fallback, always enabled when PM_CONSUMER_DROP_DIR
//     is set. Both can run concurrently so an outage of one doesn't
//     starve the consumer.
//   - HTTP localhost: explicit opt-in via --http <port> or
//     PM_CONSUMER_HTTP_PORT, and requires PM_CONSUMER_HTTP_TOKEN.
//     In-process is not a transport — we never expose a function-
//     call API for the consumer to defend the rule layer boundary.

import { startSocketListener } from "./listener-socket";
import { startFileDropListener } from "./listener-filedrop";
import { startHttpListener } from "./listener-http";
import { createHandler, type HandleOutcome } from "./handler";

export interface ServiceConfig {
  socketPath?: string;
  dropDir?: string;
  http?: { port: number; token: string };
  onOutcome?: (outcome: HandleOutcome, source: string) => void;
}

export interface ServiceHandle {
  stop: () => Promise<void>;
  legs: { name: "socket" | "file-drop" | "http"; detail: string }[];
}

export function readServiceConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const cfg: ServiceConfig = {};
  if (env.PM_CONSUMER_SOCKET) cfg.socketPath = env.PM_CONSUMER_SOCKET;
  if (env.PM_CONSUMER_DROP_DIR) cfg.dropDir = env.PM_CONSUMER_DROP_DIR;
  if (env.PM_CONSUMER_HTTP_PORT) {
    const port = Number(env.PM_CONSUMER_HTTP_PORT);
    const token = env.PM_CONSUMER_HTTP_TOKEN;
    if (!Number.isFinite(port)) {
      throw new Error(
        `PM_CONSUMER_HTTP_PORT not numeric: ${env.PM_CONSUMER_HTTP_PORT}`,
      );
    }
    if (!token) {
      throw new Error(
        "PM_CONSUMER_HTTP_PORT set without PM_CONSUMER_HTTP_TOKEN — HTTP transport refuses to start without a bearer token",
      );
    }
    cfg.http = { port, token };
  }
  return cfg;
}

export async function startService(
  cfg: ServiceConfig = readServiceConfigFromEnv(),
): Promise<ServiceHandle> {
  if (!cfg.socketPath && !cfg.dropDir && !cfg.http) {
    throw new Error(
      "pm-consumer: at least one of PM_CONSUMER_SOCKET / PM_CONSUMER_DROP_DIR / PM_CONSUMER_HTTP_PORT must be set",
    );
  }
  const handler = createHandler();
  const stops: Array<() => Promise<void>> = [];
  const legs: ServiceHandle["legs"] = [];

  if (cfg.socketPath) {
    const { stop } = await startSocketListener({
      path: cfg.socketPath,
      handler,
      onOutcome: (o) => cfg.onOutcome?.(o, "socket"),
    });
    stops.push(stop);
    legs.push({ name: "socket", detail: cfg.socketPath });
  }
  if (cfg.dropDir) {
    const { stop } = await startFileDropListener({
      dir: cfg.dropDir,
      handler,
      onOutcome: (o) => cfg.onOutcome?.(o, "file-drop"),
    });
    stops.push(stop);
    legs.push({ name: "file-drop", detail: cfg.dropDir });
  }
  if (cfg.http) {
    const { stop, port } = await startHttpListener({
      port: cfg.http.port,
      token: cfg.http.token,
      handler,
      onOutcome: (o) => cfg.onOutcome?.(o, "http"),
    });
    stops.push(stop);
    legs.push({ name: "http", detail: `127.0.0.1:${port}` });
  }

  return {
    legs,
    async stop() {
      for (const s of stops.reverse()) {
        try {
          await s();
        } catch {
          // ignore — best-effort shutdown
        }
      }
    },
  };
}
