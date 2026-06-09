// Shared, timing-safe bearer check for the PM-channel reply callback
// (POST /api/openclaw/pm-channel/reply). Kept out of the route module so it is
// importable by tests without dragging in Next request-context side effects.

import { timingSafeEqual } from "node:crypto";

export function pmChannelCallbackTokenMatches(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A presented bearer is authorized when it matches either the shared callback
 * token or the per-agent token for the reply's target agent. Both comparisons
 * are timing-safe and an empty/missing presented token is always rejected.
 */
export function authorizePmChannelCallback(args: {
  presented: string;
  expectedShared: string;
  expectedAgent: string | null;
}): boolean {
  return (
    pmChannelCallbackTokenMatches(args.presented, args.expectedShared) ||
    pmChannelCallbackTokenMatches(args.presented, args.expectedAgent ?? "")
  );
}
