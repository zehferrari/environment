"use client";

import { useState } from "react";

type ServiceRow = { name: string; status?: string };

type Props = {
  agent: string;
  canEdit: boolean;
  integrations: Record<string, boolean>;
  capabilities: Record<string, boolean>;
  services: ServiceRow[];
};

const CREDENTIAL_FIELDS: Record<string, Array<{ name: string; label: string; type?: string }>> = {
  jira: [{ name: "email", label: "Atlassian email" }, { name: "api_token", label: "API token", type: "password" }],
  bitbucket: [{ name: "username", label: "Username" }, { name: "app_password", label: "App password", type: "password" }],
  gmail: [{ name: "client_id", label: "OAuth client_id" }, { name: "client_secret", label: "OAuth client_secret", type: "password" }, { name: "refresh_token", label: "OAuth refresh_token", type: "password" }],
  openaiAuth: [{ name: "api_key", label: "API key", type: "password" }],
  webhook: [{ name: "secret", label: "Shared secret", type: "password" }],
};

const SERVICE_LABELS: Record<string, string> = { gateway: "telegram", "gmail-listener": "gmail", "webhook-receiver": "webhook" };

function serviceLabel(name: string) {
  const noExt = name.replace(/\.service$/, "");
  if (name.startsWith("openclaw-")) return SERVICE_LABELS[noExt.replace(/^openclaw-/, "")] ?? noExt.replace(/^openclaw-/, "");
  if (name.startsWith("wdt-")) return "wdt";
  return noExt;
}

export default function AtlasControls({ agent, canEdit, integrations, capabilities, services }: Props) {
  const [localIntegrations, setLocalIntegrations] = useState(integrations);
  const [localCapabilities, setLocalCapabilities] = useState(capabilities);
  const [localServices, setLocalServices] = useState(services);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [credIntegration, setCredIntegration] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function toggle(kind: "integrations" | "capabilities", key: string, value: boolean) {
    if (!canEdit) return;
    const id = `${kind}:${key}`;
    setBusy(id);
    setMessage(null);
    const prev = kind === "integrations" ? localIntegrations[key] : localCapabilities[key];
    if (kind === "integrations") setLocalIntegrations((cur) => ({ ...cur, [key]: value }));
    else setLocalCapabilities((cur) => ({ ...cur, [key]: value }));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/registry/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, key, value }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage(`${key} ${value ? "enabled" : "disabled"}.`);
    } catch (err) {
      if (kind === "integrations") setLocalIntegrations((cur) => ({ ...cur, [key]: Boolean(prev) }));
      else setLocalCapabilities((cur) => ({ ...cur, [key]: Boolean(prev) }));
      setMessage(`Toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function toggleService(service: ServiceRow, enabled: boolean) {
    if (!canEdit) return;
    const verb = enabled ? "enable/start" : "disable/stop";
    if (!window.confirm(`${verb} ${service.name} for ${agent}?`)) return;
    setBusy(`service-toggle:${service.name}`);
    setMessage(null);
    const prev = localServices;
    setLocalServices((cur) => cur.map((svc) => svc.name === service.name ? { ...svc, status: enabled ? "active" : "inactive" } : svc));
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/services/toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service: service.name, enabled }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage(`${service.name} ${enabled ? "enabled" : "disabled"}.`);
    } catch (err) {
      setLocalServices(prev);
      setMessage(`Service toggle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function restart(service: string) {
    if (!canEdit) return;
    if (!window.confirm(`Restart ${service} for ${agent}? This will momentarily interrupt it.`)) return;
    setBusy(`service:${service}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/services/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage(`${service} restart requested; live status will refresh from Atlas.`);
    } catch (err) {
      setMessage(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function openCredentials(integration: string) {
    setCredIntegration(integration);
    setFields({});
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/integrations/credentials?integration=${encodeURIComponent(integration)}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json() as { fields?: Record<string, string> };
        setFields(data.fields ?? {});
      }
    } catch {}
  }

  async function saveCredentials() {
    if (!credIntegration) return;
    setBusy(`cred:${credIntegration}`);
    setMessage(null);
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/integrations/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ integration: credIntegration, fields }),
      });
      if (!res.ok) throw new Error(await res.text());
      setCredIntegration(null);
      setFields({});
      setMessage(`${credIntegration} credentials saved.`);
    } catch (err) {
      setMessage(`Credential save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {message ? <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-2 text-xs text-[var(--color-text-muted)]">{message}</p> : null}
      <ToggleSection title="Integrations" entries={localIntegrations} busy={busy} canEdit={canEdit} onToggle={(key, value) => toggle("integrations", key, value)} onCredentials={openCredentials} />
      <ToggleSection title="Capabilities" entries={localCapabilities} busy={busy} canEdit={canEdit} onToggle={(key, value) => toggle("capabilities", key, value)} />

      <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">🛠 Services</h2>
        {localServices.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">No services reported for this agent.</p> : (
          <div className="flex flex-wrap gap-2 text-xs">
            {localServices.map((svc) => {
              const enabled = svc.status === "active";
              const busyToggle = busy === `service-toggle:${svc.name}`;
              return (
                <span key={svc.name} className={`inline-flex items-center overflow-hidden rounded-full border ${enabled ? "border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 text-[var(--color-ok)]" : "border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[var(--color-text-muted)]"}`} title={`${svc.name}: ${svc.status ?? "unknown"}`}>
                  <button type="button" disabled={!canEdit || busyToggle} onClick={() => toggleService(svc, !enabled)} className="px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50">{serviceLabel(svc.name)}: {enabled ? "enabled" : "disabled"}</button>
                  <button type="button" disabled={!canEdit || busy === `service:${svc.name}`} onClick={() => restart(svc.name)} className="border-l border-current/20 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50" title={`Restart ${svc.name}`}>↻</button>
                </span>
              );
            })}
          </div>
        )}
      </section>

      {credIntegration ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">{credIntegration} credentials</h2>
              <button type="button" onClick={() => setCredIntegration(null)} className="text-xl text-[var(--color-text-muted)] hover:text-[var(--color-text)]">×</button>
            </div>
            <div className="space-y-3">
              {(CREDENTIAL_FIELDS[credIntegration] ?? []).map((field) => (
                <label key={field.name} className="block text-sm">
                  <span className="mb-1 block text-xs text-[var(--color-text-muted)]">{field.label}</span>
                  <input type={field.type ?? "text"} value={fields[field.name] ?? ""} onChange={(event) => setFields((cur) => ({ ...cur, [field.name]: event.target.value }))} className="w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 outline-none focus:border-[var(--color-accent)]" />
                </label>
              ))}
            </div>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">Saved through the Atlas credentials endpoint under the agent’s credential store.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setCredIntegration(null)} className="rounded-lg border border-[var(--color-line)] px-3 py-1.5 text-sm">Cancel</button>
              <button type="button" disabled={busy === `cred:${credIntegration}`} onClick={saveCredentials} className="rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40">Save</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToggleSection({ title, entries, busy, canEdit, onToggle, onCredentials }: { title: string; entries: Record<string, boolean>; busy: string | null; canEdit: boolean; onToggle: (key: string, value: boolean) => void; onCredentials?: (key: string) => void }) {
  const pairs = Object.entries(entries);
  return (
    <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
      <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h2>
      {pairs.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">None reported.</p> : (
        <div className="flex flex-wrap gap-2 text-xs">
          {pairs.map(([key, enabled]) => (
            <span key={key} className={`inline-flex items-center overflow-hidden rounded-full border ${enabled ? "border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 text-[var(--color-ok)]" : "border-[var(--color-line)] bg-[var(--color-panel-soft)] text-[var(--color-text-muted)]"}`}>
              <button type="button" disabled={!canEdit || busy === `${title.toLowerCase()}:${key}`} onClick={() => onToggle(key, !enabled)} className="px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50">{key}: {enabled ? "enabled" : "disabled"}</button>
              {onCredentials && CREDENTIAL_FIELDS[key] ? <button type="button" disabled={!canEdit} onClick={() => onCredentials(key)} className="border-l border-current/20 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50" title={`Edit ${key} credentials`}>⚙</button> : null}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
