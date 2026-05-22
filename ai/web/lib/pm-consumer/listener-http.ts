// HTTP localhost listener — explicit-opt-in only, per HOMELAB-45 In
// Review memo: "localhost HTTP escape hatch behind flag". We bind to
// 127.0.0.1 by default (never 0.0.0.0) and require a shared secret
// in PM_CONSUMER_HTTP_TOKEN so a misconfigured deployment cannot
// expose the wake surface to other host users. The listener is
// inactive unless the caller explicitly constructs it.

import { createServer, type Server } from "http";
import type { ConsumerHandler, HandleOutcome } from "./handler";

export interface HttpListenerOptions {
  port: number;
  host?: string;
  token: string;
  handler: ConsumerHandler;
  onOutcome?: (outcome: HandleOutcome) => void;
}

export async function startHttpListener(
  opts: HttpListenerOptions,
): Promise<{ server: Server; stop: () => Promise<void>; port: number }> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/events") {
      res.statusCode = 404;
      res.end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    const expected = `Bearer ${opts.token}`;
    if (auth !== expected) {
      res.statusCode = 401;
      res.end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      res.statusCode = 400;
      res.end(`invalid JSON: ${(err as Error).message}`);
      opts.onOutcome?.({
        kind: "rejected",
        error: `http: invalid JSON: ${(err as Error).message}`,
      });
      return;
    }
    const outcome = await opts.handler.handle(parsed);
    opts.onOutcome?.(outcome);
    res.setHeader("content-type", "application/json");
    res.statusCode = outcome.kind === "rejected" ? 400 : 200;
    res.end(JSON.stringify(outcome));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    server,
    port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
