"use client";

import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type Workspace = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  archivedAt: string | null;
  logo: { url: string; mimeType: string | null; sizeBytes: number | null; updatedAt: string | null } | null;
  projects: { id: string; slug: string; name: string; archivedAt: string | null; deletedAt: string | null }[];
  agentPool: { id: string; slug: string; name: string; role: string; deactivatedAt: string | null }[];
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
  const [description, setDescription] = useState(initialWorkspace.description ?? "");
  const [selectedProjectIds, setSelectedProjectIds] = useState(() => idsFrom(initialWorkspace.projects));
  const [selectedAgentIds, setSelectedAgentIds] = useState(() => idsFrom(initialWorkspace.agentPool));
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const logoPreview = useMemo(() => (logoFile ? URL.createObjectURL(logoFile) : null), [logoFile]);
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
    return null;
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
          description,
          projectIds: selectedProjectIds,
          agentIds: selectedAgentIds,
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
        const logoResponse = await fetch(`/api/workspaces/${encodeURIComponent(nextWorkspace.slug)}/logo`, {
          method: "PUT",
          headers: { "Content-Type": logoFile.type },
          body: logoFile,
        });
        const logoPayload = await logoResponse.json().catch(() => ({}));
        if (!logoResponse.ok) throw new Error(logoPayload.error || "Logo upload failed.");
        if (logoPayload.workspace) nextWorkspace = logoPayload.workspace as Workspace;
      }

      setWorkspace(nextWorkspace);
      setName(nextWorkspace.name);
      setSlug(nextWorkspace.slug);
      setType(nextWorkspace.type);
      setDescription(nextWorkspace.description ?? "");
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
            className="rounded-lg bg-accent px-control-x py-control-y text-body font-semibold text-white shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
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
                <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} className={inputClass} placeholder="Environment" />
              </SettingsField>
              <SettingsField label="Workspace slug" hint="Lowercase URL slug. Dots, underscores, and hyphens are allowed.">
                <input value={slug} onChange={(event) => setSlug(event.target.value.toLowerCase())} required pattern="[a-z0-9]+([._-][a-z0-9]+)*" className={`${inputClass} font-mono`} placeholder="environment" />
              </SettingsField>
            </div>
            <SettingsField label="Workspace type" hint="Used for grouping and filtering workspaces.">
              <select value={type} onChange={(event) => setType(event.target.value)} className={inputClass}>
                {WORKSPACE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </SettingsField>
            <SettingsField label="Description" hint="Optional summary for humans and agents.">
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={4} className={inputClass} placeholder="What this workspace is for..." />
            </SettingsField>
          </div>
        </div>
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

      <div className="sticky bottom-4 z-10 flex justify-end md:static">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-accent px-5 py-3 text-body font-semibold text-white shadow-lg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
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
