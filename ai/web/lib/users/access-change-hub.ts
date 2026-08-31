import { EventEmitter } from "node:events";

export type AccessChangeEvent = {
  /** The user whose access policy changed (role, memberships, status). */
  userId: string;
  /**
   * Single affected project when the change touches exactly one; null for
   * role/status-wide changes or multi-project edits. Consumers must re-check
   * everything on any event for their userId — this is a hint, not a filter.
   */
  projectId: string | null;
  at: number;
  /** New policyVersion of the affected user (the post-commit epoch). */
  policyVersion: number;
};

// In-process pub/sub for viewer access-policy changes, keyed by userId.
//
// SINGLE-NODE / IN-PROCESS ASSUMPTION — same contract as
// lib/pm/board-events.ts: the emitter is pinned to globalThis so every
// independently-bundled route handler shares one instance (a plain
// module-level EventEmitter would give each route bundle its own copy and a
// publish from one bundle would never reach another), but events never cross
// process boundaries. Today's standalone single-process deployment makes that
// acceptable; if the app is ever load-balanced, this hub (and board-events.ts)
// must move to a cross-process broadcast (e.g. Redis pub/sub). Consumers must
// treat the hub as an accelerator, not the source of truth: the durable
// User.policyVersion column plus periodic heartbeat re-reads remain the
// correctness bound for missed events.
const globalForAccessChange = globalThis as unknown as {
  __accessChangeEmitter?: EventEmitter;
};

function getEmitter(): EventEmitter {
  if (!globalForAccessChange.__accessChangeEmitter) {
    const created = new EventEmitter();
    created.setMaxListeners(0);
    globalForAccessChange.__accessChangeEmitter = created;
  }
  return globalForAccessChange.__accessChangeEmitter;
}

function channel(userId: string) {
  return `access-change:${userId}`;
}

export function publishAccessChange(event: AccessChangeEvent): void {
  getEmitter().emit(channel(event.userId), event);
}

export function subscribeAccessChanges(
  userId: string,
  listener: (event: AccessChangeEvent) => void,
): () => void {
  const emitter = getEmitter();
  const key = channel(userId);
  emitter.on(key, listener);
  return () => emitter.off(key, listener);
}
