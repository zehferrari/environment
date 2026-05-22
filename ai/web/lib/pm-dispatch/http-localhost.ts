// HTTP-localhost driver — explicit opt-in only. Per HOMELAB-46 plan,
// this is stubbed behind config and not wired into the default
// selector; tests construct it directly. Kept here so the seam exists
// the moment a localhost listener becomes useful (e.g. a dev shim).

import type { PmEvent } from "@/lib/pm-events";
import type { DispatchDriver, DispatchResult } from "./index";

export interface HttpLocalhostDriverOptions {
  url: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function createHttpLocalhostDriver(
  opts: HttpLocalhostDriverOptions,
): DispatchDriver {
  const f = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 1000;
  return {
    name: "http-localhost",
    async send(event: PmEvent): Promise<DispatchResult> {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await f(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
          signal: ac.signal,
        });
        if (!res.ok) {
          return {
            ok: false,
            driver: "http-localhost",
            error: `HTTP ${res.status}`,
            receipt: { status: res.status },
          };
        }
        return {
          ok: true,
          driver: "http-localhost",
          receipt: { status: res.status },
        };
      } catch (err) {
        return {
          ok: false,
          driver: "http-localhost",
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
