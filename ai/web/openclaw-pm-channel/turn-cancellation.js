const defaultWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Abort one PM turn using the raw PM correlation key and the canonical
 * OpenClaw session key captured by runPmTurn.
 *
 * Dependencies are explicit so this safety boundary can be regression-tested
 * without loading a gateway runtime.
 */
export async function abortTrackedPmTurn({
  activeTurns,
  sessionKey,
  harness,
  wait = defaultWait,
  maxAttempts = 100,
}) {
  const active = activeTurns.get(sessionKey);
  if (!active) return { aborted: false, reason: "not_active" };
  if (
    typeof harness?.resolveActiveEmbeddedRunSessionId !== "function"
    || typeof harness?.abortAgentHarnessRun !== "function"
  ) return { aborted: false, reason: "abort_unavailable" };

  // Mark BEFORE resolving the embedded run. runPmTurn checks this flag just
  // before dispatch, covering cancellation during inbound context assembly.
  active.abortedAt = Date.now();
  const lookupKey = active.canonicalSessionKey || sessionKey;

  // The cancel request can race the embedded runner's registration by a few
  // event-loop turns. Wait briefly for the canonical key to resolve; do not
  // claim success merely because abortAgentHarnessRun(undefined) returned.
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = activeTurns.get(sessionKey);
    if (!current || current.acceptedId !== active.acceptedId) {
      return { aborted: true, reason: "turn_replaced_before_dispatch" };
    }
    const embeddedSessionId = await harness.resolveActiveEmbeddedRunSessionId(
      current.canonicalSessionKey || lookupKey,
    );
    if (embeddedSessionId) {
      const aborted = await harness.abortAgentHarnessRun(embeddedSessionId);
      return aborted
        ? { aborted: true }
        : { aborted: false, reason: "active_run_not_abortable" };
    }
    await wait(50);
  }

  // No embedded run appeared during the grace window. The pre-dispatch
  // cancellation flag remains authoritative, but report the distinct state
  // instead of pretending an OpenClaw process was aborted.
  return { aborted: true, reason: "canceled_before_dispatch" };
}
