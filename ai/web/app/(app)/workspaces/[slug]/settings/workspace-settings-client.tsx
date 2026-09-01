"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Workspace = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  borderColor: string | null;
  archivedAt: string | null;
  logo: { url: string; mimeType: string | null; sizeBytes: number | null; updatedAt: string | null } | null;
  projects: { id: string; slug: string; name: string; archivedAt: string | null; deletedAt: string | null }[];
  agentPool: { id: string; slug: string; name: string; role: string; deactivatedAt: string | null }[];
  defaults: {
    defaultGitUserName: string | null;
    defaultGitUserEmail: string | null;
    doneTtlDays: number | null;
    deploymentProvider: string | null;
    deploymentProductionBranch: string | null;
    deploymentPrTargetBranch: string | null;
    deploymentMode: string | null;
    deploymentOnMerge: string | null;
    deploymentPipelineName: string | null;
    deploymentHost: string | null;
    deploymentEnvironment: string | null;
    deploymentBitbucketWorkspace: string | null;
    deploymentBitbucketRepoSlug: string | null;
    integrationDefaults: string | null;
    hourlyRate: string;
    billingCurrency: string | null;
  };
  createdAt: string;
  updatedAt: string;
};

type ProjectOption = { id: string; slug: string; name: string; archived: boolean };
type AgentOption = { id: string; slug: string; name: string; role: string };

const WORKSPACE_TYPES = [
  { value: "internal", label: "Internal" },
  { value: "client", label: "Client" },
  { value: "personal", label: "Personal" },
  { value: "other", label: "Other" },
];

const slugPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const inputClass = "w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-body outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-70";
const cardClass = "rounded-panel border border-line bg-panel p-card shadow-sm";

function idsFrom<T extends { id: string }>(items: T[]) {
  return items.map((item) => item.id);
}

function formatBytes(value: number | null | undefined) {
  if (!value) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export default function WorkspaceSettingsClient({
  initialWorkspace,
  projects,
  agents,
}: {
  initialWorkspace: Workspace;
  projects: ProjectOption[];
  agents: AgentOption[];
}) {
  const router = useRouter();
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [name, setName] = useState(initialWorkspace.name);
  const [slug, setSlug] = useState(initialWorkspace.slug);
  const [type, setType] = useState(initialWorkspace.type);
  const [borderColor, setBorderColor] = useState(initialWorkspace.borderColor ?? "#2563eb");
  const [description, setDescription] = useState(initialWorkspace.description ?? "");
  const [defaults, setDefaults] = useState(() => initialWorkspace.defaults);
  const [integrationDefaults, setIntegrationDefaults] = useState(initialWorkspace.defaults.integrationDefaults ?? "");
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => idsFrom(initialWorkspace.projects));
  const [selectedAgentIds, setSelectedAgentIds] = useState(() => idsFrom(initialWorkspace.agentPool));
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const logoPreview = useMemo(() => (logoFile ? URL.createObjectURL(logoFile) : null), [logoFile]);

  useEffect(() => {
    return () => {
      if (logoPreview) URL.revokeObjectURL(logoPreview);
    };
  }, [logoPreview]);
  const selectedProjectSet = useMemo(() => new Set(selectedProjectIds), [selectedProjectIds]);
  const selectedAgentSet = useMemo(() => new Set(selectedAgentIds), [selectedAgentIds]);
  const activeProjects = projects.filter((project) => !project.archived);
  const archivedSelectedProjects = projects.filter((project) => project.archived && selectedProjectSet.has(project.id));

  function toggleProject(projectId: string) {
    setSelectedProjectIds((current) =>
      current.includes(projectId) ? current.filter((id) => id !== projectId) : [...current, projectId],
    );
  }

  function toggleAgent(agentId: string) {
    setSelectedAgentIds((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );
  }

  function onLogoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) return;
    if (!file.type.startsWith("image/") || !["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"].includes(file.type)) {
      setMessage({ tone: "error", text: "Choose a PNG, JPEG, WebP, GIF, or SVG logo." });
      event.target.value = "";
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setMessage({ tone: "error", text: "Logo must be 2 MB or smaller." });
      event.target.value = "";
      return;
    }
    setLogoFile(file);
    setRemoveLogo(false);
    setMessage(null);
  }

  function validate() {
    const trimmedName = name.trim();
    const nextSlug = slug.trim().toLowerCase();
    if (!trimmedName) return "Workspace name is required.";
    if (trimmedName.length > 200) return "Workspace name must be 200 characters or fewer.";
    if (!slugPattern.test(nextSlug)) {
      return "Slug must use lowercase letters/numbers separated by dot, underscore, or hyphen.";
    }
    if (!WORKSPACE_TYPES.some((item) => item.value === type)) return "Workspace type is invalid.";
    const rawIntegrationDefaults = integrationDefaults.trim();
    if (rawIntegrationDefaults) {
      try {
        const parsed = JSON.parse(rawIntegrationDefaults) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Integration defaults must be a JSON object.";
      } catch {
        return "Integration defaults must be valid JSON.";
      }
    }
    return null;
  }


  async function setArchivedState(archived: boolean) {
    const action = archived ? "archive" : "restore";
    const confirmed = window.confirm(
      archived
        ? "Archive this workspace? It will be hidden from default navigation, but projects, tasks, comments, and history remain available by direct access."
        : "Restore this workspace to default navigation?",
    );
    if (!confirmed) return;

    setArchiveBusy(true);
    setMessage(null);
    try {
      const response = archived
        ? await fetch(`/api/workspaces/${encodeURIComponent(workspace.slug)}`, { method: "DELETE" })
        : await fetch(`/api/workspaces/${encodeURIComponent(workspace.slug)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ archived: false }),
          });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Workspace ${action} failed.`);
      const nextWorkspace = payload.workspace as Workspace;
      setWorkspace(nextWorkspace);
      setMessage({ tone: "ok", text: archived ? "Workspace archived. It is hidden from default navigation but remains directly accessible." : "Workspace restored to default navigation." });
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: (error as Error).message });
    } finally {
      setArchiveBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validate();
    if (validationError) {
      setMessage({ tone: "error", text: validationError });
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const previousSlug = workspace.slug;
      const nextSlug = slug.trim().toLowerCase();
      const response = await fetch(`/api/workspaces/${encodeURIComponent(previousSlug)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: nextSlug,
          type,
          borderColor,
          description,
          projectIds: selectedProjectIds,
          agentIds: selectedAgentIds,
          ...defaults,
          integrationDefaults,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Workspace save failed.");
      let nextWorkspace = payload.workspace as Workspace;

      if (removeLogo) {
        const logoResponse = await fetch(`/api/workspaces/${encodeURIComponent(nextWorkspace.slug)}/logo`, { method: "DELETE" });
        const logoPayload = await logoResponse.json().catch(() => ({}));
        if (!logoResponse.ok) throw new Error(logoPayload.error || "Logo removal failed.");
        if (logoPayload.workspace) nextWorkspace = logoPayload.workspace as Workspace;
      } else if (logoFile) {
        const logoData = new FormData();
        logoData.set("logo", logoFile);
        const logoResponse = await fetch(`/api/workspaces/${encodeURIComponent(nextWorkspace.slug)}/logo`, {
          method: "PUT",
          body: logoData,
        });
        const logoPayload = await logoResponse.json().catch(() => ({}));
        if (!logoResponse.ok) throw new Error(logoPayload.error || "Logo upload failed.");
        if (logoPayload.workspace) nextWorkspace = logoPayload.workspace as Workspace;
      }

      setWorkspace(nextWorkspace);
      setName(nextWorkspace.name);
      setSlug(nextWorkspace.slug);
      setType(nextWorkspace.type);
      setBorderColor(nextWorkspace.borderColor ?? "#2563eb");
      setDescription(nextWorkspace.description ?? "");
      setDefaults(nextWorkspace.defaults);
      setIntegrationDefaults(nextWorkspace.defaults.integrationDefaults ?? "");
      setSelectedProjectIds(idsFrom(nextWorkspace.projects));
      setSelectedAgentIds(idsFrom(nextWorkspace.agentPool));
      setLogoFile(null);
      setRemoveLogo(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
      setMessage({ tone: "ok", text: "Workspace settings saved." });
      if (nextWorkspace.slug !== previousSlug) router.replace(`/workspaces/${nextWorkspace.slug}/settings`);
      router.refresh();
    } catch (error) {
      setMessage({ tone: "error", text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const displayedLogo = logoPreview || (!removeLogo ? workspace.logo?.url : null);

  return (
    <form onSubmit={submit} className="space-y-5">
      {message ? (
        <div
          role="status"
          className={`rounded-card border px-4 py-3 text-body ${
            message.tone === "ok"
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
              : "border-red-500/30 bg-red-500/10 text-red-700"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      <section className={cardClass}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Identity</h2>
            <p className="mt-1 text-caption text-text-muted">Name, URL slug, workspace type, description, and logo.</p>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-bg shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save settings"}
          </button>
        </div>

        <div className="grid gap-card lg:grid-cols-[180px_1fr]">
          <div className="space-y-3">
            <div className="grid h-36 w-36 place-items-center overflow-hidden rounded-3xl border border-line bg-panel-soft text-3xl font-semibold uppercase text-text">
              {displayedLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={displayedLogo} alt={`${workspace.name} logo`} className="h-full w-full object-cover" />
              ) : (
                name.trim().slice(0, 1) || "W"
              )}
            </div>
            <div className="space-y-2">
              <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" onChange={onLogoChange} className="hidden" />
              <button type="button" onClick={() => logoInputRef.current?.click()} disabled={saving} className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-caption font-medium hover:border-accent hover:text-accent disabled:opacity-60">
                Upload logo
              </button>
              {(workspace.logo || logoFile) && !removeLogo ? (
                <button type="button" onClick={() => { setLogoFile(null); setRemoveLogo(true); }} disabled={saving} className="w-full rounded-lg border border-line bg-bg px-3 py-2 text-caption font-medium text-text-muted hover:border-red-500 hover:text-red-600 disabled:opacity-60">
                  Remove logo
                </button>
              ) : null}
              <p className="text-nano text-text-muted">PNG, JPEG, WebP, GIF, or SVG. Max 2 MB. {logoFile ? formatBytes(logoFile.size) : formatBytes(workspace.logo?.sizeBytes)}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="grid gap-card md:grid-cols-2">
              <SettingsField label="Workspace name" hint="Display name shown in workspace lists.">
                <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} className={inputClass} placeholder="Product Team" />
              </SettingsField>
              <SettingsField label="Workspace slug" hint="Lowercase URL slug. Dots, underscores, and hyphens are allowed.">
                <input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} required pattern="[a-z0-9]+([._-][a-z0-9]+)*" className={`${inputClass} font-mono`} placeholder="product-team" />
              </SettingsField>
            </div>
            <div className="grid gap-card md:grid-cols-2">
              <SettingsField label="Workspace type" hint="Used for grouping and filtering workspaces.">
                <select value={type} onChange={(event) => setType(event.target.value)} className={inputClass}>
                  {WORKSPACE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </SettingsField>
              <SettingsField label="Board border colour" hint="Border colour around this workspace's tasks on the unified workspaces board. New workspaces start with a random colour.">
                <input type="color" value={borderColor} onChange={(event) => setBorderColor(event.target.value)} className="h-10 w-20 cursor-pointer rounded-lg border border-line bg-bg p-1" />
              </SettingsField>
            </div>
            <SettingsField label="Description" hint="Optional summary for humans and agents.">
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} className={inputClass} placeholder="What this workspace is for..." />
            </SettingsField>
          </div>
        </div>
      </section>


      <section className={cardClass}>
        <div className="mb-4">
          <h2 className="text-base font-semibold tracking-tight">Workspace defaults</h2>
          <p className="mt-1 text-caption text-text-muted">Optional middle-layer defaults. Projects inherit these only when their matching project setting is blank; otherwise system settings remain the fallback.</p>
        </div>
        <div className="grid gap-card md:grid-cols-2">
          <SettingsField label="Hourly rate" hint="Billing rate for every project in this workspace. A project may override it.">
            <input inputMode="decimal" value={defaults.hourlyRate} onChange={(event) => setDefaults((cur) => ({ ...cur, hourlyRate: event.target.value }))} className={inputClass} placeholder="No rate — billing shows hours only" />
          </SettingsField>
          <SettingsField label="Billing currency" hint="Three-letter code shown on billing totals. Blank uses AUD.">
            <input value={defaults.billingCurrency ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, billingCurrency: event.target.value.toUpperCase() }))} maxLength={3} className={inputClass} placeholder="AUD" />
          </SettingsField>
          <SettingsField label="Default git user (name)" hint="Inherited by projects that leave git author name blank.">
            <input value={defaults.defaultGitUserName ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, defaultGitUserName: event.target.value }))} className={inputClass} placeholder="Inherited from system" />
          </SettingsField>
          <SettingsField label="Default git user (email)" hint="Inherited by projects that leave git author email blank.">
            <input type="email" value={defaults.defaultGitUserEmail ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, defaultGitUserEmail: event.target.value }))} className={inputClass} placeholder="Inherited from system" />
          </SettingsField>
          <SettingsField label="Automatic Archive (days)" hint="Inherited by projects that leave task archive age blank.">
            <input type="number" min={1} max={365} value={defaults.doneTtlDays ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, doneTtlDays: event.target.value === "" ? null : Number(event.target.value) }))} className={inputClass} placeholder="Inherited from system" />
          </SettingsField>
          <SettingsField label="Deployment provider" hint="Provider-agnostic deployment default; blank inherits system/fallback.">
            <input value={defaults.deploymentProvider ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, deploymentProvider: event.target.value }))} className={inputClass} placeholder="bitbucket" />
          </SettingsField>
          <SettingsField label="Production branch" hint="Inherited deployment branch for projects without an override.">
            <input value={defaults.deploymentProductionBranch ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, deploymentProductionBranch: event.target.value }))} className={inputClass} placeholder="main" />
          </SettingsField>
          <SettingsField label="PR target branch" hint="Inherited deployment PR target for projects without an override.">
            <input value={defaults.deploymentPrTargetBranch ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, deploymentPrTargetBranch: event.target.value }))} className={inputClass} placeholder="Production branch" />
          </SettingsField>
          <SettingsField label="Deployment mode" hint="pr-only, script, pipeline, or manual.">
            <input value={defaults.deploymentMode ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, deploymentMode: event.target.value }))} className={inputClass} placeholder="pr-only" />
          </SettingsField>
          <SettingsField label="Deployment host" hint="Inherited deployment host label.">
            <input value={defaults.deploymentHost ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, deploymentHost: event.target.value }))} className={inputClass} placeholder="x1" />
          </SettingsField>
        </div>
        <div className="mt-card grid gap-card md:grid-cols-2">
          <SettingsField label="Bitbucket workspace" hint="Inherited repo workspace override; secrets are not stored here.">
            <input value={defaults.deploymentBitbucketWorkspace ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, deploymentBitbucketWorkspace: event.target.value }))} className={inputClass} />
          </SettingsField>
          <SettingsField label="Bitbucket repo slug" hint="Inherited repo slug override; secrets are not stored here.">
            <input value={defaults.deploymentBitbucketRepoSlug ?? ""} onChange={(event) => setDefaults((cur) => ({ ...cur, deploymentBitbucketRepoSlug: event.target.value }))} className={inputClass} />
          </SettingsField>
        </div>
        <SettingsField label="Integration defaults JSON" hint="Provider-agnostic, non-secret integration config merged below project overrides and above system settings.">
          <textarea value={integrationDefaults} onChange={(event) => setIntegrationDefaults(event.target.value)} rows={6} className={`${inputClass} font-mono`} placeholder={'{\n  "deployment": { "provider": "bitbucket" }\n}'} />
        </SettingsField>
      </section>

      <section className={cardClass}>
        <div className="mb-4">
          <h2 className="text-base font-semibold tracking-tight">Related projects</h2>
          <p className="mt-1 text-caption text-text-muted">Choose the active projects that belong to this workspace.</p>
        </div>
        {projects.length === 0 ? (
          <p className="rounded-card border border-dashed border-line bg-bg p-4 text-body text-text-muted">No projects are available yet.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[...activeProjects, ...archivedSelectedProjects].map((project) => (
              <label key={project.id} className={`flex min-h-16 cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${selectedProjectSet.has(project.id) ? "border-accent bg-accent-soft" : "border-line bg-bg hover:border-accent"}`}>
                <input type="checkbox" checked={selectedProjectSet.has(project.id)} onChange={() => toggleProject(project.id)} className="mt-1" />
                <span className="min-w-0">
                  <span className="block truncate text-body font-semibold text-text">{project.name}</span>
                  <span className="block truncate text-caption text-text-muted">/{project.slug}{project.archived ? " · archived" : ""}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className={cardClass}>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Agent pool</h2>
            <p className="mt-1 text-caption text-text-muted">Restrict workspace work to selected active coding agents. Leave empty to keep the pool intentionally blank.</p>
          </div>
          <span className="rounded-full border border-line bg-bg px-3 py-1 text-caption text-text-muted">
            {selectedAgentIds.length} selected
          </span>
        </div>
        {agents.length === 0 ? (
          <p className="rounded-card border border-dashed border-line bg-bg p-4 text-body text-text-muted">No active coding agents are available.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {agents.map((agent) => (
              <label key={agent.id} className={`flex min-h-16 cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${selectedAgentSet.has(agent.id) ? "border-accent bg-accent-soft" : "border-line bg-bg hover:border-accent"}`}>
                <input type="checkbox" checked={selectedAgentSet.has(agent.id)} onChange={() => toggleAgent(agent.id)} className="mt-1" />
                <span className="min-w-0">
                  <span className="block truncate text-body font-semibold text-text">{agent.name}</span>
                  <span className="block truncate text-caption text-text-muted">@{agent.slug} · {agent.role}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </section>


      <section className={cardClass}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Archive state</h2>
            <p className="mt-1 text-caption text-text-muted">
              Archived workspaces are hidden from the default sidebar and workspace list. Direct URLs, projects, tasks, comments, and history are preserved.
            </p>
            {workspace.archivedAt ? (
              <p className="mt-2 text-caption text-amber-700">Archived {new Date(workspace.archivedAt).toLocaleString()}.</p>
            ) : null}
          </div>
          <button
            type="button"
            disabled={saving || archiveBusy}
            onClick={() => setArchivedState(!workspace.archivedAt)}
            className={`rounded-lg border px-control-x py-control-y text-caption font-medium disabled:cursor-not-allowed disabled:opacity-60 ${workspace.archivedAt ? "border-line bg-bg text-text-muted hover:border-accent hover:text-accent" : "border-amber-500/40 bg-amber-500/10 text-amber-800 hover:border-amber-600"}`}
          >
            {archiveBusy ? "Updating..." : workspace.archivedAt ? "Restore workspace" : "Archive workspace"}
          </button>
        </div>
      </section>

      <div className="sticky bottom-4 z-10 flex justify-end md:static">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-accent px-5 py-3 text-body font-semibold text-bg shadow-lg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? "Saving settings..." : "Save workspace settings"}
        </button>
      </div>
    </form>
  );
}

function SettingsField({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span>
        <span className="block text-caption font-semibold uppercase tracking-wider text-text-muted">{label}</span>
        <span className="block text-caption text-text-muted">{hint}</span>
      </span>
      {children}
    </label>
  );
}
