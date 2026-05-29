// PM consumer / dispatcher (HOMELAB-46 Slice 4).
//
// Long-running OpenClaw-side service that consumes PmEvents from the
// dispatch boundary (lib/pm-dispatch) and wakes the target agent's
// OpenClaw gateway via POST /hooks/wake. Idempotent (UNIQUE dedupe_key)
// and audited (ActivityLog "agent.wake.*") per HOMELAB-46 / HOMELAB-51
// acceptance.

export { dedupeKeyFor } from "./dedupe-key";
export { createTargetResolver, type ResolvedTarget, type TargetResolver } from "./target";
export {
  resolveHookToken,
  wakeAgent,
  __resetGatewayTokenCacheForTests,
  type WakeArgs,
  type WakeResult,
} from "./gateway-client";
export { appendDelivery, markDelivered } from "./delivery-log";
export { writeAuditRow } from "./audit";
export { createHandler, type ConsumerHandler, type HandleOutcome } from "./handler";
export { startSocketListener } from "./listener-socket";
export { startFileDropListener } from "./listener-filedrop";
export { startHttpListener } from "./listener-http";
export {
  readServiceConfigFromEnv,
  startService,
  type ServiceConfig,
  type ServiceHandle,
} from "./service";
