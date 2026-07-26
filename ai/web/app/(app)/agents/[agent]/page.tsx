import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { isOwnerUserId } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { canEditProfile, ProfileError, readAgentProfile } from "@/lib/agents/management/profile";
import { readAgentModelSettings } from "@/lib/agents/management/model-settings";
import { resolveEffectiveAgentConfig } from "@/lib/agents/management/effective-config";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  type MessageActor,
} from "@/components/message-avatar";
import AgentAvatar from "@/components/agent-avatar";
import { readAtlasSnapshot } from "@/lib/atlas-snapshot";
import { agentStatusFor } from "@/lib/agents/presence";
import ProfileEditor from "./profile-editor";
import AtlasControls from "./atlas-controls";
import AgentTabs, { type AgentTab } from "./agent-tabs";
import ModelsSettings from "./models-settings";
import AgentImagesPanel from "./agent-images-panel";
import AgentDangerZone from "./agent-danger-zone";
import { readAgentImagesState } from "@/lib/agents/management/profile-images";
import { summarizeAgentDeletion } from "@/lib/agents/management/deletion-summary";
import { getSystemSettings } from "@/lib/settings/system";
import { isProtectedAgentUsername } from "@/lib/agents/management/protected-usernames";

export const dynamic = "force-dynamic";

type RawAgent = {
  telegram?: { bot?: string; enabled?: boolean };
  listeners?: Array<{ owner?: string; host?: string; port?: number; expected?: boolean }>;
};

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

type ActivityActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
};

const systemActor: MessageActor = {
  id: null,
  username: "system",
  kind: "system",
  name: "System",
  avatarUpdatedAt: null,
  agent: null,
};

function serializeActivityActor(actor: ActivityActorRow | null): MessageActor | null {
  if (!actor) return null;
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind,
    name: actor.name,
    avatarUpdatedAt: actor.avatarUpdatedAt,
    agent: actor.agent,
  };
}

function parseRaw(raw: string | null): RawAgent {
  if (!raw) return {};
  try { return JSON.parse(raw) as RawAgent; } catch { return {}; }
}

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}?v=agent-image-v2`;
}

function localAvatarSrc(agentAvatar: string | null, liveAvatarUrl: string | undefined, name: string) {
  if (liveAvatarUrl?.startsWith("/")) return liveAvatarUrl;
  if (agentAvatar) return avatarUrl(name);
  return null;
}

async function readProfileForPage(slug: string) {
  try {
    return { profile: await readAgentProfile(slug), error: null };
  } catch (err) {
    if (err instanceof ProfileError) return { profile: null, error: err.message };
    if (err instanceof Error) return { profile: null, error: err.message };
    return { profile: null, error: String(err) };
  }
}

function formatIdle(seconds?: number | null) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default async function AgentProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ agent: string }>;
  searchParams?: Promise<{ tab?: string }>;
}) {
  const { agent: slug } = await params;
  const tabParam = (await searchParams)?.tab;
  const requestedTab: AgentTab =
    tabParam === "images" ? "images" : tabParam === "operations" ? "operations" : "controls";
  const session = await auth();
  const [agent, snapshot, allAgents] = await Promise.all([
    db.agent.findUnique({ where: { slug }, include: { user: true } }),
    readAtlasSnapshot(),
    db.agent.findMany({ select: { rawJson: true } }),
  ]);
  if (!agent) notFound();

  const [profileResult, imageState, settings] = await Promise.all([
    readProfileForPage(slug),
    readAgentImagesState(slug),
    getSystemSettings(),
  ]);
  const canEdit = await canEditProfile({ name: session?.user?.name, kind: session?.user?.kind }, slug);
  // Deletion is admin-only (matches the /api/agents/remove guard) and never
  // offered for protected accounts.
  const canRemove = await isOwnerUserId(session?.user?.id) && !isProtectedAgentUsername(slug);
  const deletionSummary = canRemove ? await summarizeAgentDeletion(slug) : null;
  const [audit, activity, modelSettings] = await Promise.all([
    db.activityLog.findMany({
      where: { kind: "agent.profile.update", targetAgent: slug },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: actorSelect } },
    }),
    db.activityLog.findMany({
      where: agent.user?.id
        ? { userId: agent.user.id }
        // No PM user yet: fall back to what was done *to* the agent so the
        // panel still says something rather than rendering empty.
        : { targetAgent: slug },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: actorSelect }, task: { select: { title: true } } },
    }),
    readAgentModelSettings(slug),
  ]);

  const live = snapshot?.agents?.[slug];
  const raw = parseRaw(agent.rawJson);
  const effective = await resolveEffectiveAgentConfig(agent.rawJson, allAgents.map(a => a.rawJson));
  const status = agentStatusFor(agent, live);
  const tickets = live?.jira_tickets ?? [];
  const listeners = raw.listeners ?? [];
  const rawServices = effective.services;
  const services = Object.entries(snapshot?.system ?? {}).filter(([name]) => name.startsWith(`${slug}/`));
  const serviceNames = Array.from(new Set([...rawServices, ...services.map(([name]) => name.replace(`${slug}/`, ""))]));
  const controlServices = serviceNames.map((name) => ({
    name,
    status: snapshot?.system?.[`${slug}/${name}`]?.is_active ?? snapshot?.system?.[name]?.is_active,
  }));
  const avatarSrc = localAvatarSrc(agent.avatar, live?.avatar_url, agent.name);

  return (
    <div className="@container/agent space-y-6">
      <nav className="text-body">
        <Link href="/agents" className="text-text-muted hover:text-text hover:underline">← Agents</Link>
      </nav>

      {/* Profile/settings on the left (header included), the agent's own
          latest activity pinned to the right and starting at the very top.
          The 1fr / 0.5fr ratio is what turns the ultra-wide /agents pane into
          the requested 0.5fr | 1fr | 0.5fr split: the hub's cards take the
          outer 0.5fr and this grid supplies the rest. */}
      <div className="grid gap-card @min-[64rem]/agent:grid-cols-[minmax(0,1fr)_minmax(0,0.5fr)] @min-[64rem]/agent:items-start">
        <div className="@container/agent-main min-w-0 space-y-6">
      <header className="rounded-hero border border-line bg-panel p-card-lg shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-card">
          <div className="flex min-w-0 items-start gap-card">
            <AgentAvatar
              slug={agent.slug}
              name={agent.name}
              src={avatarSrc ?? live?.avatar_url ?? null}
              sizeClass="h-20 w-20"
              roundedClass="rounded-3xl"
              initialStatus={status}
              fallback={live?.avatar ?? agent.name.slice(0, 1)}
            />
            <div className="min-w-0">
              <p className="font-mono text-caption text-text-muted">@{agent.slug}</p>
              <h1 className="truncate text-3xl font-semibold tracking-tight">{agent.name}</h1>
              <div className="mt-2 flex flex-wrap gap-2 text-caption">
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">{status}</span>
                <span className="rounded-full border border-line px-2 py-0.5">{agent.role}</span>
                <span className="rounded-full border border-line px-2 py-0.5">gateway {(live?.gateway_listeners ?? [agent.gatewayPort]).filter(Boolean).join(", ") || "—"}</span>
                <span className="rounded-full border border-line px-2 py-0.5">idle {formatIdle(live?.session_idle_s)}</span>
                <span className="rounded-full border border-line px-2 py-0.5">{agent.user ? `PM user: ${agent.user.username}` : "No PM user"}</span>
              </div>
            </div>
          </div>
          <div className={`rounded-full px-3 py-1 text-caption ${canEdit ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"}`}>
            {canEdit ? "Editable by you" : "Read-only for you"}
          </div>
        </div>
      </header>

      <AgentTabs
        agent={slug}
        activeTab={requestedTab}
        controls={(
          <div className="grid gap-card @min-[46rem]/agent-main:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-section-gap">
              <Panel title="Identity files">
                {profileResult.profile ? (
                  <ProfileEditor agent={slug} files={profileResult.profile.files} canEdit={canEdit} />
                ) : (
                  <ProfileUnavailable agent={slug} error={profileResult.error} />
                )}
              </Panel>

              <Panel title="Profile audit history">
                {audit.length === 0 ? (
                  <p className="text-body text-text-muted">No profile edits recorded yet.</p>
                ) : (
                  <ul className="divide-y divide-line text-body">
                    {audit.map((row) => {
                      const payload = row.payload ? JSON.parse(row.payload) as { file?: string; shaBefore?: string; shaAfter?: string; byteDelta?: number; diff?: string } : {};
                      const actor = serializeActivityActor(row.user) ?? systemActor;
                      return (
                        <li key={row.id} className="py-3">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <MessageTimestamp value={row.createdAt} />
                            <MessageAvatar actor={actor} size="sm" />
                            <span className="min-w-0">
                              <strong>{actorDisplayName(actor)}</strong> edited <span className="font-mono">{payload.file ?? row.targetFile}</span>
                            </span>
                          </div>
                          <div className="mt-1 font-mono text-caption text-text-muted">{payload.shaBefore?.slice(0, 8)} → {payload.shaAfter?.slice(0, 8)} · Δ {payload.byteDelta ?? 0} bytes</div>
                          {payload.diff ? <details className="mt-2"><summary className="cursor-pointer text-caption text-accent">View diff</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-3 text-caption">{payload.diff}</pre></details> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </div>

            <aside className="space-y-section-gap">
              <AtlasControls
                agent={slug}
                canEdit={canEdit}
                integrations={effective.integrations}
                capabilities={effective.capabilities}
                services={controlServices}
              />
            </aside>
          </div>
        )}
        images={(
          <Panel title="Profile images">
            <AgentImagesPanel agent={slug} state={imageState} canEdit={canEdit} defaultPrompt={settings.profileImagePrompt} />
          </Panel>
        )}
        operations={(
          <div className="grid gap-card @min-[46rem]/agent-main:grid-cols-2">
            <div className="space-y-section-gap">
              <Panel title="Models Settings">
                <ModelsSettings agent={slug} canEdit={canEdit} settings={modelSettings} liveModel={live?.model_primary} />
              </Panel>
              {canRemove && deletionSummary ? (
                <AgentDangerZone agent={slug} name={agent.name} summary={deletionSummary} />
              ) : null}
            </div>

            <div className="space-y-section-gap">
              <Panel title="Open tickets">
                {tickets.length === 0 ? <p className="text-body text-text-muted">No open assigned tickets.</p> : (
                  <ul className="space-y-2 text-body">
                    {tickets.map((t) => <li key={t.key} className="rounded-card border border-line bg-panel-soft p-2"><div className="font-mono text-caption text-text-muted">{t.key}</div><div className="font-medium">{t.summary}</div><div className="text-caption text-text-muted">{t.status}</div></li>)}
                  </ul>
                )}
              </Panel>

              <Panel title="Current task">
                {live?.current_task ? (
                  <div className="space-y-1 text-body">
                    <div className="font-semibold">{live.current_task.ticket ?? live.current_task.heading}</div>
                    <div className="text-text-muted">{live.current_task.heading}</div>
                    <div className="text-caption text-text-muted">status: {live.current_task.status ?? "—"}</div>
                  </div>
                ) : <p className="text-body text-text-muted">No active task pinned.</p>}
              </Panel>

              <Panel title="Lifecycle">
                <div className="grid gap-2 text-body">
                  {services.length === 0 ? <p className="text-text-muted">No live agent services reported.</p> : services.map(([name, svc]) => <div key={name} className="flex justify-between gap-3 rounded-card border border-line bg-panel-soft px-3 py-2"><code className="truncate text-caption">{name.replace(`${slug}/`, "")}</code><span className={svc.is_active === "active" ? "text-ok" : "text-crit"}>{svc.is_active ?? "unknown"}</span></div>)}
                </div>
              </Panel>

              <Panel title="Listeners">
                <ChipGrid items={[raw.telegram?.enabled ? `telegram: ${raw.telegram.bot ?? "enabled"}` : null, ...listeners.map((l) => `${l.owner ?? "listener"}: ${l.host ?? "?"}:${l.port ?? "?"}`)].filter(Boolean) as string[]} empty="No listeners reported." />
              </Panel>
            </div>
          </div>
        )}
      />
        </div>

        <aside
          data-agent-activity
          className="min-w-0 @min-[64rem]/agent:sticky @min-[64rem]/agent:top-4"
        >
          <Panel title="Last activities">
            {activity.length === 0 ? <p className="text-body text-text-muted">No activity recorded.</p> : (
              <ul className="divide-y divide-line text-body">
                {activity.map((row) => {
                  const actor = serializeActivityActor(row.user) ?? systemActor;
                  return (
                    <li key={row.id} className="py-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <MessageTimestamp value={row.createdAt} />
                        <MessageAvatar actor={actor} size="sm" />
                        <span className="font-medium">{row.kind}</span>
                      </div>
                      <div className="mt-1 text-caption text-text-muted">
                        {actorDisplayName(actor)}
                        {row.task ? ` · ${row.task.title}` : ""}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-panel border border-line bg-panel p-card shadow-sm"><h2 className="mb-3 text-caption uppercase tracking-wider text-text-muted">{title}</h2>{children}</section>;
}

function ProfileUnavailable({ agent, error }: { agent: string; error: string | null }) {
  return (
    <div className="rounded-card border border-warn/40 bg-warn/10 p-3 text-body text-warn">
      <div className="font-medium">Profile files are not readable by PM.</div>
      <p className="mt-1 text-caption">
        Check read/traverse permissions for <code>/srv/agents/openclaw/{agent}</code>.
        {error ? ` ${error}` : ""}
      </p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="mb-3"><div className="text-micro uppercase tracking-wider text-text-muted">{label}</div><div className="break-words text-body font-medium">{value}</div></div>;
}

function ChipGrid({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-body text-text-muted">{empty}</p>;
  return <div className="flex flex-wrap gap-2 text-caption">{items.map((item) => <span key={item} className="rounded-full border border-line bg-panel-soft px-2 py-1">{item}</span>)}</div>;
}
