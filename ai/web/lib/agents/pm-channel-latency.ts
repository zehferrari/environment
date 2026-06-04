export type PmChannelLatencySource = {
  createdAt: Date;
  acceptedAt: Date | null;
  streamingAt: Date | null;
  completedAt: Date | null;
  failedAt?: Date | null;
};

function spanMs(start: Date | null | undefined, end: Date | null | undefined) {
  if (!start || !end) return null;
  const ms = end.getTime() - start.getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function pmChannelLatencySpans(run: PmChannelLatencySource) {
  const firstTokenAt = run.streamingAt ?? run.completedAt ?? null;
  const finalAt = run.completedAt ?? run.failedAt ?? null;
  return {
    sendToAcceptedMs: spanMs(run.createdAt, run.acceptedAt),
    acceptedToFirstTokenMs: spanMs(run.acceptedAt ?? run.createdAt, firstTokenAt),
    firstTokenToFinalMs: run.streamingAt ? spanMs(run.streamingAt, finalAt) : null,
    sendToFinalMs: spanMs(run.createdAt, finalAt),
  };
}

export function formatLatency(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}
