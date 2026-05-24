"use client";

import { useState } from "react";

export type AgentService = {
  name: string;
  status?: string | null;
};

const SERVICE_LABELS: Record<string, string> = {
  "openclaw-gateway.service": "gateway",
  "openclaw-gmail-listener.service": "gmail",
  "openclaw-jira-receiver.service": "jira",
  "openclaw-bitbucket-receiver.service": "bitbucket",
};

function labelFor(service: string) {
  return SERVICE_LABELS[service] ?? service.replace(/^openclaw-/, "").replace(/\.service$/, "");
}

export default function AgentServiceControls({
  agent,
  services,
}: {
  agent: string;
  services: AgentService[];
}) {
  const [rows, setRows] = useState(services);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function toggle(service: AgentService, enabled: boolean) {
    if (!window.confirm(`${enabled ? "Start" : "Stop"} ${service.name} for ${agent}?`)) return;
    setBusy(`toggle:${service.name}`);
    setMessage(null);
    const before = rows;
    setRows((current) =>
      current.map((row) =>
        row.name === service.name ? { ...row, status: enabled ? "active" : "inactive" } : row,
      ),
    );
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/services/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: service.name, enabled }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage(`${labelFor(service.name)} ${enabled ? "started" : "stopped"}`);
    } catch (err) {
      setRows(before);
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function restart(service: AgentService) {
    if (!window.confirm(`Restart ${service.name} for ${agent}?`)) return;
    setBusy(`restart:${service.name}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/services/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: service.name }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage(`${labelFor(service.name)} restart requested`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return <p className="text-xs text-[var(--color-text-muted)]">No agent services.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2">
        {rows.map((service) => {
          const active = service.status === "active";
          const toggling = busy === `toggle:${service.name}`;
          const restarting = busy === `restart:${service.name}`;
          return (
            <div
              key={service.name}
              className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{labelFor(service.name)}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                  <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-[var(--color-ok)]" : "bg-[var(--color-crit)]"}`} />
                  {service.status ?? "unknown"}
                </div>
              </div>
              <button
                type="button"
                disabled={toggling}
                onClick={() => toggle(service, !active)}
                className={`rounded-md px-2 py-1 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                  active
                    ? "border border-[var(--color-line)] text-[var(--color-text-muted)]"
                    : "bg-[var(--color-accent)] text-white"
                }`}
              >
                {active ? "Stop" : "Start"}
              </button>
              <button
                type="button"
                disabled={restarting}
                onClick={() => restart(service)}
                className="rounded-md border border-[var(--color-line)] px-2 py-1 text-[11px] font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                title={`Restart ${service.name}`}
              >
                Restart
              </button>
            </div>
          );
        })}
      </div>
      {message ? (
        <p className="line-clamp-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2 py-1 text-[11px] text-[var(--color-text-muted)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
