"use client";

import { useState } from "react";
import type { ControlValue } from "@/lib/agents/management/effective-config";
import ConfirmPopup from "@/components/confirm-popup";

type ServiceRow = { name: string; status?: string };

type PendingPrompt =
  | { kind: "toggle"; service: ServiceRow; enabled: boolean }
  | { kind: "restart"; serviceName: string };

type Props = {
  agent: string;
  canEdit: boolean;
  integrations: Record<string, boolean>;
  capabilities: Record<string, ControlValue>;
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
  const [pending, setPending] = useState<PendingPrompt | null>(null);

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

  async function runToggleService(service: ServiceRow, enabled: boolean) {
    if (!canEdit) return;
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

  async function runRestart(service: string) {
    if (!canEdit) return;
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
    <div className="space-y-section-gap">
      {message ? <p className="rounded-card border border-line bg-panel-soft p-2 text-caption text-text-muted">{message}</p> : null}
      <ToggleSection title="Integrations" entries={localIntegrations} busy={busy} canEdit={canEdit} onToggle={(key, value) => toggle("integrations", key, value)} onCredentials={openCredentials} />
      <ToggleSection title="Capabilities" entries={localCapabilities} busy={busy} canEdit={canEdit} onToggle={(key, value) => toggle("capabilities", key, value)} />

      <section className="rounded-panel border border-line bg-panel p-card shadow-sm">
        <h2 className="mb-3 text-caption uppercase tracking-wider text-text-muted">🛠 Services</h2>
        {localServices.length === 0 ? <p className="text-body text-text-muted">No services reported for this agent.</p> : (
          <div className="grid gap-2 text-caption">
            {localServices.map((svc) => {
              const enabled = svc.status === "active";
              const busyToggle = busy === `service-toggle:${svc.name}`;
              return (
                <span key={svc.name} className={`inline-flex items-center justify-between overflow-hidden rounded-lg border ${enabled ? "border-ok/40 bg-ok/10 text-ok" : "border-line bg-panel-soft text-text-muted"}`} title={`${svc.name}: ${svc.status ?? "unknown"}`}>
                  <button type="button" disabled={!canEdit || busyToggle} onClick={() => setPending({ kind: "toggle", service: svc, enabled: !enabled })} className="px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50">{serviceLabel(svc.name)}: {enabled ? "enabled" : "disabled"}</button>
                  <button type="button" disabled={!canEdit || busy === `service:${svc.name}`} onClick={() => setPending({ kind: "restart", serviceName: svc.name })} className="border-l border-current/20 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50" title={`Restart ${svc.name}`}>↻</button>
                </span>
              );
            })}
          </div>
        )}
      </section>

      {credIntegration ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-card">
          <div className="w-full max-w-lg rounded-panel border border-line bg-panel p-card-lg shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-heading font-semibold">{credIntegration} credentials</h2>
              <button type="button" onClick={() => setCredIntegration(null)} className="text-heading text-text-muted hover:text-text">×</button>
            </div>
            <div className="space-y-3">
              {(CREDENTIAL_FIELDS[credIntegration] ?? []).map((field) => (
                <label key={field.name} className="block text-body">
                  <span className="mb-1 block text-caption text-text-muted">{field.label}</span>
                  <input type={field.type ?? "text"} value={fields[field.name] ?? ""} onChange={(event) => setFields((cur) => ({ ...cur, [field.name]: event.target.value }))} className="w-full rounded-lg border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
                </label>
              ))}
            </div>
            <p className="mt-3 text-caption text-text-muted">Saved through the Atlas credentials endpoint under the agent’s credential store.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setCredIntegration(null)} className="rounded-lg border border-line px-control-x py-control-y text-body">Cancel</button>
              <button type="button" disabled={busy === `cred:${credIntegration}`} onClick={saveCredentials} className="rounded-lg bg-accent px-control-x py-control-y text-body font-medium text-bg disabled:cursor-not-allowed disabled:opacity-40">Save</button>
            </div>
          </div>
        </div>
      ) : null}
      <ConfirmPopup
        open={pending !== null}
        title={
          pending?.kind === "restart"
            ? `Restart ${pending.serviceName}?`
            : pending?.kind === "toggle"
              ? `${pending.enabled ? "Enable/start" : "Disable/stop"} ${pending.service.name}?`
              : ""
        }
        description={
          pending?.kind === "restart"
            ? `Restart ${pending.serviceName} for ${agent}? This will momentarily interrupt it.`
            : pending?.kind === "toggle"
              ? `${pending.enabled ? "Enable/start" : "Disable/stop"} ${pending.service.name} for ${agent}?`
              : null
        }
        confirmLabel={
          pending?.kind === "restart"
            ? "Restart"
            : pending?.kind === "toggle"
              ? pending.enabled
                ? "Enable"
                : "Disable"
              : "Confirm"
        }
        danger={pending?.kind === "toggle" && !pending.enabled}
        busy={busy !== null}
        onConfirm={async () => {
          if (!pending) return;
          const next = pending;
          setPending(null);
          if (next.kind === "toggle") await runToggleService(next.service, next.enabled);
          else await runRestart(next.serviceName);
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

function ToggleSection({ title, entries, busy, canEdit, onToggle, onCredentials }: { title: string; entries: Record<string, ControlValue>; busy: string | null; canEdit: boolean; onToggle: (key: string, value: boolean) => void; onCredentials?: (key: string) => void }) {
  const pairs = Object.entries(entries);
  return (
    <section className="rounded-panel border border-line bg-panel p-card shadow-sm">
      <h2 className="mb-3 text-caption uppercase tracking-wider text-text-muted">{title}</h2>
      {pairs.length === 0 ? <p className="text-body text-text-muted">None reported.</p> : (
        <div className="grid gap-2 text-caption">
          {pairs.map(([key, value]) => {
            const enabled = value === true;
            const toggleable = typeof value === "boolean";
            return (
              <span key={key} className={`inline-flex items-center justify-between overflow-hidden rounded-lg border ${enabled ? "border-ok/40 bg-ok/10 text-ok" : "border-line bg-panel-soft text-text-muted"}`}>
                {toggleable ? (
                  <button type="button" disabled={!canEdit || busy === `${title.toLowerCase()}:${key}`} onClick={() => onToggle(key, !enabled)} className="px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50">{key}: {enabled ? "enabled" : "disabled"}</button>
                ) : (
                  <span className="px-2 py-1">{key}: {String(value)}</span>
                )}
                {onCredentials && CREDENTIAL_FIELDS[key] ? <button type="button" disabled={!canEdit} onClick={() => onCredentials(key)} className="border-l border-current/20 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50" title={`Edit ${key} credentials`}>⚙</button> : null}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
