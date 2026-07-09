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
  columns = 2,
}: {
  agent: string;
  services: AgentService[];
  columns?: 2 | 3;
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
    return <p className="text-caption text-text-muted">No agent services.</p>;
  }

  return (
    <div className="space-y-2">
      <div className={`grid gap-2 ${columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {rows.map((service) => {
          const active = service.status === "active";
          const toggling = busy === `toggle:${service.name}`;
          const restarting = busy === `restart:${service.name}`;
          return (
            <div
              key={service.name}
              className="min-w-0 rounded-card border border-line bg-bg p-2 transition-colors hover:border-line-strong"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full transition-all duration-300 ${
                    active
                      ? "bg-ok shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                      : "bg-crit shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                  }`}
                />
                <span className="truncate text-caption font-semibold text-text" title={service.name}>
                  {labelFor(service.name)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-1">
                <span className="truncate text-nano font-bold uppercase tracking-wider text-text-muted">
                  {service.status ?? "unknown"}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={toggling}
                    onClick={() => setPending({ kind: "toggle", service, enabled: !active })}
                    className={`grid h-7 w-7 cursor-pointer place-items-center rounded-full border transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${
                      active
                        ? "border-line bg-panel text-text-muted hover:border-crit/50 hover:bg-crit/10 hover:text-crit"
                        : "border-ok/40 bg-ok/10 text-ok hover:border-ok hover:bg-ok hover:text-white"
                    }`}
                    title={active ? `Stop ${labelFor(service.name)}` : `Start ${labelFor(service.name)}`}
                    aria-label={active ? `Stop ${labelFor(service.name)}` : `Start ${labelFor(service.name)}`}
                  >
                    {toggling ? (
                      <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>
                    ) : active ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect width="16" height="16" x="4" y="4" rx="2"/></svg>
                    ) : (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"/></svg>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={restarting}
                    onClick={() => setPending({ kind: "restart", service })}
                    className="grid h-7 w-7 cursor-pointer place-items-center rounded-full border border-line bg-panel text-text-muted transition-all hover:border-accent hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                    title={`Restart ${labelFor(service.name)}`}
                    aria-label={`Restart ${labelFor(service.name)}`}
                  >
                    <svg className={restarting ? "animate-spin" : ""} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {message ? (
        <p className="line-clamp-2 rounded-lg border border-line bg-panel-soft px-2 py-1 text-micro text-text-muted">
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
