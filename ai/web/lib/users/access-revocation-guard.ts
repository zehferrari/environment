import { getViewerByUserId, type Viewer } from "@/lib/auth/permissions";
import { subscribeAccessChanges } from "@/lib/users/access-change-hub";

export type RevocationGuardOptions = {
  userId: string;
  /** Send one SSE event (used for the terminal `access-revoked` notification). */
  send: (event: string, data: unknown) => void;
  /** Full cleanup + terminal close of the stream (must be idempotent). */
  close: () => void;
  /**
   * Fresh authorization check with the re-resolved viewer (null when the
   * account itself is gone or deactivated). Resolve false to revoke.
   */
  stillAuthorized: (viewer: Viewer | null) => Promise<boolean> | boolean;
  /** Injectable viewer resolution; defaults to the session-free DB re-read. */
  resolveViewer?: (userId: string) => Promise<Viewer | null>;
  /** Fallback re-check interval bounding a missed hub event (default 25s). */
  heartbeatMs?: number;
};

/**
 * Live-stream revocation guard (ENV-168). SSE routes authenticate once at
 * connect and would otherwise keep serving under the old policy indefinitely.
 * The guard re-evaluates the viewer's authorization on every access-change
 * hub event for that user and on a periodic heartbeat fallback. When the
 * check fails it emits one explicit `access-revoked` event and closes the
 * stream terminally — the client stops reconnecting and refreshes into the
 * safe denied state. Transient read errors never revoke a stream on their
 * own; the next heartbeat simply re-checks.
 */
export function attachRevocationGuard(options: RevocationGuardOptions): { stop: () => void } {
  const {
    userId,
    send,
    close,
    stillAuthorized,
    resolveViewer = getViewerByUserId,
    heartbeatMs = 25_000,
  } = options;

  let stopping = false;
  let checking = false;

  const unsubscribe = subscribeAccessChanges(userId, () => {
    void check();
  });
  const timer = setInterval(() => {
    void check();
  }, heartbeatMs);

  async function check(): Promise<void> {
    if (stopping || checking) return;
    checking = true;
    try {
      const viewer = await resolveViewer(userId);
      if (!(await stillAuthorized(viewer))) {
        stopping = true;
        clearInterval(timer);
        unsubscribe();
        try {
          // Exactly one explicit terminal event, then the stream closes.
          send("access-revoked", { type: "access-revoked" });
        } catch {
          // stream already closed — nothing to notify
        }
        close();
      }
    } catch {
      // Transient read errors never revoke a live stream on their own; the
      // next heartbeat re-checks.
    } finally {
      checking = false;
    }
  }

  return {
    stop: () => {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      unsubscribe();
    },
  };
}
