// AF_UNIX listener — primary transport per HOMELAB-45 In Review memo
// (commentId 12162). Newline-delimited JSON, one envelope per
// connection-end (matching the producer side's unix-socket driver).
// We accept many lines per connection so an upstream pipeline that
// batches replays still works.

import { createServer, type Server } from "net";
import { unlink } from "fs/promises";
import type { ConsumerHandler, HandleOutcome } from "./handler";

export interface SocketListenerOptions {
  path: string;
  handler: ConsumerHandler;
  onOutcome?: (outcome: HandleOutcome) => void;
}

export async function startSocketListener(
  opts: SocketListenerOptions,
): Promise<{ server: Server; stop: () => Promise<void> }> {
  try {
    await unlink(opts.path);
  } catch {
    // No prior socket file — fine.
  }
  const server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
    });
    conn.on("end", async () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch (err) {
          opts.onOutcome?.({
            kind: "rejected",
            error: `socket: invalid JSON line: ${(err as Error).message}`,
          });
          continue;
        }
        const outcome = await opts.handler.handle(raw);
        opts.onOutcome?.(outcome);
      }
    });
    conn.on("error", (err) => {
      opts.onOutcome?.({
        kind: "rejected",
        error: `socket conn error: ${err.message}`,
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.path, () => resolve());
  });

  return {
    server,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await unlink(opts.path);
      } catch {
        // ignore
      }
    },
  };
}
