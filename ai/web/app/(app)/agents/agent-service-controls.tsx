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
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 transition-all hover:bg-[var(--color-panel-soft)]"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-[var(--color-text)]">{labelFor(service.name)}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                  <span
                    className={`h-2 w-2 rounded-full transition-all duration-300 ${
                      active
                        ? "bg-[var(--color-ok)] shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                        : "bg-[var(--color-crit)] shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                    }`}
                  />
                  {service.status ?? "unknown"}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={toggling}
                  onClick={() => toggle(service, !active)}
                  className={`rounded-md p-1.5 border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? "border-[var(--color-line)] bg-[var(--color-panel)] text-[var(--color-text-muted)] hover:border-[var(--color-crit)]/30 hover:bg-[var(--color-crit)]/[0.04] hover:text-[var(--color-crit)]"
                      : "border-transparent bg-[var(--color-accent)] text-white hover:opacity-90"
                  }`}
                  title={active ? `Stop ${labelFor(service.name)}` : `Start ${labelFor(service.name)}`}
                >
                  {active ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                  )}
                </button>
                <button
                  type="button"
                  disabled={restarting}
                  onClick={() => restart(service)}
                  className="rounded-md border border-[var(--color-line)] p-1.5 text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  title={`Restart ${labelFor(service.name)}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                </button>
              </div>
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
