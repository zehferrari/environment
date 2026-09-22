// Stop the gateway's queued follow-ups as well as its embedded run. A queue
// waiting for adoption has no embedded session for abortAndDrain to find.
export async function clearPmSessionQueue({ runtime, sessionKey }) {
  if (!/^agent:[^:]+:pm:/.test(sessionKey)) throw new Error("Refusing to clear a non-PM session queue");
  if (typeof runtime.gateway?.request !== "function") throw new Error("Gateway session cancellation is unavailable");
  const result = await runtime.gateway.request("sessions.abort", {
    key: sessionKey,
    clearQueued: true,
  }, { timeoutMs: 5000 });
  if (result?.ok !== true) throw new Error("Gateway did not acknowledge session queue cancellation");
  return result;
}
