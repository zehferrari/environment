import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { canEditProfile, readAgentProfile } from "@/lib/agents/profile";
import { readAgentModelSettings } from "@/lib/agents/model-settings";
import { resolveEffectiveAgentConfig } from "@/lib/agents/effective-config";
import ProfileEditor from "./profile-editor";
import AtlasControls from "./atlas-controls";
import AgentTabs from "./agent-tabs";
import ModelsSettings from "./models-settings";

export const dynamic = "force-dynamic";

type SnapshotAgent = {
  name?: string;
  role?: string;
  avatar?: string;
  avatar_url?: string;
  bot?: string;
  gateway_listeners?: number[];
  current_task?: { heading?: string; ticket?: string; status?: string } | null;
  session_idle_s?: number | null;
  model_primary?: string | null;
  busy_state?: { is_busy?: boolean; signals?: string[] } | null;
  jira_tickets?: Array<{ key?: string; summary?: string; status?: string; updated?: string }>;
  last_activity?: string | null;
};

type Snapshot = {
  agents?: Record<string, SnapshotAgent>;
  system?: Record<string, { is_active?: string }>;
};

type RawAgent = {
  telegram?: { bot?: string; enabled?: boolean };
  listeners?: Array<{ owner?: string; host?: string; port?: number; expected?: boolean }>;
};

async function readSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return null;
    return (await res.json()) as Snapshot;
  } catch {
    return null;
  }
}

function parseRaw(raw: string | null): RawAgent {
  if (!raw) return {};
  try { return JSON.parse(raw) as RawAgent; } catch { return {}; }
}

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}`;
}

function localAvatarSrc(agentAvatar: string | null, liveAvatarUrl: string | undefined, name: string) {
  if (liveAvatarUrl?.startsWith("/")) return liveAvatarUrl;
  if (agentAvatar) return avatarUrl(name);
  return null;
}

function statusFor(agent: { deactivatedAt: Date | null; user: { status: string } | null }, live?: SnapshotAgent | null) {
  if (agent.deactivatedAt || agent.user?.status === "deactivated") return "offline";
  if (live?.busy_state?.is_busy) return "active";
  if (live) {
    const idle = live.session_idle_s ?? 999999;
    if (idle < 90) return "active";
    if (idle < 900) return "idle";
    return "stale";
  }
  return agent.user ? "active" : "registered";
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
  const requestedTab = (await searchParams)?.tab === "operations" ? "operations" : "controls";
  const session = await auth();
  const [agent, snapshot] = await Promise.all([
    db.agent.findUnique({ where: { slug }, include: { user: true } }),
    readSnapshot(),
  ]);
  if (!agent) notFound();

  const profile = await readAgentProfile(slug);
  const canEdit = await canEditProfile({ name: session?.user?.name, kind: session?.user?.kind }, slug);
  const [audit, activity, modelSettings] = await Promise.all([
    db.activityLog.findMany({
      where: { kind: "agent.profile.update", targetAgent: slug },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: { username: true } } },
    }),
    db.activityLog.findMany({
      where: { OR: [{ targetAgent: slug }, { userId: agent.user?.id ?? "__none__" }] },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { user: { select: { username: true } }, task: { select: { title: true } } },
    }),
    readAgentModelSettings(slug),
  ]);

  const live = snapshot?.agents?.[slug];
  const raw = parseRaw(agent.rawJson);
  const effective = await resolveEffectiveAgentConfig(agent.rawJson);
  const status = statusFor(agent, live);
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
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href="/agents" className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline">← Agents</Link>
      </nav>

      <header className="rounded-[28px] border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-4">
            <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-3xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] text-3xl font-semibold">
              {avatarSrc ? (
                <img src={avatarSrc} alt={`${agent.name} avatar`} decoding="async" className="h-full w-full object-cover" />
              ) : live?.avatar_url ? (
                <img src={live.avatar_url} alt={`${agent.name} avatar`} className="h-full w-full object-cover" />
              ) : (live?.avatar ?? agent.name.slice(0, 1))}
            </div>
            <div className="min-w-0">
              <p className="font-mono text-xs text-[var(--color-text-muted)]">@{agent.slug}</p>
              <h1 className="truncate text-3xl font-semibold tracking-tight">{agent.name}</h1>
              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">{status}</span>
                <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">{agent.role}</span>
                <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">gateway {(live?.gateway_listeners ?? [agent.gatewayPort]).filter(Boolean).join(", ") || "—"}</span>
                <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">idle {formatIdle(live?.session_idle_s)}</span>
                <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">{agent.user ? `PM user: ${agent.user.username}` : "No PM user"}</span>
              </div>
            </div>
          </div>
          <div className={`rounded-full px-3 py-1 text-xs ${canEdit ? "bg-[var(--color-ok)]/10 text-[var(--color-ok)]" : "bg-[var(--color-warn)]/10 text-[var(--color-warn)]"}`}>
            {canEdit ? "Editable by you" : "Read-only for you"}
          </div>
        </div>
      </header>

      <AgentTabs
        agent={slug}
        activeTab={requestedTab}
        controls={(
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="space-y-4">
              <Panel title="Identity files">
                <ProfileEditor agent={slug} files={profile.files} canEdit={canEdit} />
              </Panel>

              <Panel title="Profile audit history">
                {audit.length === 0 ? (
                  <p className="text-sm text-[var(--color-text-muted)]">No profile edits recorded yet.</p>
                ) : (
                  <ul className="divide-y divide-[var(--color-line)] text-sm">
                    {audit.map((row) => {
                      const payload = row.payload ? JSON.parse(row.payload) as { file?: string; shaBefore?: string; shaAfter?: string; byteDelta?: number; diff?: string } : {};
                      return (
                        <li key={row.id} className="py-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span><strong>{row.user?.username ?? "Someone"}</strong> edited <span className="font-mono">{payload.file ?? row.targetFile}</span></span>
                            <time className="text-xs text-[var(--color-text-muted)]" dateTime={row.createdAt.toISOString()}>{row.createdAt.toISOString().slice(0, 19).replace("T", " ")}</time>
                          </div>
                          <div className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">{payload.shaBefore?.slice(0, 8)} → {payload.shaAfter?.slice(0, 8)} · Δ {payload.byteDelta ?? 0} bytes</div>
                          {payload.diff ? <details className="mt-2"><summary className="cursor-pointer text-xs text-[var(--color-accent)]">View diff</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--color-bg)] p-3 text-xs">{payload.diff}</pre></details> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Panel>
            </div>

            <aside className="space-y-4">
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
        operations={(
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <Panel title="Models Settings">
                <ModelsSettings agent={slug} canEdit={canEdit} settings={modelSettings} liveModel={live?.model_primary} />
              </Panel>
            </div>

            <div className="space-y-4">
              <Panel title="Open tickets">
                {tickets.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">No open assigned tickets.</p> : (
                  <ul className="space-y-2 text-sm">
                    {tickets.map((t) => <li key={t.key} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] p-2"><div className="font-mono text-xs text-[var(--color-text-muted)]">{t.key}</div><div className="font-medium">{t.summary}</div><div className="text-xs text-[var(--color-text-muted)]">{t.status}</div></li>)}
                  </ul>
                )}
              </Panel>

              <Panel title="Current task">
                {live?.current_task ? (
                  <div className="space-y-1 text-sm">
                    <div className="font-semibold">{live.current_task.ticket ?? live.current_task.heading}</div>
                    <div className="text-[var(--color-text-muted)]">{live.current_task.heading}</div>
                    <div className="text-xs text-[var(--color-text-muted)]">status: {live.current_task.status ?? "—"}</div>
                  </div>
                ) : <p className="text-sm text-[var(--color-text-muted)]">No active task pinned.</p>}
              </Panel>

              <Panel title="Lifecycle">
                <div className="grid gap-2 text-sm">
                  {services.length === 0 ? <p className="text-[var(--color-text-muted)]">No live agent services reported.</p> : services.map(([name, svc]) => <div key={name} className="flex justify-between gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2"><code className="truncate text-xs">{name.replace(`${slug}/`, "")}</code><span className={svc.is_active === "active" ? "text-[var(--color-ok)]" : "text-[var(--color-crit)]"}>{svc.is_active ?? "unknown"}</span></div>)}
                </div>
              </Panel>

              <Panel title="Listeners">
                <ChipGrid items={[raw.telegram?.enabled ? `telegram: ${raw.telegram.bot ?? "enabled"}` : null, ...listeners.map((l) => `${l.owner ?? "listener"}: ${l.host ?? "?"}:${l.port ?? "?"}`)].filter(Boolean) as string[]} empty="No listeners reported." />
              </Panel>

              <Panel title="Activity">
                {activity.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">No activity recorded.</p> : (
                  <ul className="divide-y divide-[var(--color-line)] text-sm">
                    {activity.map((row) => <li key={row.id} className="py-2"><div className="font-medium">{row.kind}</div><div className="text-xs text-[var(--color-text-muted)]">{row.createdAt.toISOString().slice(0,19).replace("T", " ")}{row.task ? ` · ${row.task.title}` : ""}</div></li>)}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
        )}
      />
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm"><h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h2>{children}</section>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="mb-3"><div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div><div className="break-words text-sm font-medium">{value}</div></div>;
}

function ChipGrid({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">{empty}</p>;
  return <div className="flex flex-wrap gap-2 text-xs">{items.map((item) => <span key={item} className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-2 py-1">{item}</span>)}</div>;
}
