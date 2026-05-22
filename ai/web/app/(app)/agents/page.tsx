import Link from "next/link";
import { db } from "@/lib/db";

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
  ts?: number;
  host?: string;
  agents?: Record<string, SnapshotAgent>;
  system?: Record<string, { is_active?: string }>;
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

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}`;
}

function statusFor(agent: { deactivatedAt: Date | null; user: { status: string } | null }, live?: SnapshotAgent | null) {
  if (agent.deactivatedAt || agent.user?.status === "deactivated") return "offline";
  if (live?.busy_state?.is_busy) return "busy";
  if (live) {
    const idle = live.session_idle_s ?? 999999;
    if (idle < 90) return "live";
    if (idle < 900) return "idle";
    return "stale";
  }
  return agent.user ? "live" : "registered";
}

function ringFor(status: string) {
  if (status === "busy") return { ring: "#22c55e", bg: "rgba(34,197,94,0.16)", label: "busy" };
  if (status === "live") return { ring: "#2dd4bf", bg: "rgba(45,212,191,0.16)", label: "live" };
  if (status === "idle") return { ring: "#f59e0b", bg: "rgba(245,158,11,0.16)", label: "idle" };
  if (status === "stale") return { ring: "#64748b", bg: "rgba(100,116,139,0.16)", label: "stale" };
  if (status === "offline") return { ring: "#ef4444", bg: "rgba(239,68,68,0.16)", label: "offline" };
  return { ring: "#94a3b8", bg: "rgba(148,163,184,0.16)", label: status };
}

function accentFor(slug: string) {
  if (slug === "barekbaal") return "#0a7c66";
  if (slug === "asdrubal") return "#4f63ff";
  if (slug === "karen") return "#b34dd2";
  return "#6b7280";
}

function formatIdle(seconds?: number | null) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export default async function AgentsPage() {
  const [agents, recentActivity, snapshot] = await Promise.all([
    db.agent.findMany({
      orderBy: { slug: "asc" },
      include: {
        user: {
          include: {
            assignedTasks: {
              where: { status: { not: "Done" } },
              orderBy: { updatedAt: "desc" },
              take: 5,
              include: { project: { select: { slug: true, name: true } } },
            },
          },
        },
      },
    }),
    db.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { user: { select: { username: true } }, task: { select: { title: true } } },
    }),
    readSnapshot(),
  ]);

  const liveAgents = snapshot?.agents ?? {};
  const active = agents.filter((a) => ["busy", "live"].includes(statusFor(a, liveAgents[a.slug]))).length;
  const openTickets = agents.reduce((sum, a) => sum + (liveAgents[a.slug]?.jira_tickets?.length ?? 0), 0);
  const openTasks = agents.reduce((sum, a) => sum + (a.user?.assignedTasks.length ?? 0), 0);
  const system = snapshot?.system ?? {};
  const activeServices = Object.values(system).filter((s) => s.is_active === "active").length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
        </div>
        <Link
          href="/system/activity"
          className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          System activity →
        </Link>
      </div>

      <section className="grid gap-3 md:grid-cols-5">
        <Kpi label="Agents online" value={`${active}`} foot={`/ ${agents.length} registered`} />
        <Kpi label="Open tickets" value={`${openTickets}`} foot="From live Atlas snapshot" />
        <Kpi label="Open PM tasks" value={`${openTasks}`} foot="Assigned and not Done" />
        <Kpi label="Host services" value={`${activeServices}`} foot={`/ ${Object.keys(system).length || 0} active`} />
        <Kpi label="Activity stream" value={`${recentActivity.length}`} foot="Latest PM events" />
      </section>

      {agents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-4 text-sm text-[var(--color-text-muted)]">
          No agents have been synced yet. Trigger {`/api/debug/sync`} or wait for the next cycle.
        </p>
      ) : (
        <section className="grid gap-4 xl:grid-cols-3">
          {agents.map((a) => {
            const live = liveAgents[a.slug];
            const status = statusFor(a, live);
            const ring = ringFor(status);
            const liveTask = live?.current_task ?? null;
            const pmTask = a.user?.assignedTasks.find((t) => t.status === "In Progress") ?? a.user?.assignedTasks[0] ?? null;
            const tickets = live?.jira_tickets ?? [];
            return (
              <Link
                key={a.id}
                href={`/agents/${a.slug}`}
                className="group relative overflow-hidden rounded-[28px] border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--color-accent)] hover:shadow-md"
                style={{ "--agent-hue": accentFor(a.slug) } as React.CSSProperties}
              >
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,color-mix(in_srgb,var(--agent-hue)_18%,transparent),transparent_45%)]" />
                <div className="relative flex items-start gap-4">
                  <div className="relative shrink-0">
                    <div className="absolute -inset-1.5 rounded-[24px]" style={{ border: `3px solid ${ring.ring}`, background: ring.bg, boxShadow: `0 0 0 4px ${ring.bg}` }} aria-hidden="true" />
                    <div className="relative grid h-16 w-16 place-items-center overflow-hidden rounded-2xl border bg-[var(--color-panel-soft)] text-2xl font-semibold" style={{ borderColor: "color-mix(in srgb, var(--agent-hue) 45%, var(--color-line))" }}>
                      {a.avatar || live?.avatar_url ? <img src={live?.avatar_url ?? avatarUrl(a.name)} alt={`${a.name} avatar`} className="h-full w-full object-cover" /> : (live?.avatar ?? a.name.slice(0, 1))}
                    </div>
                    <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: ring.ring }}>{ring.label}</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-xl font-semibold tracking-tight">{a.name}</h2>
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ring.ring }} />
                    </div>
                    <p className="font-mono text-xs text-[var(--color-text-muted)]">@{a.slug} · {a.role}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">{status}</span>
                      <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">idle {formatIdle(live?.session_idle_s)}</span>
                      <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">port {(live?.gateway_listeners ?? [a.gatewayPort]).filter(Boolean).join(", ") || "—"}</span>
                      <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">{tickets.length} tickets</span>
                    </div>
                  </div>
                </div>

                <div className="relative mt-5 grid gap-3 text-sm">
                  <Metric label="Current task" value={liveTask?.heading ?? pmTask?.title ?? "No active task pinned"} />
                  <Metric label="Ticket/status" value={liveTask?.ticket ? `${liveTask.ticket} · ${liveTask.status ?? "—"}` : pmTask ? `${pmTask.project.slug} · ${pmTask.status}` : "—"} />
                  <Metric label="Busy/model" value={`${live?.busy_state?.is_busy ? "busy" : "available"} · ${live?.model_primary ?? "model unknown"}`} />
                  <Metric label="Tickets open" value={tickets.length ? tickets.map((t) => `${t.key} ${t.status ?? ""}`).join(" · ") : "No open assigned tickets"} />
                  <Metric label="PM user" value={a.user ? `${a.user.username} · ${a.user.status}` : "not seeded"} />
                </div>

                <div className="relative mt-4 text-xs font-medium text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)]">
                  Open mission deck + profile editor →
                </div>
              </Link>
            );
          })}
        </section>
      )}

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
          <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Activity stream</h2>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">No activity recorded yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-line)] text-sm">
              {recentActivity.map((row) => (
                <li key={row.id} className="py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span><strong>{row.kind}</strong>{row.task ? ` · ${row.task.title}` : row.targetAgent ? ` · ${row.targetAgent}` : ""}</span>
                    <time className="shrink-0 text-xs text-[var(--color-text-muted)]" dateTime={row.createdAt.toISOString()}>{row.createdAt.toISOString().slice(0, 19).replace("T", " ")}</time>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)]">{row.user?.username ?? "system"}{row.targetFile ? ` · ${row.targetFile}` : ""}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
          <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Host services</h2>
          {Object.keys(system).length === 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">No service status reported by the Atlas snapshot feed.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(system).map(([name, svc]) => {
                const ok = svc.is_active === "active";
                return (
                  <div key={name} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <code className="truncate text-xs">{name}</code>
                      <span className={ok ? "text-[var(--color-ok)]" : "text-[var(--color-crit)]"}>{svc.is_active ?? "unknown"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-3 text-4xl font-semibold tracking-tight">{value}</div>
      <div className="mt-2 text-xs text-[var(--color-text-muted)]">{foot}</div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className="truncate font-medium" title={value}>{value}</div>
    </div>
  );
}
