"use client";

import { useEffect, useState } from "react";
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

// systemd is_active → traffic-light dot: green running, amber transitioning,
// red stopped/failed, gray unknown. The textual status lives in the hover
// tooltip on the service name, not in the row.
function statusDotClass(status?: string | null) {
  if (status === "active") return "bg-ok shadow-[0_0_8px_rgba(34,197,94,0.6)]";
  if (status === "activating" || status === "deactivating" || status === "reloading")
    return "bg-warn shadow-[0_0_8px_rgba(245,158,11,0.6)]";
  if (!status) return "bg-text-dim";
  return "bg-crit shadow-[0_0_8px_rgba(239,68,68,0.6)]";
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

  // The page auto-refreshes its server payload (AutoRefresh); adopt the fresh
  // service statuses instead of keeping the mount-time snapshot forever.
  useEffect(() => {
    setRows(services);
  }, [services]);
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
      <div className="grid grid-cols-1 gap-1.5">
        {rows.map((service) => {
          const active = service.status === "active";
          const toggling = busy === `toggle:${service.name}`;
          const restarting = busy === `restart:${service.name}`;
          return (
            <div
              key={service.name}
              className="flex min-w-0 items-center gap-1.5 rounded-card border border-line bg-bg py-1 pl-2.5 pr-1 transition-colors hover:border-line-strong"
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full transition-all duration-300 ${statusDotClass(service.status)}`}
                aria-hidden="true"
              />
              <span
                className="min-w-0 flex-1 cursor-default truncate text-caption font-semibold text-text"
                title={`${service.name} — ${service.status ?? "unknown"}`}
              >
                {labelFor(service.name)}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={toggling}
                  onClick={() => setPending({ kind: "toggle", service, enabled: !active })}
                  className={`grid h-6 w-6 cursor-pointer place-items-center rounded-full border transition-all focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? "border-line bg-panel text-text-muted hover:border-crit/50 hover:bg-crit/10 hover:text-crit"
                      : "border-ok/40 bg-ok/10 text-ok hover:border-ok hover:bg-ok hover:text-white"
                  }`}
                  title={active ? `Stop ${labelFor(service.name)}` : `Start ${labelFor(service.name)}`}
                  aria-label={active ? `Stop ${labelFor(service.name)}` : `Start ${labelFor(service.name)}`}
                >
                  {toggling ? (
                    <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M21 12a9 9 0 1 1-6.2-8.56"/></svg>
                  ) : active ? (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect width="16" height="16" x="4" y="4" rx="2"/></svg>
                  ) : (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="7 4 20 12 7 20 7 4"/></svg>
                  )}
                </button>
                <button
                  type="button"
                  disabled={restarting}
                  onClick={() => setPending({ kind: "restart", service })}
                  className="grid h-6 w-6 cursor-pointer place-items-center rounded-full border border-line bg-panel text-text-muted transition-all hover:border-accent hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  title={`Restart ${labelFor(service.name)}`}
                  aria-label={`Restart ${labelFor(service.name)}`}
                >
                  <svg className={restarting ? "animate-spin" : ""} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
                </button>
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
