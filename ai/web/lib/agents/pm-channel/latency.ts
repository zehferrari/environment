export type PmChannelLatencySource = {
  createdAt: Date;
  acceptedAt: Date | null;
  streamingAt: Date | null;
  completedAt: Date | null;
  failedAt?: Date | null;
  driver?: string | null;
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

// Nearest-rank percentile over a (non-empty) sorted ascending array.
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, p));
  const rank = Math.ceil(clamped * sortedAsc.length);
  const index = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[index];
}

export type PmLatencySummary = {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

export function pmChannelLatencyTransport(run: PmChannelLatencySource): string {
  const driver = run.driver ?? "";
  const suffix = driver.startsWith("openclaw-pm-channel:")
    ? driver.slice("openclaw-pm-channel:".length)
    : "";
  return suffix || "http";
}

// Aggregate send→final latency (p50/p95/max) over recent completed runs. Runs
// without a usable send→final span (still in-flight, failed before completion)
// are skipped so the percentiles reflect real end-to-end delivery.
export function summarizePmLatency(runs: PmChannelLatencySource[]): PmLatencySummary {
  const values = runs
    .map((run) => pmChannelLatencySpans(run).sendToFinalMs)
    .filter((ms): ms is number => ms != null)
    .sort((a, b) => a - b);

  return {
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? values[values.length - 1] : null,
  };
}

export function summarizePmLatencyByTransport(runs: PmChannelLatencySource[]): Record<string, PmLatencySummary> {
  const groups = new Map<string, PmChannelLatencySource[]>();
  for (const run of runs) {
    const transport = pmChannelLatencyTransport(run);
    groups.set(transport, [...(groups.get(transport) ?? []), run]);
  }
  return Object.fromEntries([...groups].map(([transport, grouped]) => [
    transport,
    summarizePmLatency(grouped),
  ]));
}
