// PM dispatch notifier (HOMELAB-46 Slice 2).
//
// Call-site facade in front of createDispatcher(). Server actions /
// API routes pass an already-built PmEvent after the workflow rule
// has accepted the mutation and the row has been persisted; this
// module handles transport selection, driver caching, and crucially
// guarantees that dispatch failure is never a workflow failure:
//
//   - Any error during config read, driver construction, or send is
//     caught here and surfaced as DispatchResult.ok=false plus a
//     console.warn observability line. Callers MUST NOT await this in
//     a try/catch expecting it to throw.
//   - If neither PM_DISPATCH_SOCKET nor PM_DISPATCH_DROP_DIR is set
//     in the environment, dispatch is considered unconfigured: we log
//     once at process scope and return ok=false without attempting a
//     send. This is the local-dev / unit-test default and stays out
//     of the workflow path.
//   - Driver instances are cached at module scope so each call site
//     does not re-resolve config.
//
// HOMELAB-44 enforcement stays where it is: the workflow rule layer
// is upstream of this call. Nothing in this module can reject a
// mutation; nothing in this module can roll one back.

import type { PmEvent } from "@/lib/pm-events";
import {
  createDispatcher,
  readDispatcherConfig,
  type DispatchDriver,
  type DispatchResult,
  type DispatcherConfig,
} from "./index";

type NotifierState =
  | { kind: "uninitialized" }
  | { kind: "disabled"; reason: string }
  | { kind: "ready"; driver: DispatchDriver; cfg: DispatcherConfig }
  | { kind: "broken"; error: string };

let state: NotifierState = { kind: "uninitialized" };
let warnedDisabledOnce = false;

function envIsConfigured(env: NodeJS.ProcessEnv): boolean {
  // The env selector defaults to unix-socket; treat "unconfigured" as
  // the case where neither transport's required env var is present.
  // Explicit PM_DISPATCH_DRIVER=file-drop without PM_DISPATCH_DROP_DIR
  // still counts as misconfigured and is surfaced via the broken path
  // below — we only short-circuit when nothing is set at all.
  return Boolean(env.PM_DISPATCH_SOCKET) || Boolean(env.PM_DISPATCH_DROP_DIR);
}

type ReadyState = Exclude<NotifierState, { kind: "uninitialized" }>;

function init(): ReadyState {
  if (state.kind !== "uninitialized") return state as ReadyState;
  const env = process.env;
  if (!envIsConfigured(env)) {
    state = {
      kind: "disabled",
      reason:
        "PM_DISPATCH_SOCKET / PM_DISPATCH_DROP_DIR not set; dispatch is observability-only",
    };
    return state;
  }
  try {
    const cfg = readDispatcherConfig(env);
    const driver = createDispatcher(cfg);
    state = { kind: "ready", driver, cfg };
  } catch (err) {
    state = {
      kind: "broken",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return state as ReadyState;
}

// Exposed for tests so a process can re-evaluate after env changes.
// Production code does not call this; the singleton is intentional.
export function __resetPmDispatchNotifierForTests(): void {
  state = { kind: "uninitialized" };
  warnedDisabledOnce = false;
}

export interface NotifyResult extends DispatchResult {
  // "disabled" lets call-site logs distinguish a deliberately
  // unconfigured environment from a transport failure.
  skipped?: "disabled";
}

export async function notifyDispatch(event: PmEvent): Promise<NotifyResult> {
  const s = init();
  if (s.kind === "disabled") {
    if (!warnedDisabledOnce) {
      warnedDisabledOnce = true;
      console.warn(`[pm-dispatch] ${s.reason}`);
    }
    return {
      ok: false,
      driver: "unix-socket",
      error: s.reason,
      skipped: "disabled",
    };
  }
  if (s.kind === "broken") {
    console.warn(
      `[pm-dispatch] driver init failed for ${event.kind} ${event.id}: ${s.error}`,
    );
    return { ok: false, driver: "unix-socket", error: s.error };
  }
  try {
    const result = await s.driver.send(event);
    if (!result.ok) {
      console.warn(
        `[pm-dispatch] send failed for ${event.kind} ${event.id} via ${result.driver}: ${result.error ?? "unknown"}`,
      );
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pm-dispatch] send threw for ${event.kind} ${event.id} via ${s.driver.name}: ${message}`,
    );
    return { ok: false, driver: s.driver.name, error: message };
  }
}
