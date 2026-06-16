import { formatLatency, pmChannelLatencySpans, summarizePmLatency } from "@/lib/agents/pm-channel/latency";
import { pmChannelQueueStats } from "@/lib/agents/pm-channel/jobs";
import { compactDbPath, formatFreelistRatio, getSqliteDbHealth } from "@/lib/db-health";
import { getDbBusyStats } from "@/lib/db-busy-counter";
import { db } from "@/lib/db";
import {
  actorDisplayName,
  MessageAvatar,
  MessageTimestamp,
  type MessageActor,
} from "@/components/message-avatar";

export const dynamic = "force-dynamic";

type Snapshot = {
  ts?: number;
  host?: string;
  agents?: Record<string, { busy_state?: { is_busy?: boolean }; jira_tickets?: unknown[] }>;
  system?: Record<string, { is_active?: string }>;
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

export default async function SystemActivityPage() {
  const [events, agentSync, snapshot, dbHealth, recentPmRuns, queueStats] = await Promise.all([
    db.activityLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 60,
      include: { user: { select: actorSelect }, task: { select: { title: true } }, project: { select: { slug: true } } },
    }),
    db.activityLog.findFirst({ where: { kind: "agent.sync" }, orderBy: { createdAt: "desc" } }),
    readSnapshot(),
    getSqliteDbHealth(),
    db.pmChannelRun.findMany({
      orderBy: { updatedAt: "desc" },
      take: 12,
      select: {
        id: true,
        agentSlug: true,
        kind: true,
        status: true,
        createdAt: true,
        acceptedAt: true,
        streamingAt: true,
        completedAt: true,
        failedAt: true,
        updatedAt: true,
      },
    }),
    pmChannelQueueStats(),
  ]);

  const latencySummary = summarizePmLatency(recentPmRuns);
  const busyStats = getDbBusyStats();
  const system = snapshot?.system ?? {};
  const agents = snapshot?.agents ?? {};
  const activeServices = Object.values(system).filter((s) => s.is_active === "active").length;
  const busyAgents = Object.values(agents).filter((a) => a.busy_state?.is_busy).length;
  const openTickets = Object.values(agents).reduce((sum, a) => sum + (a.jira_tickets?.length ?? 0), 0);

  return (
    <div className="space-y-6">
      <header className="rounded-[28px] border border-line bg-panel p-6 shadow-sm">
        <p className="text-xs uppercase tracking-[0.28em] text-text-muted">System</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Activity stream.</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-text-muted">
          PM audit trail plus live Atlas host signal: service status, busy agents, open tickets, and recent server activity.
        </p>
      </header>

      <section className="grid gap-3 md:grid-cols-4">
        <Tile label="Events" value={String(events.length)} foot="Most recent rows" />
        <Tile label="Busy agents" value={String(busyAgents)} foot={`/ ${Object.keys(agents).length} reported`} />
        <Tile label="Open tickets" value={String(openTickets)} foot="From Atlas snapshot" />
        <Tile label="Host services" value={String(activeServices)} foot={`/ ${Object.keys(system).length} active`} />
      </section>

      <section className="grid gap-3 md:grid-cols-4">
        <Tile label="Queued jobs" value={String(queueStats.queued)} foot="Waiting for worker" />
        <Tile label="Claimed jobs" value={String(queueStats.claimed)} foot="In local dispatch" />
        <Tile label="Retryable jobs" value={String(queueStats.retryable)} foot="Backoff pending" />
        <Tile label="Failed jobs" value={String(queueStats.failed)} foot="Needs operator check" />
      </section>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-xs uppercase tracking-wider text-text-muted">SQLite health</h2>
              <p className="mt-1 font-mono text-xs text-text-muted">{compactDbPath(dbHealth.path)}</p>
            </div>
            <span className={dbHealth.outsideWorktree ? "text-xs font-semibold text-ok" : "text-xs font-semibold text-crit"}>
              {dbHealth.outsideWorktree ? "outside worktree" : "inside/unknown"}
            </span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <MiniMetric label="Pages" value={dbHealth.pageCount == null ? "—" : String(dbHealth.pageCount)} />
            <MiniMetric label="Freelist" value={dbHealth.freelistCount == null ? "—" : `${dbHealth.freelistCount} (${formatFreelistRatio(dbHealth.freelistRatio)})`} />
            <MiniMetric label="Journal" value={dbHealth.journalMode ?? "—"} />
            <MiniMetric label="Locking" value={dbHealth.lockingMode ?? "—"} />
          </div>
          <p className="mt-3 text-xs text-text-muted">
            busy_timeout {dbHealth.busyTimeoutMs ?? "—"}ms · WAL {dbHealth.walExists ? "present" : "absent"} · SHM {dbHealth.shmExists ? "present" : "absent"}
          </p>
          <p className="mt-1 text-xs text-text-muted">
            lock/busy errors {busyStats.lockErrors}
            {busyStats.lastLockAt ? ` · last ${busyStats.lastLockAt.slice(0, 19).replace("T", " ")}` : ""}
          </p>
          {dbHealth.warnings.length > 0 ? (
            <ul className="mt-3 space-y-1">
              {dbHealth.warnings.map((w) => (
                <li key={w.code} className="text-xs font-medium text-crit">⚠ {w.message}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-ok">No health warnings.</p>
          )}
          {dbHealth.error ? <p className="mt-2 text-xs text-crit">{dbHealth.error}</p> : null}
        </div>

        <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xs uppercase tracking-wider text-text-muted">PM latency spans</h2>
            <p className="font-mono text-[11px] text-text-muted">
              send→final p50 {formatLatency(latencySummary.p50Ms)} · p95 {formatLatency(latencySummary.p95Ms)} · max {formatLatency(latencySummary.maxMs)} · n={latencySummary.count}
            </p>
          </div>
          {recentPmRuns.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">No PM channel runs recorded yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line text-xs">
              {recentPmRuns.map((run) => {
                const spans = pmChannelLatencySpans(run);
                return (
                  <li key={run.id} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">@{run.agentSlug} · {run.kind} · {run.status}</span>
                      <time className="font-mono text-[11px] text-text-muted" dateTime={run.updatedAt.toISOString()}>{run.updatedAt.toISOString().slice(0, 19).replace("T", " ")}</time>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-text-muted">
                      send→accepted {formatLatency(spans.sendToAcceptedMs)} · accepted→first-token {formatLatency(spans.acceptedToFirstTokenMs)} · first-token→final {formatLatency(spans.firstTokenToFinalMs)} · send→final {formatLatency(spans.sendToFinalMs)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-text-muted">PM channel queue</h2>
        {queueStats.oldestQueued ? (
          <p className="text-sm text-text-muted">
            Oldest available job: @{queueStats.oldestQueued.agentSlug} · {queueStats.oldestQueued.kind} · {queueStats.oldestQueued.availableAt.toISOString().slice(0, 19).replace("T", " ")}
          </p>
        ) : (
          <p className="text-sm text-text-muted">No queued or retryable PM-channel jobs.</p>
        )}
        {queueStats.recentErrors.length > 0 ? (
          <ul className="mt-3 divide-y divide-line text-xs">
            {queueStats.recentErrors.map((job) => (
              <li key={job.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">@{job.agentSlug} · {job.kind} · {job.status} · attempt {job.attemptCount}</span>
                  <time className="font-mono text-[11px] text-text-muted" dateTime={job.updatedAt.toISOString()}>{job.updatedAt.toISOString().slice(0, 19).replace("T", " ")}</time>
                </div>
                <p className="mt-1 text-text-muted">{job.lastError}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-text-muted">Host services</h2>
        {Object.keys(system).length === 0 ? (
          <p className="text-sm text-text-muted">No service status reported by the Atlas snapshot feed.</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-3">
            {Object.entries(system).map(([name, svc]) => {
              const ok = svc.is_active === "active";
              return (
                <div key={name} className="rounded-xl border border-line bg-panel-soft px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <code className="truncate text-xs">{name}</code>
                    <span className={ok ? "text-ok" : "text-crit"}>{svc.is_active ?? "unknown"}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-text-muted">Recent events</h2>
        {events.length === 0 ? (
          <p className="text-sm text-text-muted">No activity recorded yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {events.map((row) => {
              const actor = serializeActivityActor(row.user) ?? systemActor;
              return (
              <li key={row.id} className="py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <MessageTimestamp value={row.createdAt} />
                  <MessageAvatar actor={actor} size="sm" />
                  <span className="font-medium">{row.kind}</span>
                </div>
                <div className="mt-1 text-xs text-text-muted">
                  actor: {actorDisplayName(actor)}
                  {row.project ? ` · project: ${row.project.slug}` : ""}
                  {row.task ? ` · task: ${row.task.title}` : ""}
                  {row.targetAgent ? ` · agent: ${row.targetAgent}` : ""}
                  {row.targetFile ? ` · file: ${row.targetFile}` : ""}
                </div>
                {row.payload ? <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg bg-panel-soft p-2 text-xs text-text-muted">{row.payload}</pre> : null}
              </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Tile({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="text-xs uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-3 text-3xl font-semibold tracking-tight">{value}</div>
      <div className="mt-2 text-xs text-text-muted">{foot}</div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel-soft p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-text" title={value}>{value}</div>
    </div>
  );
}
