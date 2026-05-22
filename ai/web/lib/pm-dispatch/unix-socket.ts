// Unix-domain-socket driver. One AF_UNIX SOCK_STREAM connection per
// event, newline-delimited JSON, no in-process queue. The listener
// side (future: OpenClaw) reads framed JSON and acks via close.
// Keeping this strictly per-event keeps backpressure & ordering on the
// kernel side and avoids us holding any agent state in-webapp.

import { createConnection } from "net";
import type { PmEvent } from "@/lib/pm-events";
import type { DispatchDriver, DispatchResult } from "./index";

export interface UnixSocketDriverOptions {
  path: string;
  connectTimeoutMs?: number;
}

export function createUnixSocketDriver(
  opts: UnixSocketDriverOptions,
): DispatchDriver {
  const connectTimeoutMs = opts.connectTimeoutMs ?? 1000;
  return {
    name: "unix-socket",
    async send(event: PmEvent): Promise<DispatchResult> {
      const line = JSON.stringify(event) + "\n";
      return new Promise<DispatchResult>((resolve) => {
        const socket = createConnection(opts.path);
        let settled = false;
        const finish = (r: DispatchResult) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve(r);
        };
        const timer = setTimeout(
          () =>
            finish({
              ok: false,
              driver: "unix-socket",
              error: `connect timeout after ${connectTimeoutMs}ms`,
            }),
          connectTimeoutMs,
        );
        socket.once("error", (err) => {
          clearTimeout(timer);
          finish({
            ok: false,
            driver: "unix-socket",
            error: err.message,
          });
        });
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.end(line, () =>
            finish({
              ok: true,
              driver: "unix-socket",
              receipt: { bytes: Buffer.byteLength(line) },
            }),
          );
        });
      });
    },
  };
}
