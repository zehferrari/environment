// Stop the gateway's queued follow-ups as well as its embedded run. A queue
// waiting for adoption has no embedded session for abortAndDrain to find.
export async function clearPmSessionQueue({ request, sessionKey }) {
  if (!/^agent:[^:]+:pm:/.test(sessionKey)) throw new Error("Refusing to clear a non-PM session queue");
  if (typeof request !== "function") throw new Error("Gateway session cancellation is unavailable");
  const result = await request("sessions.abort", {
    key: sessionKey,
    clearQueued: true,
  });
  if (result?.ok !== true) throw new Error("Gateway did not acknowledge session queue cancellation");
  return result;
}
