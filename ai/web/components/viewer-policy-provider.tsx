"use client";

// ENV-168 — always-on viewer policy channel. One EventSource per tab,
// mounted in the app layout for every authenticated viewer (outside the
// owner-features conditional), so a revoked or role-changed viewer parked on
// any route — including non-board task/epic detail pages with no board
// stream — learns about the change immediately. Payload is a single epoch
// integer (User.policyVersion): a changed epoch triggers router.refresh(),
// which re-runs the server render (authorization is re-read from the
// database per request) so the tab degrades into the safe not-found/denied
// state instead of showing stale data. Terminal authz closes stop the
// EventSource permanently — the browser fails the connection on non-200 and
// we close explicitly, so a revoked tab never loops on reconnects.

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

const POLICY_STREAM_PATH = "/api/viewer/policy/stream";

export function ViewerPolicyProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const epochRef = useRef<number | null>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let source: EventSource | null = null;
    let stopped = false;

    const settle = () => {
      // One refresh into the safe denied/not-found state; never loop.
      if (settledRef.current) return;
      settledRef.current = true;
      router.refresh();
    };

    const connect = () => {
      if (stopped) return;
      source = new EventSource(POLICY_STREAM_PATH);

      source.addEventListener("policy-version", (event) => {
        const epoch = Number((event as MessageEvent).data);
        if (Number.isFinite(epoch)) epochRef.current = epoch;
      });

      source.addEventListener("policy-changed", (event) => {
        const epoch = Number((event as MessageEvent).data);
        if (!Number.isFinite(epoch)) return;
        if (epochRef.current !== null && epoch === epochRef.current) return;
        epochRef.current = epoch;
        // Re-run the server render: authorization re-reads from the
        // database per request, so the current route resolves to its
        // post-change state (safe not-found/denied for a revoked viewer).
        router.refresh();
      });

      source.addEventListener("error", () => {
        // readyState CLOSED = terminal failure (401/403 at connect after a
        // revocation). Stop reconnecting and settle this tab. CONNECTING
        // (transient network drop) keeps the browser retry; the durable
        // epoch compare on reconnect catches anything missed while offline.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          source = null;
          stopped = true;
          settle();
        }
      });
    };

    connect();

    return () => {
      stopped = true;
      source?.close();
    };
  }, [router]);

  return <>{children}</>;
}
