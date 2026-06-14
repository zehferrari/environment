"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PROVIDERS,
  getProvider,
  isProviderId,
  modelIdOfRef,
  providerOfModelRef,
  type ProviderId,
  type ProviderModel,
} from "@/lib/agents/providers";
import {
  AGENT_PROFILE_IMAGE_THEMES,
  GENERATED_IMAGE_THEME,
  MANUAL_IMAGE_THEME,
  normalizeProfileImageTheme,
} from "@/lib/agents/profile-image-themes";
import {
  DEFAULT_PROFILE_IMAGE_AGE_GROUP,
  DEFAULT_PROFILE_IMAGE_CUSTOMIZATION_MODE,
  DEFAULT_PROFILE_IMAGE_ETHNICITY,
  DEFAULT_PROFILE_IMAGE_GENDER,
  DEFAULT_PROFILE_IMAGE_PROMPT,
  PROFILE_IMAGE_AGE_GROUPS,
  PROFILE_IMAGE_CUSTOMIZATION_MODES,
  PROFILE_IMAGE_ETHNICITIES,
  PROFILE_IMAGE_GENDERS,
} from "@/lib/agents/profile-image-options";

type SelectedModel = { provider: string; id: string; name?: string };

type ModelConfig = {
  default_model: string;
  fallback_models: string[];
  selected_models: SelectedModel[];
};

export type AgentFormData = {
  user: string;
  name: string;
  role: "coding" | "monitor";
  email: string;
  telegram: { enabled: boolean; bot: string; token: string };
  integrations: { gmail: boolean; jira: boolean; bitbucket: boolean; maildir: boolean };
  image_theme: string;
  image_gender: string;
  image_age_group: string;
  image_ethnicity: string;
  image_customization_mode: string;
  image_prompt: string;
  image_username: string;
  image_full_name: string;
  image_bio: string;
};

type AgentRow = {
  slug: string;
  name: string;
  role: string;
  email: string | null;
  telegram?: { enabled: boolean; bot: string } | null;
  integrations?: { gmail: boolean; jira: boolean; bitbucket: boolean; maildir?: boolean } | null;
  model_config?: ModelConfig;
  image_theme?: string | null;
  image_gender?: string | null;
  image_age_group?: string | null;
  image_ethnicity?: string | null;
  image_customization_mode?: string | null;
  image_prompt?: string | null;
  image_username?: string | null;
  image_full_name?: string | null;
  image_bio?: string | null;
};

type AgentManagementControlsProps = { agents: AgentRow[]; defaultPrompt: string };

const refOf = (m: SelectedModel) => `${m.provider}/${m.id}`;

const DEFAULT_PROVIDER: ProviderId = "anthropic";
const DEFAULT_MODEL_REF = "anthropic/claude-sonnet-4-6";

function blankForm(defaultPrompt = DEFAULT_PROFILE_IMAGE_PROMPT): AgentFormData {
  return {
    user: "",
    name: "",
    role: "coding",
    email: "",
    telegram: { enabled: false, bot: "", token: "" },
    integrations: { gmail: false, jira: false, bitbucket: false, maildir: false },
    image_theme: GENERATED_IMAGE_THEME,
    image_gender: DEFAULT_PROFILE_IMAGE_GENDER,
    image_age_group: DEFAULT_PROFILE_IMAGE_AGE_GROUP,
    image_ethnicity: DEFAULT_PROFILE_IMAGE_ETHNICITY,
    image_customization_mode: DEFAULT_PROFILE_IMAGE_CUSTOMIZATION_MODE,
    image_prompt: defaultPrompt,
    image_username: "",
    image_full_name: "",
    image_bio: "",
  };
}

const KAREN_NAMES = ["Mildred", "Basil", "Daphne", "Percival", "Gwendolyn", "Rupert", "Beatrix", "Nigel", "Prudence", "Milton"];
const KAREN_SURNAMES = ["Wobbleworth", "Pickleford", "Spreadsheet", "Fuzzbutton", "Ticklebank", "Puddington", "Quibbleton", "Snickerdash", "Bumblewick", "Noodleman"];
const BIO_BITS = [
  "keeps meeting notes alphabetized by emotional temperature",
  "claims every problem can be solved with a tidy checklist and a tiny biscuit",
  "once optimized a calendar invite until it achieved inner peace",
  "has strong opinions about labels, lighting, and the moral value of tidy folders",
  "quietly turns chaos into status updates before anyone notices",
];

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function suggestKarenProfile(user: string) {
  const fullName = `${pick(KAREN_NAMES)} ${pick(KAREN_SURNAMES)}`;
  const bio = `${fullName} is @${user || "agent"}'s corporate alter ego: a fictional AI agent who ${pick(BIO_BITS)}.`;
  return { fullName, bio };
}

export default function AgentManagementControls({ agents, defaultPrompt }: AgentManagementControlsProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isEdit, setIsEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<AgentFormData>(() => blankForm(defaultPrompt));

  // Model selection state.
  const [enabled, setEnabled] = useState<Set<ProviderId>>(new Set([DEFAULT_PROVIDER]));
  const [available, setAvailable] = useState<Record<string, ProviderModel[]>>({});
  const [selected, setSelected] = useState<SelectedModel[]>([]);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [fallbacks, setFallbacks] = useState<string[]>([]);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const seedFor = (p: ProviderId): ProviderModel[] => getProvider(p)?.seedModels ?? [];

  const handleOpenAdd = () => {
    setForm(blankForm(defaultPrompt));
    const seed = seedFor(DEFAULT_PROVIDER);
    setEnabled(new Set([DEFAULT_PROVIDER]));
    setAvailable({ [DEFAULT_PROVIDER]: seed });
    setSelected(seed.map((m) => ({ provider: DEFAULT_PROVIDER, id: m.id, name: m.name })));
    setDefaultModel(DEFAULT_MODEL_REF);
    setFallbacks([]);
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
      role: agent.role === "monitor" ? "monitor" : "coding",
      email: agent.email || "",
      telegram: {
        enabled: agent.telegram?.enabled ?? false,
        bot: agent.telegram?.bot ?? "",
        token: "", // write-only; never echoed back
      },
      integrations: {
        gmail: agent.integrations?.gmail ?? false,
        jira: agent.integrations?.jira ?? false,
        bitbucket: agent.integrations?.bitbucket ?? false,
        maildir: agent.integrations?.maildir ?? false,
      },
      image_theme: normalizeProfileImageTheme(agent.image_theme),
      image_gender: agent.image_gender ?? DEFAULT_PROFILE_IMAGE_GENDER,
      image_age_group: agent.image_age_group ?? DEFAULT_PROFILE_IMAGE_AGE_GROUP,
      image_ethnicity: agent.image_ethnicity ?? DEFAULT_PROFILE_IMAGE_ETHNICITY,
      image_customization_mode: agent.image_customization_mode ?? DEFAULT_PROFILE_IMAGE_CUSTOMIZATION_MODE,
      image_prompt: agent.image_prompt ?? defaultPrompt,
      image_username: agent.image_username ?? agent.slug,
      image_full_name: agent.image_full_name ?? agent.name,
      image_bio: agent.image_bio ?? "",
    });

    // Prefill model selection from the agent's openclaw.json, dropping any
    // retired providers (e.g. google-gravity) so re-saving migrates them off it.
    const known = (agent.model_config?.selected_models ?? []).filter((m) => isProviderId(m.provider));
    const providers = new Set<ProviderId>(known.map((m) => m.provider as ProviderId));
    if (providers.size === 0) providers.add(DEFAULT_PROVIDER);
    const avail: Record<string, ProviderModel[]> = {};
    for (const p of providers) {
      const sel = known.filter((m) => m.provider === p).map((m) => ({ id: m.id, name: m.name || m.id }));
      avail[p] = mergeModels(seedFor(p), sel);
    }
    setEnabled(providers);
    setAvailable(avail);
    setSelected(known);
    const defRef = agent.model_config?.default_model ?? "";
    setDefaultModel(isProviderId(providerOfModelRef(defRef)) ? defRef : "");
    setFallbacks((agent.model_config?.fallback_models ?? []).filter((r) => isProviderId(providerOfModelRef(r))));
    setIsEdit(true);
    setError(null);
    setOpen(true);
  };

  useEffect(() => {
    if (typeof window !== "undefined") (window as any).openEditAgentModal = handleOpenEdit;
    return () => {
      if (typeof window !== "undefined") delete (window as any).openEditAgentModal;
    };
  }, [agents]);

  // --- provider / model handlers ---

  const toggleProvider = (p: ProviderId) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        next.delete(p);
        setSelected((s) => s.filter((m) => m.provider !== p));
        setDefaultModel((d) => (providerOfModelRef(d) === p ? "" : d));
        setFallbacks((f) => f.filter((r) => providerOfModelRef(r) !== p));
      } else {
        next.add(p);
        setAvailable((a) => (a[p] ? a : { ...a, [p]: seedFor(p) }));
      }
      return next;
    });
  };

  const isSelected = (p: string, id: string) => selected.some((m) => m.provider === p && m.id === id);

  const toggleModel = (p: string, m: ProviderModel) => {
    const ref = `${p}/${m.id}`;
    setSelected((prev) => {
      if (prev.some((x) => x.provider === p && x.id === m.id)) {
        setDefaultModel((d) => (d === ref ? "" : d));
        setFallbacks((f) => f.filter((r) => r !== ref));
        return prev.filter((x) => !(x.provider === p && x.id === m.id));
      }
      return [...prev, { provider: p, id: m.id, name: m.name }];
    });
  };

  const refresh = async (p: ProviderId, filter?: string) => {
    setRefreshing(p);
    setError(null);
    try {
      const url = `/api/agents/models?provider=${encodeURIComponent(p)}${filter ? `&filter=${filter}` : ""}`;
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `refresh failed (${res.status})`);
      const models: ProviderModel[] = data.models ?? [];
      setAvailable((a) => ({ ...a, [p]: mergeModels(models, selected.filter((s) => s.provider === p)) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(null);
    }
  };

  const selectedRefs = useMemo(() => selected.map(refOf), [selected]);
  const fallbackCandidates = useMemo(
    () => selectedRefs.filter((r) => r !== defaultModel && !fallbacks.includes(r)),
    [selectedRefs, defaultModel, fallbacks],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    if (selected.length === 0) {
      setError("Select at least one available model.");
      setBusy(false);
      return;
    }
    if (!defaultModel || !selectedRefs.includes(defaultModel)) {
      setError("Pick a default model from the selected models.");
      setBusy(false);
      return;
    }

    const payload = {
      ...form,
      model_config: {
        default_model: defaultModel,
        fallback_models: fallbacks,
        selected_models: selected,
      },
    };

    const url = isEdit ? "/api/agents/edit" : "/api/agents/add";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
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
    if (!confirm(`Completely remove agent @${form.user}? This deletes their Linux user, workspace, and config.`)) return;
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

  const labelFor = (ref: string) => {
    const m = selected.find((s) => refOf(s) === ref);
    return m?.name || modelIdOfRef(ref);
  };

  const inputCls =
    "w-full rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-60";
  const labelCls = "block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1";

  return (
    <>
      <button
        onClick={handleOpenAdd}
        className="rounded-xl border border-[var(--color-line)] bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-bg)] transition hover:opacity-90 cursor-pointer"
      >
        Add Agent +
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-2xl overflow-y-auto rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-2xl max-h-[92vh]"
          >
            <div className="flex items-center justify-between border-b border-[var(--color-line)] pb-3">
              <h3 className="text-lg font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                {isEdit ? `Edit Agent @${form.user}` : "Add New Agent"}
              </h3>
              <button
                type="button"
                disabled={busy}
                onClick={() => setOpen(false)}
                className="cursor-pointer text-2xl leading-none text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
              >
                &times;
              </button>
            </div>

            <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-sm">
              {error && (
                <div className="rounded-xl border border-[var(--color-crit)] bg-[var(--color-crit)]/10 p-3 text-xs text-[var(--color-crit)]">
                  {error}
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>User slug</label>
                  <input
                    type="text"
                    required
                    disabled={isEdit || busy}
                    placeholder="e.g. carmen"
                    value={form.user}
                    onChange={(e) => setForm({ ...form, user: e.target.value.toLowerCase().trim() })}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Display name</label>
                  <input
                    type="text"
                    required
                    disabled={busy}
                    placeholder="e.g. Carmen Perfecta"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className={inputCls}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Role</label>
                  <select
                    disabled={busy}
                    value={form.role}
                    onChange={(e) => setForm({ ...form, role: e.target.value as "coding" | "monitor" })}
                    className={inputCls}
                  >
                    <option value="coding">Coding Agent</option>
                    <option value="monitor">Monitor Agent</option>
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Email</label>
                  <input
                    type="email"
                    required
                    disabled={busy}
                    placeholder="carmen@host"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value.trim() })}
                    className={inputCls}
                  />
                </div>
              </div>

              {!isEdit ? (
                <div>
                  <label className={labelCls}>Image source</label>
                  <select
                    disabled={busy}
                    value={form.image_theme}
                    onChange={(e) => setForm({ ...form, image_theme: e.target.value })}
                    className={inputCls}
                  >
                    {AGENT_PROFILE_IMAGE_THEMES.map((theme) => (
                      <option key={theme} value={theme}>{theme}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                    Pick <span className="font-medium">{MANUAL_IMAGE_THEME}</span> to upload profile/avatar images yourself from the agent profile page.
                    Generated images use Confy with the selected demographic options.
                  </p>
                </div>
              ) : null}

              {!isEdit && form.image_theme !== MANUAL_IMAGE_THEME ? (
                <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3">
                  <span className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Image customization</span>
                  <div className="flex flex-wrap gap-3 text-sm">
                    {PROFILE_IMAGE_CUSTOMIZATION_MODES.map((mode) => (
                      <label key={mode} className="flex items-center gap-2">
                        <input
                          type="radio"
                          disabled={busy}
                          checked={form.image_customization_mode === mode}
                          onChange={() => {
                            const suggestion =
                              mode === "Custom" && !form.image_full_name.trim() && !form.image_bio.trim()
                                ? suggestKarenProfile(form.user)
                                : null;
                            setForm({
                              ...form,
                              image_customization_mode: mode,
                              image_full_name: suggestion?.fullName ?? form.image_full_name,
                              image_bio: suggestion?.bio ?? form.image_bio,
                              ...(mode === "Random" ? {
                                image_gender: DEFAULT_PROFILE_IMAGE_GENDER,
                                image_age_group: DEFAULT_PROFILE_IMAGE_AGE_GROUP,
                                image_ethnicity: DEFAULT_PROFILE_IMAGE_ETHNICITY,
                              } : {}),
                            });
                          }}
                          className="h-4 w-4 accent-[var(--color-accent)]"
                        />
                        <span>{mode}</span>
                      </label>
                    ))}
                  </div>
                  {form.image_customization_mode === "Custom" ? (
                    <div className="space-y-3">
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <label className={labelCls}>Gender</label>
                          <select disabled={busy} value={form.image_gender} onChange={(e) => setForm({ ...form, image_gender: e.target.value })} className={inputCls}>
                            {PROFILE_IMAGE_GENDERS.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={labelCls}>Age group</label>
                          <select disabled={busy} value={form.image_age_group} onChange={(e) => setForm({ ...form, image_age_group: e.target.value })} className={inputCls}>
                            {PROFILE_IMAGE_AGE_GROUPS.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={labelCls}>Ethnicity</label>
                          <select disabled={busy} value={form.image_ethnicity} onChange={(e) => setForm({ ...form, image_ethnicity: e.target.value })} className={inputCls}>
                            {PROFILE_IMAGE_ETHNICITIES.map((option) => <option key={option} value={option}>{option}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className={labelCls}>Username for image prompt</label>
                          <input disabled={busy} value={form.image_username || form.user} onChange={(e) => setForm({ ...form, image_username: e.target.value })} className={inputCls} />
                        </div>
                        <div>
                          <label className={labelCls}>Full name for image prompt</label>
                          <div className="flex gap-2">
                            <input disabled={busy} value={form.image_full_name || form.name} onChange={(e) => setForm({ ...form, image_full_name: e.target.value })} className={inputCls} />
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                const suggestion = suggestKarenProfile(form.user);
                                setForm({
                                  ...form,
                                  image_full_name: suggestion.fullName,
                                  image_bio: suggestion.bio,
                                });
                              }}
                              className="shrink-0 rounded-xl border border-[var(--color-line)] px-3 py-2 text-xs font-medium hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Karen suggest
                            </button>
                          </div>
                        </div>
                      </div>
                      <div>
                        <label className={labelCls}>Bio</label>
                        <textarea disabled={busy} value={form.image_bio} onChange={(e) => setForm({ ...form, image_bio: e.target.value })} rows={2} className={inputCls} />
                      </div>
                      <div>
                        <label className={labelCls}>Confy prompt</label>
                        <textarea disabled={busy} value={form.image_prompt} onChange={(e) => setForm({ ...form, image_prompt: e.target.value })} rows={4} className={inputCls} />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* ---- Model providers + models ---- */}
              <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3">
                <span className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Providers & models
                </span>
                <div className="flex flex-wrap gap-3">
                  {PROVIDERS.map((p) => (
                    <label key={p.id} className="flex cursor-pointer items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={enabled.has(p.id)}
                        onChange={() => toggleProvider(p.id)}
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span>{p.name}</span>
                    </label>
                  ))}
                </div>

                {[...enabled].map((p) => {
                  const def = getProvider(p);
                  const models = available[p] ?? def?.seedModels ?? [];
                  return (
                    <div key={p} className="rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] p-2.5">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-[var(--color-text)]">{def?.name ?? p}</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy || refreshing === p}
                            onClick={() => refresh(p)}
                            className="rounded border border-[var(--color-line)] px-2 py-0.5 text-[10px] font-medium hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                          >
                            {refreshing === p ? "Refreshing…" : "Refresh"}
                          </button>
                          {(def?.filters ?? []).map((f) => (
                            <button
                              key={f}
                              type="button"
                              disabled={busy || refreshing === p}
                              onClick={() => refresh(p, f)}
                              className="rounded border border-[var(--color-line)] px-2 py-0.5 text-[10px] capitalize hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                            >
                              {f}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                        {models.length === 0 ? (
                          <span className="text-[10px] text-[var(--color-text-muted)]">No models — hit Refresh.</span>
                        ) : (
                          models.map((m) => (
                            <label key={m.id} className="flex cursor-pointer items-center gap-2 truncate text-[11px]">
                              <input
                                type="checkbox"
                                disabled={busy}
                                checked={isSelected(p, m.id)}
                                onChange={() => toggleModel(p, m)}
                                className="h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]"
                              />
                              <span className="truncate" title={m.name}>
                                {m.name}
                                {m.free ? <span className="ml-1 text-[var(--color-ok)]">free</span> : null}
                              </span>
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  );
                })}

                <div>
                  <label className={labelCls}>Default model</label>
                  <select
                    disabled={busy}
                    value={defaultModel}
                    onChange={(e) => {
                      const v = e.target.value;
                      setDefaultModel(v);
                      setFallbacks((f) => f.filter((r) => r !== v));
                    }}
                    className={inputCls}
                  >
                    <option value="">— pick a default —</option>
                    {selectedRefs.map((r) => (
                      <option key={r} value={r}>
                        {labelFor(r)} ({providerOfModelRef(r)})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className={labelCls}>Fallback order (drag to reorder)</label>
                  <FallbackList
                    refs={fallbacks}
                    labelFor={labelFor}
                    onReorder={setFallbacks}
                    onRemove={(r) => setFallbacks((f) => f.filter((x) => x !== r))}
                    disabled={busy}
                  />
                  {fallbackCandidates.length > 0 && (
                    <select
                      disabled={busy}
                      value=""
                      onChange={(e) => {
                        if (e.target.value) setFallbacks((f) => [...f, e.target.value]);
                      }}
                      className={`${inputCls} mt-2`}
                    >
                      <option value="">+ add fallback…</option>
                      {fallbackCandidates.map((r) => (
                        <option key={r} value={r}>
                          {labelFor(r)} ({providerOfModelRef(r)})
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              {/* ---- Telegram ---- */}
              <div className="space-y-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3">
                <label className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Telegram integration
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={form.telegram.enabled}
                    onChange={(e) => setForm({ ...form, telegram: { ...form.telegram, enabled: e.target.checked } })}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                </label>
                {form.telegram.enabled && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-[var(--color-text-muted)]">Bot username</label>
                      <input
                        type="text"
                        disabled={busy}
                        placeholder="@carmen_bot"
                        value={form.telegram.bot}
                        onChange={(e) => setForm({ ...form, telegram: { ...form.telegram, bot: e.target.value.trim() } })}
                        className={inputCls}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-semibold text-[var(--color-text-muted)]">
                        Bot token {isEdit ? "(leave blank to keep)" : ""}
                      </label>
                      <input
                        type="password"
                        disabled={busy}
                        placeholder="123456:ABC-DEF…"
                        value={form.telegram.token}
                        onChange={(e) => setForm({ ...form, telegram: { ...form.telegram, token: e.target.value.trim() } })}
                        className={inputCls}
                      />
                    </div>
                    <p className="text-[10px] text-[var(--color-text-muted)] sm:col-span-2">
                      DM policy is <span className="font-mono">pairing</span>: after deploy, DM the bot and it replies
                      with a pair code to authorise your account.
                    </p>
                  </div>
                )}
              </div>

              {/* ---- Integrations ---- */}
              <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-3">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                  Integrations
                </span>
                <div className="flex flex-wrap gap-4">
                  {(["gmail", "jira", "bitbucket", "maildir"] as const).map((k) => (
                    <label key={k} className="flex cursor-pointer items-center gap-2 capitalize">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={form.integrations[k]}
                        onChange={(e) =>
                          setForm({ ...form, integrations: { ...form.integrations, [k]: e.target.checked } })
                        }
                        className="h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span>{k === "maildir" ? "Server email (Maildir)" : k}</span>
                    </label>
                  ))}
                </div>
                {form.integrations.maildir && (
                  <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
                    Provisions a local <span className="font-mono">~/Maildir</span> + mail listener. Requires an MTA
                    (Postfix/Dovecot) on the host; add the address to the local-mail allowlist.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between border-t border-[var(--color-line)] pt-4">
                {isEdit ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleDelete}
                    className="cursor-pointer rounded-lg bg-[var(--color-crit)] px-4 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
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
                    className="cursor-pointer rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-xs font-semibold text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="cursor-pointer rounded-lg bg-[var(--color-accent)] px-4 py-2 text-xs font-semibold text-[var(--color-bg)] hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? "Deploying…" : isEdit ? "Save Changes" : "Create Agent"}
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

function mergeModels(primary: ProviderModel[], extra: Array<{ id: string; name?: string }>): ProviderModel[] {
  const map = new Map<string, ProviderModel>();
  for (const m of primary) map.set(m.id, m);
  for (const m of extra) if (!map.has(m.id)) map.set(m.id, { id: m.id, name: m.name || m.id });
  return [...map.values()];
}

function FallbackList({
  refs,
  labelFor,
  onReorder,
  onRemove,
  disabled,
}: {
  refs: string[];
  labelFor: (ref: string) => string;
  onReorder: (refs: string[]) => void;
  onRemove: (ref: string) => void;
  disabled: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = refs.indexOf(String(active.id));
    const newIndex = refs.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(refs, oldIndex, newIndex));
  };

  if (refs.length === 0) {
    return <p className="text-[10px] text-[var(--color-text-muted)]">No fallbacks. Add one below.</p>;
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={refs} strategy={verticalListSortingStrategy}>
        <ul className="space-y-1">
          {refs.map((r, i) => (
            <FallbackRow key={r} id={r} index={i} label={labelFor(r)} onRemove={() => onRemove(r)} disabled={disabled} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function FallbackRow({
  id,
  index,
  label,
  onRemove,
  disabled,
}: {
  id: string;
  index: number;
  label: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] px-2 py-1.5 text-[11px] ${
        isDragging ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
        className="cursor-grab select-none px-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] active:cursor-grabbing"
      >
        ⋮⋮
      </button>
      <span className="w-4 text-center font-mono text-[10px] text-[var(--color-text-muted)]">{index + 1}</span>
      <span className="min-w-0 flex-1 truncate" title={id}>
        {label} <span className="text-[var(--color-text-muted)]">({providerOfModelRef(id)})</span>
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onRemove}
        className="rounded px-1 text-[var(--color-text-muted)] hover:text-[var(--color-crit)] disabled:opacity-50"
        aria-label="Remove fallback"
      >
        ×
      </button>
    </li>
  );
}

export function EditAgentButton({ slug }: { slug: string }) {
  return (
    <button
      onClick={() => (window as any).openEditAgentModal?.(slug)}
      className="ml-2 cursor-pointer text-[11px] font-medium text-[var(--color-accent)] hover:underline"
    >
      Edit
    </button>
  );
}
