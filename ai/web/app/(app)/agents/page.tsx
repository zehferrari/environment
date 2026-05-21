import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}`;
}

function statusFor(agent: { deactivatedAt: Date | null; user: { status: string } | null }) {
  if (agent.deactivatedAt || agent.user?.status === "deactivated") return "offline";
  return agent.user ? "active" : "registered";
}

function accentFor(slug: string) {
  if (slug === "barekbaal") return "#0a7c66";
  if (slug === "asdrubal") return "#4f63ff";
  if (slug === "karen") return "#b34dd2";
  return "#6b7280";
}

export default async function AgentsPage() {
  const [agents, recentActivity] = await Promise.all([
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
      take: 8,
      include: { user: { select: { username: true } }, task: { select: { title: true } } },
    }),
  ]);

  const active = agents.filter((a) => statusFor(a) === "active").length;
  const openTasks = agents.reduce((sum, a) => sum + (a.user?.assignedTasks.length ?? 0), 0);
  const profileEdits = recentActivity.filter((a) => a.kind === "agent.profile.update").length;

  return (
    <div className="space-y-6">
      <header className="overflow-hidden rounded-[28px] border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-text-muted)]">Atlas v2 · agents-barekbaal inspired</p>
            <h1 className="mt-2 text-5xl font-semibold tracking-[-0.045em]">Live operations.</h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
              Agent status, avatars, active PM tasks, open tickets, profile editing, and recent operational activity in one routed PM module.
            </p>
          </div>
          <Link
            href="/system/activity"
            className="rounded-xl border border-[var(--color-line)] bg-[var(--color-panel-soft)] px-4 py-2 text-sm font-medium text-[var(--color-text-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            System activity →
          </Link>
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        <Kpi label="Agents online" value={`${active}`} foot={`/ ${agents.length} registered`} />
        <Kpi label="Open PM tasks" value={`${openTasks}`} foot="Assigned and not Done" />
        <Kpi label="Profile audits" value={`${profileEdits}`} foot="Recent profile edits" />
        <Kpi label="Activity stream" value={`${recentActivity.length}`} foot="Latest PM events" />
      </section>

      {agents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-4 text-sm text-[var(--color-text-muted)]">
          No agents have been synced yet. Trigger {`/api/debug/sync`} or wait for the next cycle.
        </p>
      ) : (
        <section className="grid gap-4 xl:grid-cols-3">
          {agents.map((a) => {
            const status = statusFor(a);
            const currentTask = a.user?.assignedTasks.find((t) => t.status === "In Progress") ?? a.user?.assignedTasks[0] ?? null;
            return (
              <Link
                key={a.id}
                href={`/agents/${a.slug}`}
                className="group relative overflow-hidden rounded-[28px] border border-[var(--color-line)] bg-[var(--color-panel)] p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--color-accent)] hover:shadow-md"
                style={{ "--agent-hue": accentFor(a.slug) } as React.CSSProperties}
              >
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,color-mix(in_srgb,var(--agent-hue)_18%,transparent),transparent_45%)]" />
                <div className="relative flex items-start gap-4">
                  <div className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border bg-[var(--color-panel-soft)] text-2xl font-semibold" style={{ borderColor: "color-mix(in srgb, var(--agent-hue) 45%, var(--color-line))" }}>
                    {a.avatar ? <img src={avatarUrl(a.name)} alt="" className="h-full w-full object-cover" /> : a.name.slice(0, 1)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-xl font-semibold tracking-tight">{a.name}</h2>
                      <span className={`h-2.5 w-2.5 rounded-full ${status === "active" ? "bg-[var(--color-ok)]" : status === "offline" ? "bg-[var(--color-crit)]" : "bg-[var(--color-warn)]"}`} />
                    </div>
                    <p className="font-mono text-xs text-[var(--color-text-muted)]">@{a.slug} · {a.role}</p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">{status}</span>
                      <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">port {a.gatewayPort ?? "—"}</span>
                      <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">{a.user?.assignedTasks.length ?? 0} open tasks</span>
                    </div>
                  </div>
                </div>

                <div className="relative mt-5 grid gap-3 text-sm">
                  <Metric label="Current task" value={currentTask?.title ?? "No active task pinned"} />
                  <Metric label="Ticket/status" value={currentTask ? `${currentTask.project.slug} · ${currentTask.status}` : "—"} />
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
          <p className="text-sm leading-6 text-[var(--color-text-muted)]">
            The dedicated system activity page is the right place for service health, stream events, and server-side operational state. This slice links it from Agents; the next pass can wire live service data from the existing Atlas snapshot feed instead of duplicating it in each agent card.
          </p>
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
