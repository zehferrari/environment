"use client";

import { useEffect, useState } from "react";

type DeckData = {
  // Present only for owners — the API omits agent presence for everyone else.
  agents?: { slug: string; busy: boolean }[];
  queues: { status: string; count: number }[];
  activity: { id: string; at: string; label: string }[];
};

const QUEUE_ORDER = ["Backlog", "To Do", "In Progress", "Review", "Done"];
const REFRESH_MS = 30_000;

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-panel p-card">
      <h2 className="text-micro font-semibold uppercase tracking-wider text-text-muted">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function CommandDeckPanel() {
  const [data, setData] = useState<DeckData | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/command-deck", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as DeckData;
        if (!cancelled) setData(next);
      } catch {
        // transient — keep the previous snapshot
      }
    }
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const queues = data
    ? [...data.queues].sort(
        (a, b) => QUEUE_ORDER.indexOf(a.status) - QUEUE_ORDER.indexOf(b.status),
      )
    : [];

  return (
    <div className="sticky top-0 flex max-h-dvh flex-col gap-3 overflow-y-auto p-4">
      {data?.agents ? (
        <Widget title="Agents">
          {data.agents.length > 0 ? (
            <ul className="space-y-1.5">
              {data.agents.map((agent) => (
                <li key={agent.slug} className="flex items-center gap-2 text-body">
                  <span
                    aria-hidden
                    className={`h-2 w-2 rounded-full ${agent.busy ? "bg-ok" : "bg-line-strong"}`}
                  />
                  <span className="truncate text-text">{agent.slug}</span>
                  <span className="ml-auto text-caption text-text-muted">
                    {agent.busy ? "working" : "idle"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-caption text-text-muted">No agent snapshot available.</p>
          )}
        </Widget>
      ) : null}

      <Widget title="Queue depth">
        {queues.length > 0 ? (
          <ul className="space-y-1.5">
            {queues.map((queue) => (
              <li key={queue.status} className="flex items-center justify-between text-body">
                <span className="text-text">{queue.status}</span>
                <span className="tabular-nums text-text-muted">{queue.count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-caption text-text-muted">No open tasks.</p>
        )}
      </Widget>

      <Widget title="Recent activity">
        {data && data.activity.length > 0 ? (
          <ul className="space-y-2">
            {data.activity.map((row) => (
              <li key={row.id} className="text-caption">
                <div className="text-text">{row.label}</div>
                <div className="text-text-dim">{timeAgo(row.at)}</div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-caption text-text-muted">No recent activity.</p>
        )}
      </Widget>
    </div>
  );
}
