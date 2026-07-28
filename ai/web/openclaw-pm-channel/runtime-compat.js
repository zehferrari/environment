function bindRuntimeSurface(surface, dispatchMethod, api) {
  return {
    api,
    buildContext: surface.buildContext.bind(surface),
    dispatchReply: surface[dispatchMethod].bind(surface),
  };
}

/**
 * Normalize OpenClaw's channel inbound runtime across the supported rollback
 * window. OpenClaw 2026.7 moved the public helpers from `channel.turn` to
 * `channel.inbound`; 2026.5.22 exposes only the legacy names.
 */
export function resolvePmInboundRuntime(runtime) {
  const inbound = runtime?.channel?.inbound;
  if (
    typeof inbound?.buildContext === "function"
    && typeof inbound?.dispatchReply === "function"
  ) {
    return bindRuntimeSurface(inbound, "dispatchReply", "channel.inbound");
  }

  const legacyTurn = runtime?.channel?.turn;
  if (
    typeof legacyTurn?.buildContext === "function"
    && typeof legacyTurn?.runAssembled === "function"
  ) {
    return bindRuntimeSurface(legacyTurn, "runAssembled", "channel.turn");
  }

  throw new Error(
    "PM channel requires OpenClaw channel.inbound (2026.7+) "
      + "or legacy channel.turn (2026.5.x) runtime helpers",
  );
}
