"use client";

import { useState } from "react";
import type { AgentModelSettings } from "@/lib/agents/model-settings";

export default function ModelsSettings({ agent, canEdit, settings, liveModel }: { agent: string; canEdit: boolean; settings: AgentModelSettings; liveModel?: string | null }) {
  const [active, setActive] = useState(settings.active ?? liveModel ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(model: string) {
    setActive(model);
    setMessage(null);
    if (!canEdit || !settings.readable) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage(`Active model set to ${model}. Restart or next session may be required for running processes to pick it up.`);
    } catch (err) {
      setMessage(`Model update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!settings.readable) {
    return (
      <div className="space-y-3 text-sm">
        <Metric label="Current active" value={liveModel ?? "—"} />
        <p className="rounded-xl border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 p-3 text-[var(--color-warn)]">
          Model config is not readable at <code>{settings.writablePath}</code>. Move or expose this config under a PM-writable shared location if you want the editor to update it for this agent.
        </p>
        {settings.error ? <p className="font-mono text-xs text-[var(--color-text-muted)]">{settings.error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <Metric label="Current active" value={(liveModel ?? active) || "—"} />
      <Metric label="Default" value={settings.defaultModel ?? "—"} />
      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Set active model</span>
        <select disabled={!canEdit || busy || settings.available.length === 0} value={active} onChange={(event) => save(event.target.value)} className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50">
          {!active ? <option value="">Select model…</option> : null}
          {settings.available.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Fallbacks</div>
        {settings.fallbacks.length === 0 ? <p className="text-[var(--color-text-muted)]">No fallbacks configured.</p> : (
          <ol className="list-decimal space-y-1 pl-5 font-mono text-xs">
            {settings.fallbacks.map((model) => <li key={model}>{model}</li>)}
          </ol>
        )}
      </div>
      <p className="text-xs text-[var(--color-text-muted)]">Config source: <code>{settings.writablePath}</code></p>
      {message ? <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-2 text-xs text-[var(--color-text-muted)]">{message}</p> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3"><div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div><div className="mt-1 break-words font-medium">{value}</div></div>;
}
