// PM dispatch boundary (HOMELAB-46 Slice 1).
//
// Transport-agnostic seam that takes a PmEvent and hands it to a
// configured driver. Drivers are deliberately tiny and testable in
// isolation: enqueue an envelope, return a write receipt, surface
// transport errors as rejected promises.
//
// Selection is config-driven via PM_DISPATCH_DRIVER:
//   "unix-socket" (default, per HOMELAB-45 recommendation) — writes
//     newline-delimited JSON to PM_DISPATCH_SOCKET. Falls back through
//     onFatal so callers can quarantine if the listener is gone.
//   "file-drop" — writes one JSON file per event into
//     PM_DISPATCH_DROP_DIR using <occurredAt>-<id>.json (atomic via
//     write-then-rename).
//   "http-localhost" — explicit opt-in only; POSTs to PM_DISPATCH_HTTP_URL.
//     Not wired into the default selector; callers must construct the
//     driver directly.
//
// HOMELAB-44 enforcement is unchanged: dispatch happens after the
// workflow rule + persistence; failure to dispatch is logged and
// surfaced via DispatchResult.ok=false, never as a thrown rule error.

import type { PmEvent } from "@/lib/pm-events";

export interface DispatchResult {
  ok: boolean;
  driver: DispatchDriverName;
  // Driver-specific receipt (socket bytes written, file path written,
  // HTTP status). Free-form on purpose — observability only.
  receipt?: unknown;
  error?: string;
}

export type DispatchDriverName =
  | "unix-socket"
  | "file-drop"
  | "http-localhost";

export interface DispatchDriver {
  readonly name: DispatchDriverName;
  send(event: PmEvent): Promise<DispatchResult>;
}

export interface DispatcherConfig {
  driver: DispatchDriverName;
  socketPath?: string;
  dropDir?: string;
  httpUrl?: string;
}

export function readDispatcherConfig(
  env: NodeJS.ProcessEnv = process.env,
): DispatcherConfig {
  const raw = (env.PM_DISPATCH_DRIVER ?? "unix-socket").toLowerCase();
  const driver: DispatchDriverName =
    raw === "file-drop"
      ? "file-drop"
      : raw === "http-localhost"
        ? "http-localhost"
        : "unix-socket";
  return {
    driver,
    socketPath: env.PM_DISPATCH_SOCKET,
    dropDir: env.PM_DISPATCH_DROP_DIR,
    httpUrl: env.PM_DISPATCH_HTTP_URL,
  };
}

import { createUnixSocketDriver } from "./unix-socket";
import { createFileDropDriver } from "./file-drop";
import { createHttpLocalhostDriver } from "./http-localhost";

export function createDispatcher(
  cfg: DispatcherConfig = readDispatcherConfig(),
): DispatchDriver {
  switch (cfg.driver) {
    case "file-drop":
      if (!cfg.dropDir) {
        throw new Error("pm-dispatch: PM_DISPATCH_DROP_DIR required for file-drop");
      }
      return createFileDropDriver({ dir: cfg.dropDir });
    case "http-localhost":
      if (!cfg.httpUrl) {
        throw new Error("pm-dispatch: PM_DISPATCH_HTTP_URL required for http-localhost");
      }
      return createHttpLocalhostDriver({ url: cfg.httpUrl });
    case "unix-socket":
    default:
      if (!cfg.socketPath) {
        throw new Error("pm-dispatch: PM_DISPATCH_SOCKET required for unix-socket");
      }
      return createUnixSocketDriver({ path: cfg.socketPath });
  }
}

export { createUnixSocketDriver, createFileDropDriver, createHttpLocalhostDriver };
