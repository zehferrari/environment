"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export type AgentFormData = {
  user: string;
  name: string;
  role: "coding" | "monitor";
  email: string;
  telegram: {
    enabled: boolean;
    bot: string;
  };
  integrations: {
    gmail: boolean;
    jira: boolean;
    bitbucket: boolean;
  };
  model_config: {
    provider: string;
    default_model: string;
    fallback_models: string[];
  };
};

type AgentManagementControlsProps = {
  agents: Array<{
    slug: string;
    name: string;
    role: string;
    email: string | null;
    telegram?: { enabled: boolean; bot: string } | null;
    integrations?: { gmail: boolean; jira: boolean; bitbucket: boolean } | null;
    model_config?: { provider: string; default_model: string; fallback_models: string[] };
  }>;
};

const PROVIDERS = [
  { id: "google-gravity", name: "Google Gravity (OAuth)" },
  { id: "openai-codex", name: "OpenAI Codex" },
  { id: "ollama", name: "Ollama (Local)" },
];

const MODELS: Record<string, string[]> = {
  "google-gravity": ["gemini-3.5-flash", "gemini-3.1-pro", "claude-opus-4.6", "claude-sonnet-4.6"],
  "openai-codex": ["gpt-5.5"],
  "ollama": ["gemma4:31b-cloud", "nemotron-3-ultra:cloud"],
};

export default function AgentManagementControls({ agents }: AgentManagementControlsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isEdit, setIsEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initialForm = (): AgentFormData => ({
    user: "",
    name: "",
    role: "coding",
    email: "",
    telegram: { enabled: false, bot: "" },
    integrations: { gmail: false, jira: false, bitbucket: false },
    model_config: {
      provider: "google-gravity",
      default_model: "google-gravity/gemini-3.5-flash",
      fallback_models: [],
    },
  });

  const [form, setForm] = useState<AgentFormData>(initialForm());

  const handleOpenAdd = () => {
    setForm(initialForm());
    setIsEdit(false);
    setError(null);
    setOpen(true);
  };

  const handleOpenEdit = (slug: string) => {
    const agent = agents.find((a) => a.slug === slug);
    if (!agent) return;

    setForm({
      user: agent.slug,
      name: agent.name,
      role: (agent.role === "monitor" ? "monitor" : "coding") as "coding" | "monitor",
      email: agent.email || "",
      telegram: {
        enabled: agent.telegram?.enabled ?? false,
        bot: agent.telegram?.bot ?? "",
      },
      integrations: {
        gmail: agent.integrations?.gmail ?? false,
        jira: agent.integrations?.jira ?? false,
        bitbucket: agent.integrations?.bitbucket ?? false,
      },
      model_config: {
        provider: agent.model_config?.provider || "google-gravity",
        default_model: agent.model_config?.default_model || "google-gravity/gemini-3.5-flash",
        fallback_models: agent.model_config?.fallback_models || [],
      },
    });
    setIsEdit(true);
    setError(null);
    setOpen(true);
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).openEditAgentModal = handleOpenEdit;
    }
    return () => {
      if (typeof window !== "undefined") {
        delete (window as any).openEditAgentModal;
      }
    };
  }, [agents]);


  const handleProviderChange = (provider: string) => {
    const defaultModel = MODELS[provider]?.[0] || "";
    setForm((prev) => ({
      ...prev,
      model_config: {
        provider,
        default_model: `${provider}/${defaultModel}`,
        fallback_models: [],
      },
    }));
  };

  const handleFallbackToggle = (model: string) => {
    setForm((prev) => {
      const current = prev.model_config.fallback_models;
      const next = current.includes(model)
        ? current.filter((m) => m !== model)
        : [...current, model];
      return {
        ...prev,
        model_config: { ...prev.model_config, fallback_models: next },
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const url = isEdit ? "/api/agents/edit" : "/api/agents/add";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed with status ${res.status}`);
      }

      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Are you absolutely sure you want to completely remove agent @${form.user}? This will delete their Linux user, workspace, and config files.`)) {
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/agents/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user: form.user }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed with status ${res.status}`);
      }

      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex gap-2">
        <button
          onClick={handleOpenAdd}
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-bg)] hover:opacity-90 transition cursor-pointer"
        >
          Add Agent +
        </button>
      </div>

      {/* Global listener hook so page cards can call Edit */}
      <style jsx global>{`
        .edit-agent-trigger {
          cursor: pointer;
        }
      `}</style>

      {/* Expose handleOpenEdit to window for the Server Component's edit triggers */}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm transition-all duration-300"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-2xl overflow-y-auto max-h-[90vh] animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-line)] pb-3">
              <h3 className="text-lg font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                {isEdit ? `Edit Agent @${form.user}` : "Add New Agent"}
              </h3>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="text-2xl leading-none text-[var(--color-text-muted)] hover:text-[var(--color-text)] cursor-pointer disabled:opacity-50"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-sm">
              {error && (
                <div className="rounded-xl bg-[var(--color-crit)] bg-opacity-10 border border-[var(--color-crit)] p-3 text-xs text-[var(--color-crit)]">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                  User Slug (Username)
                </label>
                <input
                  type="text"
                  required
                  disabled={isEdit || busy}
                  placeholder="e.g. carmen"
                  value={form.user}
                  onChange={(e) => setForm({ ...form, user: e.target.value.toLowerCase().trim() })}
                  className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60"
                />
                {!isEdit && (
                  <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                    Lowercase letters and numbers only. This matches the Linux system username.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                  Display Name
                </label>
                <input
                  type="text"
                  required
                  disabled={busy}
                  placeholder="e.g. Carmen Perfecta"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                    Role
                  </label>
                  <select
                    disabled={busy}
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as "coding" | "monitor" })}
                    className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                  >
                    <option value="coding">Coding Agent</option>
                    <option value="monitor">Monitor Agent</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                    Email
                  </label>
                  <input
                    type="email"
                    required
                    disabled={busy}
                    placeholder="carmen@zeh.me"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value.trim() })}
                    className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </div>
              </div>

              <div className="rounded-xl border border-[var(--color-line)] p-3 space-y-3 bg-[var(--color-panel-soft)]">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                    Telegram Integration
                  </span>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={form.telegram.enabled}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        telegram: { ...form.telegram, enabled: e.target.checked },
                      })
                    }
                    className="h-4 w-4 rounded border-[var(--color-line)] accent-[var(--color-accent)] focus:ring-0 cursor-pointer"
                  />
                </div>
                {form.telegram.enabled && (
                  <div>
                    <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">
                      Telegram Bot Username
                    </label>
                    <input
                      type="text"
                      required={form.telegram.enabled}
                      disabled={busy}
                      placeholder="e.g. @carmenPerfecta2026_bot"
                      value={form.telegram.bot}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          telegram: { ...form.telegram, bot: e.target.value.trim() },
                        })
                      }
                      className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                    />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-[var(--color-line)] p-3 bg-[var(--color-panel-soft)]">
                <span className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                  Integrations
                </span>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={form.integrations.gmail}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          integrations: { ...form.integrations, gmail: e.target.checked },
                        })
                      }
                      className="h-4 w-4 rounded accent-[var(--color-accent)] cursor-pointer"
                    />
                    <span>Gmail</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={form.integrations.jira}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          integrations: { ...form.integrations, jira: e.target.checked },
                        })
                      }
                      className="h-4 w-4 rounded accent-[var(--color-accent)] cursor-pointer"
                    />
                    <span>Jira</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      disabled={busy}
                      checked={form.integrations.bitbucket}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          integrations: { ...form.integrations, bitbucket: e.target.checked },
                        })
                      }
                      className="h-4 w-4 rounded accent-[var(--color-accent)] cursor-pointer"
                    />
                    <span>Bitbucket</span>
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-[var(--color-line)] p-3 bg-[var(--color-panel-soft)] space-y-3">
                <span className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Model Configuration
                </span>
                
                <div>
                  <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">
                    Model Provider
                  </label>
                  <select
                    disabled={busy}
                    value={form.model_config.provider}
                    onChange={(e) => handleProviderChange(e.target.value)}
                    className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">
                    Primary Default Model
                  </label>
                  <select
                    disabled={busy}
                    value={form.model_config.default_model}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        model_config: { ...form.model_config, default_model: e.target.value },
                      })
                    }
                    className="w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-1.5 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none"
                  >
                    {(MODELS[form.model_config.provider] || []).map((m) => {
                      const fullId = `${form.model_config.provider}/${m}`;
                      return (
                        <option key={fullId} value={fullId}>
                          {m}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-2">
                    Fallback Models
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {Object.entries(MODELS).flatMap(([prov, list]) =>
                      list.map((m) => {
                        const fullId = `${prov}/${m}`;
                        if (fullId === form.model_config.default_model) return null;
                        const isChecked = form.model_config.fallback_models.includes(fullId);
                        return (
                          <label key={fullId} className="flex items-center gap-2 cursor-pointer text-xs">
                            <input
                              type="checkbox"
                              disabled={busy}
                              checked={isChecked}
                              onChange={() => handleFallbackToggle(fullId)}
                              className="h-3.5 w-3.5 rounded accent-[var(--color-accent)] cursor-pointer"
                            />
                            <span className="truncate">{m} ({prov.split("-")[0]})</span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-between items-center border-t border-[var(--color-line)] pt-4">
                {isEdit ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDelete}
                    className="rounded-lg bg-[var(--color-crit)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 transition cursor-pointer"
                  >
                    Delete Agent
                  </button>
                ) : (
                  <div />
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setOpen(false)}
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition disabled:opacity-50 cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-[var(--color-bg)] hover:opacity-90 disabled:opacity-50 transition flex items-center gap-1.5 cursor-pointer"
                  >
                    {busy ? (
                      <>
                        <svg className="animate-spin h-3.5 w-3.5 text-current" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Deploying…
                      </>
                    ) : (
                      isEdit ? "Save Changes" : "Create Agent"
                    )}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

export function EditAgentButton({ slug }: { slug: string }) {
  return (
    <button
      onClick={() => {
        if ((window as any).openEditAgentModal) {
          (window as any).openEditAgentModal(slug);
        }
      }}
      className="text-[11px] text-[var(--color-accent)] hover:underline ml-2 cursor-pointer font-medium"
    >
      Edit
    </button>
  );
}

