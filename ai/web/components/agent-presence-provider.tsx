"use client";

// One live agent-presence feed per tab. The provider (mounted once in the app
// layout) owns a single EventSource to /api/agents/presence and writes into a
// module-level store; any component can read a slug's live status through
// useAgentStatus without prop drilling. Server components keep passing their
// render-time status as `initialStatus`, which is also the SSR/hydration value
// until the stream delivers the first presence map.

import { useEffect, useSyncExternalStore } from "react";

type PresencePayload = {
  type?: string;
  agents?: Record<string, string>;
};

const EMPTY_MAP: Record<string, string> = {};

const statuses = new Map<string, string>();
const listeners = new Set<() => void>();
// Immutable snapshot of `statuses` for useSyncExternalStore consumers that
// need the whole map (sidebar ordering); replaced only when something changed.
let mapSnapshot: Record<string, string> = EMPTY_MAP;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function applyPresence(agents: Record<string, string>) {
  let changed = false;
  const nextSlugs = new Set(Object.keys(agents));
  for (const slug of [...statuses.keys()]) {
    if (!nextSlugs.has(slug)) {
      statuses.delete(slug);
      changed = true;
    }
  }
  for (const [slug, status] of Object.entries(agents)) {
    if (statuses.get(slug) !== status) {
      statuses.set(slug, status);
      changed = true;
    }
  }
  if (!changed) return;
  mapSnapshot = Object.fromEntries(statuses);
  listeners.forEach((listener) => listener());
}

/**
 * Live status for one agent. Falls back to `initialStatus` (the server-render
 * value) until the presence stream has reported, and to "none" for humans /
 * unknown slugs. SSR-safe: the server snapshot is always `initialStatus`.
 */
export function useAgentStatus(
  slug?: string | null,
  initialStatus?: string | null,
): string {
  return useSyncExternalStore(
    subscribe,
    () => (slug ? statuses.get(slug) ?? initialStatus ?? "none" : initialStatus ?? "none"),
    () => initialStatus ?? "none",
  );
}

/** Live slug→status map (empty until the stream reports). */
export function useAgentPresenceMap(): Record<string, string> {
  return useSyncExternalStore(
    subscribe,
    () => mapSnapshot,
    () => EMPTY_MAP,
  );
}

export function AgentPresenceProvider({ children }: { children?: React.ReactNode }) {
  // Connection lifecycle mirrors board-client's EventSource handling:
  // exponential backoff on errors, drop the connection while the tab is
  // hidden, reconnect on visibility. Non-owner viewers get a 401/403, which
  // surfaces as an error here — the backoff caps the retry cost and every
  // avatar simply keeps rendering its SSR initialStatus.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = 1000;
    let closed = false;

    const connect = () => {
      if (closed || document.hidden) return;
      try {
        source = new EventSource("/api/agents/presence");
      } catch {
        return;
      }
      source.onopen = () => {
        retryMs = 1000;
      };
      source.onmessage = (event) => {
        let payload: PresencePayload | null = null;
        try {
          payload = JSON.parse(event.data) as PresencePayload;
        } catch {
          return;
        }
        if (payload?.type === "presence" && payload.agents) applyPresence(payload.agents);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 60_000);
      };
    };

    const onVisibility = () => {
      if (document.hidden) {
        source?.close();
        source = null;
      } else if (!source) {
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return <>{children}</>;
}
