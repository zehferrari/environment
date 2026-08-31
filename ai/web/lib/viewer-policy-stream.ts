import { subscribeAccessChanges } from "@/lib/users/access-change-hub";
import type { Viewer } from "@/lib/auth/permissions";

export type ViewerPolicyStreamOptions = {
  viewerId: string;
  /** Durable epoch read at connect time (User.policyVersion). */
  initialEpoch: number;
  /** Durable epoch source; null when the user row is gone. */
  readEpoch: () => Promise<number | null>;
  /** Session-free viewer re-resolution; null means terminal authz close. */
  resolveViewer: () => Promise<Viewer | null>;
  heartbeatMs?: number;
};

/**
 * Always-on viewer-scoped policy channel (ENV-168).
 *
 * Payload contract: the epoch integer ONLY. No role, scope, or project
 * content ever crosses this channel — it is open to every authenticated
 * viewer including Customers and must not become an inference vector.
 *
 * On connect the current epoch is emitted as `policy-version`: a
 * reconnecting tab that missed a change while offline learns it immediately.
 * Hub events and a periodic heartbeat both re-read the durable epoch — the
 * heartbeat bounds any missed in-process hub event by a database value
 * comparison, not by live-subscription presence. When the epoch moves the
 * stream emits `policy-changed` with the new integer and the client
 * refreshes, so the server render degrades into the safe not-found/denied
 * state. When the viewer no longer resolves (session/account revoked) the
 * stream closes terminally — clients must not reconnect-loop on 401/403.
 */
export function createViewerPolicyStream(
  options: ViewerPolicyStreamOptions,
): ReadableStream<Uint8Array> {
  const { viewerId, initialEpoch, readEpoch, resolveViewer, heartbeatMs = 20_000 } = options;
  const encoder = new TextEncoder();

  let lastEpoch = initialEpoch;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  const emit = (event: string, data: string) => {
    if (closed) return;
    try {
      controllerRef?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
    } catch {
      // controller already closed — nothing to deliver
    }
  };

  const closeStream = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    try {
      controllerRef?.close();
    } catch {
      // already closed
    }
  };

  const sync = async (): Promise<void> => {
    if (closed) return;
    try {
      const viewer = await resolveViewer();
      if (!viewer) {
        // Terminal authz close — the session/account no longer resolves.
        // This channel carries no content, so close without an event; the
        // reconnecting client gets a terminal 401 at the route instead.
        closeStream();
        return;
      }
      const epoch = await readEpoch();
      if (epoch === null) {
        closeStream();
        return;
      }
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        emit("policy-changed", String(epoch));
      }
    } catch {
      // Transient read failure — the next heartbeat retries.
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      emit("policy-version", String(lastEpoch));
      unsubscribe = subscribeAccessChanges(viewerId, () => {
        void sync();
      });
      heartbeat = setInterval(() => {
        void sync();
      }, heartbeatMs);
    },
    cancel() {
      // Consumer released the stream (client disconnect): never leak the
      // heartbeat interval or hub subscription.
      closeStream();
    },
  });
}
