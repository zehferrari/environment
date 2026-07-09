"use client";

import { useState } from "react";

// Stacked activity histogram for the System Activity page. Server bucketises
// the ActivityLog rows (local-time buckets, pre-formatted labels) and this
// component only draws: HTML/CSS columns (no chart lib), a hover/focus
// tooltip per bucket, and a <details> data table so every value is readable
// without color or pointer (the light-mode aqua/yellow slots sit below 3:1
// contrast, so the table is the required relief channel, not a nicety).

export type ActivitySeriesKey = "work" | "chat" | "agents";

export type ActivityChartBucket = {
  key: string;
  label: string; // x-axis tick text, e.g. "14:00" or "8 Jul"
  detail: string; // tooltip heading, e.g. "Tue 8 Jul · 14:00–15:00"
  showTick: boolean;
  counts: Record<ActivitySeriesKey, number>;
};

const SERIES: Array<{ key: ActivitySeriesKey; label: string; cssVar: string }> = [
  { key: "work", label: "Work items", cssVar: "var(--viz-work)" },
  { key: "chat", label: "Chat", cssVar: "var(--viz-chat)" },
  { key: "agents", label: "Agent ops", cssVar: "var(--viz-agents)" },
];

const PLOT_HEIGHT = 168; // px
const SEGMENT_GAP = 2; // surface gap between stacked segments

function bucketTotal(bucket: ActivityChartBucket): number {
  return SERIES.reduce((sum, s) => sum + (bucket.counts[s.key] ?? 0), 0);
}

// Smallest "nice" axis scale (1/2/5 × 10^k steps, ≤ 4 divisions) covering max.
function niceScale(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 4, ticks: [0, 2, 4] };
  const bases = [1, 2, 5];
  for (let power = 0; power <= 6; power += 1) {
    for (const base of bases) {
      const step = base * 10 ** power;
      const divisions = Math.ceil(max / step);
      if (divisions <= 4) {
        const top = step * divisions;
        const ticks = [];
        for (let v = 0; v <= divisions; v += 1) ticks.push(v * step);
        return { top, ticks };
      }
    }
  }
  return { top: max, ticks: [0, max] };
}

export default function SystemActivityChart({ buckets }: { buckets: ActivityChartBucket[] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const totals = buckets.map(bucketTotal);
  const grandTotal = totals.reduce((a, b) => a + b, 0);
  const maxTotal = Math.max(0, ...totals);
  const maxIndex = totals.indexOf(maxTotal);
  const { top, ticks } = niceScale(maxTotal);

  if (buckets.length === 0 || grandTotal === 0) {
    return (
      <div className="rounded-card border border-dashed border-line bg-panel-soft px-4 py-8 text-center text-body text-text-muted">
        No activity recorded in this window.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1" aria-hidden="true">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-caption text-text-muted">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.cssVar }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        {/* y-axis tick labels */}
        <div className="relative w-8 shrink-0 select-none" style={{ height: PLOT_HEIGHT }}>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-nano tabular-nums text-text-dim"
              style={{ bottom: `${(t / top) * PLOT_HEIGHT}px`, transform: "translateY(50%)" }}
            >
              {t}
            </span>
          ))}
        </div>

        {/* plot */}
        <div className="min-w-0 flex-1">
          <div className="relative border-b border-line" style={{ height: PLOT_HEIGHT }}>
            {/* hairline gridlines (skip baseline) */}
            {ticks.filter((t) => t > 0).map((t) => (
              <div
                key={t}
                className="pointer-events-none absolute inset-x-0 h-px bg-line/70"
                style={{ bottom: `${(t / top) * PLOT_HEIGHT}px` }}
                aria-hidden="true"
              />
            ))}

            <div className="absolute inset-0 flex items-end">
              {buckets.map((bucket, i) => {
                const total = totals[i];
                const isHovered = hovered === i;
                const nonZero = SERIES.filter((s) => (bucket.counts[s.key] ?? 0) > 0);
                const stackPx = SERIES.reduce(
                  (sum, s) => sum + ((bucket.counts[s.key] ?? 0) / top) * PLOT_HEIGHT,
                  0,
                );
                const labelBottom = stackPx + Math.max(0, nonZero.length - 1) * SEGMENT_GAP + 3;
                const anchor = i < 3 ? "left" : i > buckets.length - 4 ? "right" : "center";
                const readout = `${bucket.detail}: ${
                  total === 0
                    ? "no events"
                    : SERIES.filter((s) => (bucket.counts[s.key] ?? 0) > 0)
                        .map((s) => `${bucket.counts[s.key]} ${s.label.toLowerCase()}`)
                        .join(", ")
                }`;

                return (
                  <div
                    key={bucket.key}
                    role="group"
                    aria-label={readout}
                    tabIndex={0}
                    className={`relative flex h-full min-w-0 flex-1 items-end justify-center outline-none ${
                      isHovered ? "bg-accent-soft/60" : ""
                    } rounded-t-md transition-colors`}
                    onPointerEnter={() => setHovered(i)}
                    onPointerLeave={() => setHovered((v) => (v === i ? null : v))}
                    onFocus={() => setHovered(i)}
                    onBlur={() => setHovered((v) => (v === i ? null : v))}
                  >
                    {/* selective direct label: busiest bucket only */}
                    {i === maxIndex && total > 0 ? (
                      <span
                        className="pointer-events-none absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-nano font-medium text-text-muted"
                        style={{ bottom: labelBottom }}
                        aria-hidden="true"
                      >
                        {total}
                      </span>
                    ) : null}

                    <div
                      className="flex h-full flex-col-reverse items-stretch justify-start"
                      style={{ width: "min(62%, 22px)", filter: isHovered ? "brightness(1.08)" : undefined }}
                    >
                      {SERIES.map((s) => {
                        const count = bucket.counts[s.key] ?? 0;
                        if (count === 0) return null;
                        const h = Math.max(2, (count / top) * PLOT_HEIGHT);
                        const isTop = nonZero[nonZero.length - 1]?.key === s.key;
                        const isBase = nonZero[0]?.key === s.key;
                        return (
                          <div
                            key={s.key}
                            className="w-full"
                            style={{
                              height: h,
                              background: s.cssVar,
                              // 2px surface gap below every non-baseline segment
                              // (col-reverse: marginBottom = the visual gap to
                              // the segment underneath).
                              marginBottom: isBase ? 0 : SEGMENT_GAP,
                              borderRadius: isTop ? "4px 4px 0 0" : 0,
                            }}
                          />
                        );
                      })}
                    </div>

                    {/* tooltip */}
                    {isHovered ? (
                      <div
                        className={`pointer-events-none absolute z-20 w-max max-w-56 rounded-card border border-line bg-panel px-3 py-2 shadow-md ${
                          anchor === "left"
                            ? "left-0"
                            : anchor === "right"
                              ? "right-0"
                              : "left-1/2 -translate-x-1/2"
                        }`}
                        style={{ bottom: PLOT_HEIGHT + 6 }}
                        role="status"
                      >
                        <p className="text-nano font-semibold uppercase tracking-wider text-text-muted">
                          {bucket.detail}
                        </p>
                        <div className="mt-1.5 space-y-1">
                          {SERIES.map((s) => (
                            <p key={s.key} className="flex items-center gap-2 text-caption">
                              <span className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: s.cssVar }} />
                              <strong className="tabular-nums text-text">{bucket.counts[s.key] ?? 0}</strong>
                              <span className="text-text-muted">{s.label}</span>
                            </p>
                          ))}
                          <p className="border-t border-line pt-1 text-caption text-text-muted">
                            <strong className="tabular-nums text-text">{total}</strong> total
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* x-axis tick labels */}
          <div className="mt-1 flex select-none">
            {buckets.map((bucket) => (
              <span key={bucket.key} className="min-w-0 flex-1 text-center text-nano text-text-dim">
                {bucket.showTick ? bucket.label : ""}
              </span>
            ))}
          </div>
        </div>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-micro text-text-muted hover:text-accent">Data table</summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-card border border-line">
          <table className="w-full text-caption">
            <thead>
              <tr className="border-b border-line bg-panel-soft text-left text-nano uppercase tracking-wider text-text-muted">
                <th className="px-2 py-1.5 font-medium">Bucket</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="px-2 py-1.5 text-right font-medium">
                    {s.label}
                  </th>
                ))}
                <th className="px-2 py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket, i) => (
                <tr key={bucket.key} className="border-b border-line/60 last:border-0">
                  <td className="px-2 py-1 text-text-muted">{bucket.detail}</td>
                  {SERIES.map((s) => (
                    <td key={s.key} className="px-2 py-1 text-right tabular-nums">
                      {bucket.counts[s.key] ?? 0}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-medium tabular-nums">{totals[i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
