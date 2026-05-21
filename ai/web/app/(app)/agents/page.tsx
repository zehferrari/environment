import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const agents = await db.agent.findMany({
    orderBy: { slug: "asc" },
    include: { user: true },
  });

  const active = agents.filter((a) => !a.deactivatedAt).length;
  const withUsers = agents.filter((a) => a.user).length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-muted)]">Atlas v2</p>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
            Live PM view of local OpenClaw agents plus the HOMELAB-52 profile editor entry point.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1">{agents.length} registered</span>
          <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1 text-[var(--color-ok)]">{active} active</span>
          <span className="rounded-full border border-[var(--color-line)] bg-[var(--color-panel)] px-3 py-1">{withUsers} login users</span>
        </div>
      </header>

      {agents.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[var(--color-line)] p-4 text-sm text-[var(--color-text-muted)]">
          No agents have been synced yet. Trigger {`/api/debug/sync`} or wait for the next cycle.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((a) => (
            <Link
              key={a.id}
              href={`/agents/${a.slug}`}
              className="group rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm transition hover:border-[var(--color-accent)]"
            >
              <div className="flex items-start gap-3">
                <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-[var(--color-accent)] bg-[var(--color-panel-soft)] text-lg font-semibold">
                  {a.avatar ? <img src={`/agents/avatars/${encodeURIComponent(a.name.split(" ")[0] || a.slug)}`} alt="" className="h-full w-full object-cover" /> : a.name.slice(0, 1)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold">{a.name}</h2>
                    <span className={`h-2 w-2 rounded-full ${a.deactivatedAt ? "bg-[var(--color-crit)]" : "bg-[var(--color-ok)]"}`} />
                  </div>
                  <p className="font-mono text-xs text-[var(--color-text-muted)]">@{a.slug}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 text-[var(--color-accent)]">{a.role}</span>
                    <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">port {a.gatewayPort ?? "—"}</span>
                    <span className="rounded-full border border-[var(--color-line)] px-2 py-0.5">{a.user ? "user linked" : "no user"}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 text-xs text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)]">
                Open profile editor →
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
