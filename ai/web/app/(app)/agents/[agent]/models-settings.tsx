"use client";

import { useMemo, useState } from "react";
import type { AgentModelSettings } from "@/lib/agents/model-settings";

export default function ModelsSettings({ agent, canEdit, settings, liveModel }: { agent: string; canEdit: boolean; settings: AgentModelSettings; liveModel?: string | null }) {
  const [active, setActive] = useState(settings.active ?? liveModel ?? "");
  const [defaultModel, setDefaultModel] = useState(settings.defaultModel ?? "");
  const [fallbacks, setFallbacks] = useState<string[]>(settings.fallbacks);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const labels = useMemo(() => new Map(settings.available.map((model) => [model.id, model.label])), [settings.available]);

  async function save(next?: { active?: string; defaultModel?: string; fallbacks?: string[] }) {
    setMessage(null);
    if (!canEdit || !settings.readable) return;
    const payload = {
      active,
      defaultModel,
      fallbacks,
      ...next,
    };
    setBusy(true);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null) as { error?: string; after?: { active?: string | null; defaultModel?: string | null; fallbacks?: string[] } } | null;
      if (!res.ok) throw new Error(body?.error ?? await res.text());
      if (body?.after) {
        setActive(body.after.active ?? "");
        setDefaultModel(body.after.defaultModel ?? "");
        setFallbacks(body.after.fallbacks ?? []);
      }
      setMessage("Model settings saved and agent restart requested.");
    } catch (err) {
      setMessage(`Model settings update failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  function updateFallback(index: number, model: string) {
    setFallbacks((current) => current.map((entry, i) => i === index ? model : entry));
  }

  function removeFallback(index: number) {
    setFallbacks((current) => current.filter((_, i) => i !== index));
  }

  function moveFallback(index: number, direction: -1 | 1) {
    setFallbacks((current) => {
      const next = [...current];
      const target = index + direction;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addFallback() {
    const candidate = settings.available.find((model) => !fallbacks.includes(model.id) && model.id !== active)?.id ?? settings.available[0]?.id;
    if (!candidate) return;
    setFallbacks((current) => [...current, candidate]);
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
    <div className="space-y-4 text-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <Metric label="Current live" value={liveModel ?? "—"} />
        <Metric label="Config source" value={settings.writablePath} />
      </div>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Active model</span>
        <select disabled={!canEdit || busy || settings.available.length === 0} value={active} onChange={(event) => setActive(event.target.value)} className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50">
          {!active ? <option value="">Select model…</option> : null}
          {settings.available.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Default model</span>
        <select disabled={!canEdit || busy || settings.available.length === 0} value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50">
          {!defaultModel ? <option value="">Select model…</option> : null}
          {settings.available.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select>
      </label>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Fallback models</div>
            <p className="text-xs text-[var(--color-text-muted)]">Ordered list used when the preferred model fails.</p>
          </div>
          <button type="button" disabled={!canEdit || busy || settings.available.length === 0} onClick={addFallback} className="rounded-lg border border-[var(--color-line)] px-3 py-1 text-xs hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50">Add fallback</button>
        </div>
        {fallbacks.length === 0 ? <p className="rounded-xl border border-dashed border-[var(--color-line)] p-3 text-[var(--color-text-muted)]">No fallbacks configured.</p> : (
          <div className="space-y-2">
            {fallbacks.map((model, index) => (
              <div key={`${model}-${index}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-2">
                <span className="w-6 text-center text-xs text-[var(--color-text-muted)]">{index + 1}</span>
                <select disabled={!canEdit || busy} value={model} onChange={(event) => updateFallback(index, event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50">
                  {settings.available.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
                <button type="button" disabled={!canEdit || busy || index === 0} onClick={() => moveFallback(index, -1)} className="rounded border border-[var(--color-line)] px-2 py-1 disabled:opacity-40">↑</button>
                <button type="button" disabled={!canEdit || busy || index === fallbacks.length - 1} onClick={() => moveFallback(index, 1)} className="rounded border border-[var(--color-line)] px-2 py-1 disabled:opacity-40">↓</button>
                <button type="button" disabled={!canEdit || busy} onClick={() => removeFallback(index)} className="rounded border border-[var(--color-danger)]/50 px-2 py-1 text-[var(--color-danger)] disabled:opacity-40">Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <button type="button" disabled={!canEdit || busy || !active || !defaultModel} onClick={() => save()} className="rounded-lg bg-[var(--color-accent)] px-4 py-2 font-medium text-black disabled:cursor-not-allowed disabled:opacity-50">
        {busy ? "Saving…" : "Save model settings"}
      </button>
      <p className="text-xs text-[var(--color-text-muted)]">Current draft: active <code>{active || "—"}</code>, default <code>{defaultModel || "—"}</code>, fallbacks <code>{fallbacks.map((model) => labels.get(model) ?? model).join(" → ") || "—"}</code>.</p>
      {message ? <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-2 text-xs text-[var(--color-text-muted)]">{message}</p> : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3"><div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div><div className="mt-1 break-words font-medium">{value}</div></div>;
}
