import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SystemActivityPage() {
  const [events, agentSync] = await Promise.all([
    db.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
      include: { user: { select: { username: true } }, task: { select: { title: true } }, project: { select: { slug: true } } },
    }),
    db.activityLog.findFirst({ where: { kind: "agent.sync" }, orderBy: { createdAt: "desc" } }),
  ]);

  return (
    <div className="space-y-6">
      <header className="rounded-[28px] border border-[var(--color-line)] bg-[var(--color-panel)] p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.28em] text-[var(--color-text-muted)]">System</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Activity stream.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)]">
          PM/server activity audit trail. Service-status wiring belongs here as the Atlas snapshot feed is ported into routed PM APIs.
        </p>
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        <Tile label="Events" value={String(events.length)} foot="Most recent rows" />
        <Tile label="Last agent sync" value={agentSync ? agentSync.createdAt.toISOString().slice(11, 19) : "—"} foot={agentSync ? agentSync.createdAt.toISOString().slice(0, 10) : "No sync rows"} />
        <Tile label="Service status" value="Next" foot="Wire Atlas snapshot feed" />
      </section>

      <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-[var(--color-text-muted)]">Recent events</h2>
        {events.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No activity recorded yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-line)] text-sm">
            {events.map((row) => (
              <li key={row.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="font-medium">{row.kind}</span>
                  <time className="text-xs text-[var(--color-text-muted)]" dateTime={row.createdAt.toISOString()}>{row.createdAt.toISOString().slice(0, 19).replace("T", " ")}</time>
                </div>
                <div className="mt-1 text-xs text-[var(--color-text-muted)]">
                  actor: {row.user?.username ?? "system"}
                  {row.project ? ` · project: ${row.project.slug}` : ""}
                  {row.task ? ` · task: ${row.task.title}` : ""}
                  {row.targetAgent ? ` · agent: ${row.targetAgent}` : ""}
                  {row.targetFile ? ` · file: ${row.targetFile}` : ""}
                </div>
                {row.payload ? <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--color-panel-soft)] p-2 text-xs text-[var(--color-text-muted)]">{row.payload}</pre> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)] p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-3 text-3xl font-semibold tracking-tight">{value}</div>
      <div className="mt-2 text-xs text-[var(--color-text-muted)]">{foot}</div>
    </div>
  );
}
