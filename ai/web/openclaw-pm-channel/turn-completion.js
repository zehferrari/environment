// Successful PM workflow outcomes stop model execution, not only UI state.
export function isProtocolSilentReply(text) {
  return typeof text === "string" && /^(?:(?:NO_REPLY|PM_SILENT_NO_CONTRIBUTION)[\s.]*)+$/i.test(text.trim());
}

// Channel inbound returns a ChannelTurnResult, not a ReplyPayload. Core owns
// NO_REPLY normalization and may consume the token before delivery callbacks.
// An empty dispatch is deliberately NOT evidence of successful silence.
export function isDeliberateSilentDispatch(result) {
  return result?.dispatched === true && result.dispatchResult?.deliberateSilentTerminalReply === true;
}

export function canDeliverTaskReply(turn, currentTurn) {
  return turn === currentTurn && !turn.abortedAt && !turn.completedAction;
}

export function isGatewayFailureReply(text) {
  return typeof text === "string" && /^(?:⚠️\s*)?(?:No reply was generated for this message\.|LLM request failed\b)/i.test(text.trim());
}

export async function stopCompletedTaskTurn({ turn, sessionKey, findTurn, loadHarness, logger }) {
  const isCurrent = () => findTurn(sessionKey) === turn && !turn.abortedAt && Boolean(turn.completedAction);
  if (!isCurrent()) return false;
  try {
    const harness = await loadHarness();
    if (!isCurrent()) return false;
    const sessionId = await harness.resolveActiveEmbeddedRunSessionId(sessionKey);
    if (!isCurrent() || !sessionId) return false;
    // Never drain/wait here: this callback is inside the tool being stopped.
    const stopped = harness.abortAgentHarnessRun(sessionId, { reason: "PM workflow action completed" });
    if (!stopped) logger.warn?.("[pm-channel] completed task run could not be stopped");
    return stopped;
  } catch {
    logger.warn?.("[pm-channel] completed task stop unavailable; terminal result still fences further PM tools");
    return false;
  }
}
