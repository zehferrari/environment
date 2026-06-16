"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmPopup from "@/components/confirm-popup";

type PendingPrompt =
  | { kind: "toggle"; service: AgentService; enabled: boolean }
  | { kind: "restart"; service: AgentService };

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
  const router = useRouter();
  const [rows, setRows] = useState(services);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPrompt | null>(null);

  async function runToggle(service: AgentService, enabled: boolean) {
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
      router.refresh();
    } catch (err) {
      setRows(before);
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runRestart(service: AgentService) {
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
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return <p className="text-xs text-text-muted">No agent services.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((service) => {
          const active = service.status === "active";
          const toggling = busy === `toggle:${service.name}`;
          const restarting = busy === `restart:${service.name}`;
          return (
            <div
              key={service.name}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-line bg-bg px-3 py-2 transition-all hover:bg-panel-soft"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold text-text">{labelFor(service.name)}</div>
                <div className="mt-1 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-text-muted">
                  <span
                    className={`h-2 w-2 rounded-full transition-all duration-300 ${
                      active
                        ? "bg-ok shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                        : "bg-crit shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                    }`}
                  />
                  {service.status ?? "unknown"}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  disabled={toggling}
                  onClick={() => setPending({ kind: "toggle", service, enabled: !active })}
                  className={`rounded-md p-1.5 border transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? "border-line bg-panel text-text-muted hover:border-crit/30 hover:bg-crit/4 hover:text-crit"
                      : "border-transparent bg-accent text-white hover:opacity-90"
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
                  onClick={() => setPending({ kind: "restart", service })}
                  className="rounded-md border border-line p-1.5 text-text-muted hover:border-accent hover:text-accent hover:bg-accent-soft transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
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
        <p className="line-clamp-2 rounded-lg border border-line bg-panel-soft px-2 py-1 text-[11px] text-text-muted">
          {message}
        </p>
      ) : null}
      <ConfirmPopup
        open={pending !== null}
        title={
          pending?.kind === "restart"
            ? `Restart ${labelFor(pending.service.name)}?`
            : pending?.kind === "toggle"
              ? `${pending.enabled ? "Start" : "Stop"} ${labelFor(pending.service.name)}?`
              : ""
        }
        description={
          pending?.kind === "restart"
            ? `Restart ${pending.service.name} for ${agent}? This will momentarily interrupt it.`
            : pending?.kind === "toggle"
              ? `${pending.enabled ? "Start" : "Stop"} ${pending.service.name} for ${agent}?`
              : null
        }
        confirmLabel={
          pending?.kind === "restart"
            ? "Restart"
            : pending?.kind === "toggle"
              ? pending.enabled
                ? "Start"
                : "Stop"
              : "Confirm"
        }
        danger={pending?.kind === "toggle" && !pending.enabled}
        busy={busy !== null}
        onConfirm={async () => {
          if (!pending) return;
          const next = pending;
          setPending(null);
          if (next.kind === "toggle") await runToggle(next.service, next.enabled);
          else await runRestart(next.service);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
