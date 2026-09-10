"use client";

import { useState } from "react";
import type { AgentModelSettings } from "@/lib/agents/management/model-settings";
import type { ModelState } from "@/lib/agents/management/model-rotation";

type Preview = { before: ModelState; after: ModelState; revision: string; removed: string | null; changed: boolean };
type Choice = { id: string; label: string; configured?: boolean };

export default function ModelPromotion({ agent, settings }: { agent: string; settings: AgentModelSettings }) {
  const provider = settings.defaultModel?.split("/")[0] ?? "";
  const [model, setModel] = useState("");
  const [choices, setChoices] = useState<Choice[]>(settings.available.filter((m) => m.id.startsWith(`${provider}/`)));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/agents/${encodeURIComponent(agent)}/models`;

  async function checkModels() {
    setBusy(true); setPreview(null);
    try {
      const res = await fetch(`${endpoint}?discover=1&provider=${encodeURIComponent(provider)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Model check failed");
      setChoices(body.models); setNote(body.note);
    } catch (err) { setNote(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }

  async function submit(operation: "preview" | "promote") {
    setBusy(true);
    try {
      const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, provider, model, revision: preview?.revision }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Model update failed");
      if (operation === "preview") setPreview(body);
      else {
        const failed = body.restart?.some((r: { ok: boolean }) => !r.ok);
        if (failed) { setNote("Configuration saved, but a service restart failed. Check the agent service status before retrying work."); setPreview(null); }
        else window.location.reload();
      }
    } catch (err) { setNote(err instanceof Error ? err.message : String(err)); setPreview(null); }
    finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded-card border border-line bg-panel-soft p-3">
    <h3 className="font-medium">Upgrade {provider} model</h3>
    <p className="text-caption text-text-muted">Set the active and default model together. Move the previous default to the first fallback and remove this provider’s last fallback. Other providers keep their order.</p>
    <button type="button" disabled={busy} onClick={checkModels} className="rounded border border-line px-3 py-2 disabled:opacity-50">Check available models</button>
    <label className="block">New model
      <input list={`upgrade-models-${agent}`} value={model} disabled={busy} onChange={(e) => { setModel(e.target.value); setPreview(null); }} placeholder="Select or enter an exact model ID" className="mt-1 block w-full rounded border border-line bg-bg px-3 py-2" />
    </label>
    <datalist id={`upgrade-models-${agent}`}>{choices.map((m) => <option key={m.id} value={m.id}>{m.label}{m.configured === false ? " · not configured" : ""}</option>)}</datalist>
    <button type="button" disabled={busy || !model} onClick={() => submit("preview")} className="rounded border border-line px-3 py-2 disabled:opacity-50">Preview update</button>
    {preview ? <div className="space-y-2 text-caption">
      <p>Active: {preview.before.active} → {preview.after.active}</p>
      <p>Default: {preview.before.defaultModel} → {preview.after.defaultModel}</p>
      <p>Current fallbacks: {preview.before.fallbacks.join(" → ") || "None"}</p>
      <p>New fallbacks: {preview.after.fallbacks.join(" → ") || "None"}</p>
      <p>Last provider fallback removed: {preview.removed ?? "None"}</p>
      <p>This requests an agent restart. Updates are blocked while PM has an active or queued run. An entered model ID does not verify account access.</p>
      {preview.changed ? <button type="button" disabled={busy} onClick={() => submit("promote")} className="rounded bg-accent px-3 py-2 font-medium text-black disabled:opacity-50">Confirm update and restart</button> : <p>Already configured; no change needed.</p>}
    </div> : null}
    {note ? <p role="status" className="text-caption text-text-muted">{note}</p> : null}
  </section>;
}
