import Link from "next/link";
import { notFound } from "next/navigation";
import { getViewer } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { describeActivity } from "@/lib/activity";
import {
  ACTIVITY_CATEGORIES,
  activityScopeWhere,
  categorizeActivityKind,
  parseActivityScope,
  type ActivityCategory,
  type ActivityScope,
} from "@/lib/activity-categories";
import { readAtlasSnapshot, type AtlasSnapshot } from "@/lib/atlas-snapshot";
import { formatLatency, pmChannelLatencySpans, summarizePmLatency } from "@/lib/agents/pm-channel/latency";
import { pmChannelQueueStats } from "@/lib/agents/pm-channel/jobs";
import { compactDbPath, formatFreelistRatio, getSqliteDbHealth } from "@/lib/db-health";
import { getDbBusyStats } from "@/lib/db-busy-counter";
import { MessageAvatar, type MessageActor } from "@/components/message-avatar";
import SystemActivityChart, { type ActivityChartBucket } from "@/components/system-activity-chart";
import ActivityDayPicker from "@/components/activity-day-picker";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// URL state: ?tab= &range= &day= &cat=
// ---------------------------------------------------------------------------

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "events", label: "Events" },
  { key: "monitor", label: "Monitor" },
  { key: "diagnostics", label: "Diagnostics" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const RANGES = [
  { key: "24h", label: "24h", hours: 24, bucketHours: 1 },
  { key: "48h", label: "48h", hours: 48, bucketHours: 2 },
  { key: "7d", label: "7 days", hours: 7 * 24, bucketHours: 6 },
  { key: "30d", label: "30 days", hours: 30 * 24, bucketHours: 24 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const WINDOW_ROW_CAP = 20_000;
const FEED_LIMIT = 150;
const OVERVIEW_FEED_LIMIT = 8;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseTab(value: string | undefined): TabKey {
  return (TABS.find((t) => t.key === value)?.key ?? "overview") as TabKey;
}

function parseRange(value: string | undefined): RangeKey {
  return (RANGES.find((r) => r.key === value)?.key ?? "24h") as RangeKey;
}

function parseDay(value: string | undefined): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

type UrlState = { tab: TabKey; range: RangeKey; day: string | null; cat: ActivityScope };

function hrefFor(current: UrlState, next: Partial<UrlState>): string {
  const tab = next.tab ?? current.tab;
  const range = next.range ?? current.range;
  const day = next.day === undefined ? current.day : next.day;
  const cat = next.cat ?? current.cat;
  const params = new URLSearchParams();
  if (tab !== "overview") params.set("tab", tab);
  if (range !== "24h") params.set("range", range);
  if (day) params.set("day", day);
  if (cat !== "all") params.set("cat", cat);
  const query = params.toString();
  return query ? `/system/activity?${query}` : "/system/activity";
}

// ---------------------------------------------------------------------------
// Time window + bucketing (server-local timezone; the host is the reference
// clock for the whole stack)
// ---------------------------------------------------------------------------

type ActivityWindow = {
  start: Date;
  end: Date;
  bucketHours: number;
  label: string; // e.g. "last 24h" or "Wed 9 Jul"
  prevLabel: string; // e.g. "prior 24h" or "prior day"
  day: string | null;
};

function floorToBucket(date: Date, bucketHours: number): Date {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  if (bucketHours > 1) d.setHours(d.getHours() - (d.getHours() % bucketHours));
  return d;
}

function fmtClock(d: Date): string {
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function fmtDayShort(d: Date): string {
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function fmtDayLong(d: Date): string {
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

function fmtDayFull(d: Date): string {
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

// Local calendar-day key (YYYY-MM-DD) for feed grouping.
function localDayKey(d: Date): string {
  return d.toLocaleDateString("en-CA");
}

function resolveWindow(range: RangeKey, day: string | null): ActivityWindow {
  if (day) {
    const start = new Date(`${day}T00:00:00`); // local midnight
    if (!Number.isNaN(start.getTime())) {
      return {
        start,
        end: new Date(start.getTime() + 24 * 3_600_000),
        bucketHours: 1,
        label: fmtDayLong(start),
        prevLabel: "the prior day",
        day,
      };
    }
  }
  const def = RANGES.find((r) => r.key === range) ?? RANGES[0];
  const now = new Date();
  const start = floorToBucket(new Date(now.getTime() - def.hours * 3_600_000), def.bucketHours);
  return {
    start,
    end: now,
    bucketHours: def.bucketHours,
    label: `last ${def.label}`,
    prevLabel: `the prior ${def.label}`,
    day: null,
  };
}

type WindowRow = { kind: string; createdAt: Date; userId: string | null };

function buildBuckets(win: ActivityWindow, rows: WindowRow[]): ActivityChartBucket[] {
  const bucketMs = win.bucketHours * 3_600_000;
  const starts: Date[] = [];
  for (let t = win.start.getTime(); t < win.end.getTime(); t += bucketMs) starts.push(new Date(t));
  const tickEvery = Math.max(1, Math.ceil(starts.length / 8));

  const buckets: ActivityChartBucket[] = starts.map((start, i) => {
    const end = new Date(start.getTime() + bucketMs);
    const daily = win.bucketHours >= 24;
    return {
      key: start.toISOString(),
      label: daily ? fmtDayShort(start) : fmtClock(start),
      detail: daily ? fmtDayLong(start) : `${fmtDayLong(start)} · ${fmtClock(start)}–${fmtClock(end)}`,
      showTick: i % tickEvery === 0,
      counts: { work: 0, chat: 0, agents: 0 },
    };
  });

  for (const row of rows) {
    const category = categorizeActivityKind(row.kind);
    if (category === "system") continue;
    const idx = Math.floor((row.createdAt.getTime() - win.start.getTime()) / bucketMs);
    if (idx >= 0 && idx < buckets.length) buckets[idx].counts[category] += 1;
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Actor serialization (same shape the chat/feed components use elsewhere)
// ---------------------------------------------------------------------------

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

function actorLabel(actor: MessageActor): string {
  if (actor.kind === "system") return "System";
  if (actor.kind === "agent") return actor.agent?.name ?? actor.name ?? actor.username;
  return actor.name ?? actor.username;
}

function formatEpochAge(ts: number | undefined): string {
  if (!ts) return "unknown";
  const ms = ts > 1e12 ? ts : ts * 1000;
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Monitor feed timestamps arrive as epoch seconds or ISO strings depending
// on the field/feed version — normalise either to a relative age.
function formatFlexAge(value: number | string | undefined): string {
  if (value == null) return "unknown";
  if (typeof value === "number") return formatEpochAge(value);
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? formatEpochAge(ms) : "unknown";
}

function formatDateAge(value: Date | null | undefined): string {
  return value ? formatEpochAge(value.getTime()) : "never";
}

const CATEGORY_CSS: Record<ActivityCategory, string> = {
  work: "var(--viz-work)",
  chat: "var(--viz-chat)",
  agents: "var(--viz-agents)",
  system: "var(--viz-muted)",
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SystemActivityPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getViewer();
  if (!viewer?.canAccessOwnerFeatures) notFound();

  const sp = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const url: UrlState = {
    tab: parseTab(single(sp.tab)),
    range: parseRange(single(sp.range)),
    day: parseDay(single(sp.day)),
    cat: parseActivityScope(single(sp.cat)),
  };
  const win = resolveWindow(url.range, url.day);
  const prevStart = new Date(win.start.getTime() - (win.end.getTime() - win.start.getTime()));

  const needsWindow = url.tab === "overview" || url.tab === "events";
  const needsSnapshot = url.tab === "overview" || url.tab === "monitor";
  const needsQueue = url.tab === "overview" || url.tab === "diagnostics";
  const windowWhere = { createdAt: { gte: win.start, lt: win.end } };

  const [windowRows, feedRows, prevCount, snapshot, queueStats, recentPmRuns, dbHealth, lastSyncRow] =
    await Promise.all([
      needsWindow
        ? db.activityLog.findMany({
            where: windowWhere,
            orderBy: { createdAt: "desc" },
            take: WINDOW_ROW_CAP,
            select: { kind: true, createdAt: true, userId: true },
          })
        : Promise.resolve([] as WindowRow[]),
      needsWindow
        ? db.activityLog.findMany({
            where: { AND: [windowWhere, activityScopeWhere(url.tab === "events" ? url.cat : "all")] },
            orderBy: { createdAt: "desc" },
            take: url.tab === "events" ? FEED_LIMIT : OVERVIEW_FEED_LIMIT,
            include: {
              user: { select: actorSelect },
              task: { select: { title: true } },
              project: { select: { slug: true } },
            },
          })
        : Promise.resolve([]),
      url.tab === "overview"
        ? db.activityLog.count({
            where: { AND: [{ createdAt: { gte: prevStart, lt: win.start } }, activityScopeWhere("all")] },
          })
        : Promise.resolve(null),
      needsSnapshot ? readAtlasSnapshot() : Promise.resolve(null),
      needsQueue ? pmChannelQueueStats() : Promise.resolve(null),
      needsQueue
        ? db.pmChannelRun.findMany({
            orderBy: { updatedAt: "desc" },
            take: 50,
            select: {
              id: true,
              agentSlug: true,
              kind: true,
              status: true,
              createdAt: true,
              admittedAt: true,
              acceptedAt: true,
              streamingAt: true,
              completedAt: true,
              failedAt: true,
              updatedAt: true,
            },
          })
        : Promise.resolve([]),
      url.tab === "diagnostics" ? getSqliteDbHealth() : Promise.resolve(null),
      url.tab === "monitor"
        ? db.activityLog.findFirst({
            where: { kind: "agent.sync" },
            orderBy: { createdAt: "desc" },
            select: { createdAt: true },
          })
        : Promise.resolve(null),
    ]);

  // Window tallies (chart + chips + KPIs)
  const categoryCounts: Record<ActivityCategory, number> = { work: 0, chat: 0, agents: 0, system: 0 };
  const kindCounts = new Map<string, number>();
  const actorCounts = new Map<string | null, number>();
  for (const row of windowRows) {
    const category = categorizeActivityKind(row.kind);
    categoryCounts[category] += 1;
    if (category !== "system") {
      kindCounts.set(row.kind, (kindCounts.get(row.kind) ?? 0) + 1);
      actorCounts.set(row.userId, (actorCounts.get(row.userId) ?? 0) + 1);
    }
  }
  const activityCount = categoryCounts.work + categoryCounts.chat + categoryCounts.agents;
  const windowCapped = windowRows.length === WINDOW_ROW_CAP;
  const buckets = url.tab === "overview" ? buildBuckets(win, windowRows) : [];

  // Top actors (overview only): resolve the user rows behind the tallies.
  const topActorEntries = [...actorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const topActorUsers =
    url.tab === "overview" && topActorEntries.some(([id]) => id)
      ? await db.user.findMany({
          where: { id: { in: topActorEntries.map(([id]) => id).filter((id): id is string => Boolean(id)) } },
          select: actorSelect,
        })
      : [];
  const actorById = new Map(topActorUsers.map((u) => [u.id, serializeActivityActor(u)!]));
  const topActors = topActorEntries.map(([id, count]) => ({
    actor: (id ? actorById.get(id) : null) ?? systemActor,
    count,
  }));

  const topKinds = [...kindCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // Feed rows → render model, grouped by local day.
  const feed = feedRows.map((row) => ({
    id: row.id,
    clock: fmtClock(row.createdAt),
    dayKey: localDayKey(row.createdAt),
    dayHeading: fmtDayFull(row.createdAt),
    actor: serializeActivityActor(row.user) ?? systemActor,
    category: categorizeActivityKind(row.kind),
    kind: row.kind,
    projectSlug: row.project?.slug ?? null,
    payload: row.payload,
    label: describeActivity({
      kind: row.kind,
      payload: row.payload,
      actorName: row.user?.username ?? null,
      taskTitle: row.task?.title ?? null,
      targetAgent: row.targetAgent,
      targetFile: row.targetFile,
    }),
  }));
  const feedGroups: Array<{ dayKey: string; heading: string; items: typeof feed }> = [];
  for (const item of feed) {
    const last = feedGroups[feedGroups.length - 1];
    if (last && last.dayKey === item.dayKey) last.items.push(item);
    else feedGroups.push({ dayKey: item.dayKey, heading: item.dayHeading, items: [item] });
  }

  // Live-signal derivations
  const system = snapshot?.system ?? {};
  const agents = snapshot?.agents ?? {};
  const monitor = snapshot?.monitor ?? null;
  const busyAgents = Object.values(agents).filter((a) => a.busy_state?.is_busy).length;
  const activeServices = Object.values(system).filter((s) => s.is_active === "active").length;
  const openSensorEvents = monitor?.open_events ?? [];
  const latencySummary = summarizePmLatency(recentPmRuns);

  const delta =
    prevCount != null && prevCount > 0
      ? Math.round(((activityCount - prevCount) / prevCount) * 100)
      : null;

  return (
    <div className="space-y-6">
      <header className="rounded-hero border border-line bg-panel p-6 shadow-sm">
        <p className="text-caption uppercase tracking-[0.28em] text-text-muted">System</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-[-0.04em]">Activity stream.</h1>
        <p className="mt-3 max-w-2xl text-body leading-6 text-text-muted">
          What the fleet did and how the host is doing — PM audit trail, live Atlas signals, and
          PM-channel diagnostics, one tab each.
        </p>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel border border-line bg-panel p-2 shadow-sm">
        <nav className="flex flex-wrap gap-1" aria-label="Activity stream tabs">
          {TABS.map((tab) => {
            const active = tab.key === url.tab;
            return (
              <Link
                key={tab.key}
                href={hrefFor(url, { tab: tab.key })}
                className={`rounded-lg px-control-x py-control-y text-body font-medium transition ${
                  active ? "bg-accent text-bg" : "text-text-muted hover:bg-panel-soft hover:text-text"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
        {url.tab === "overview" || url.tab === "events" ? (
          <div className="ml-auto flex flex-wrap items-center gap-1.5 pr-1">
            {RANGES.map((r) => {
              const active = !url.day && url.range === r.key;
              return (
                <Link
                  key={r.key}
                  href={hrefFor(url, { range: r.key, day: null })}
                  className={`rounded-full border px-3 py-1 text-caption font-medium transition ${
                    active
                      ? "border-accent bg-accent text-bg"
                      : "border-line text-text-muted hover:border-accent hover:text-accent"
                  }`}
                >
                  {r.label}
                </Link>
              );
            })}
            <span className="mx-1 hidden h-5 w-px bg-line sm:inline-block" aria-hidden="true" />
            <ActivityDayPicker day={url.day} />
          </div>
        ) : null}
      </div>

      {url.tab === "overview" ? (
        <OverviewTab
          url={url}
          win={win}
          buckets={buckets}
          windowCapped={windowCapped}
          categoryCounts={categoryCounts}
          activityCount={activityCount}
          delta={delta}
          snapshot={snapshot}
          busyAgents={busyAgents}
          agentCount={Object.keys(agents).length}
          activeServices={activeServices}
          serviceCount={Object.keys(system).length}
          sensorEvents={openSensorEvents.length}
          queue={queueStats}
          latency={latencySummary}
          topActors={topActors}
          topKinds={topKinds}
          feed={feed}
        />
      ) : null}

      {url.tab === "events" ? (
        <EventsTab url={url} win={win} categoryCounts={categoryCounts} groups={feedGroups} shown={feed.length} />
      ) : null}

      {url.tab === "monitor" ? (
        <MonitorTab snapshot={snapshot} lastSyncAt={lastSyncRow?.createdAt ?? null} />
      ) : null}

      {url.tab === "diagnostics" ? (
        <DiagnosticsTab queue={queueStats} runs={recentPmRuns} latency={latencySummary} dbHealth={dbHealth} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------

type QueueStats = Awaited<ReturnType<typeof pmChannelQueueStats>>;
type PmRun = {
  id: string;
  agentSlug: string;
  kind: string;
  status: string;
  createdAt: Date;
  acceptedAt: Date | null;
  admittedAt: Date | null;
  streamingAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  updatedAt: Date;
};
type LatencySummary = ReturnType<typeof summarizePmLatency>;
type FeedItem = {
  id: string;
  clock: string;
  dayKey: string;
  dayHeading: string;
  actor: MessageActor;
  category: ActivityCategory;
  kind: string;
  projectSlug: string | null;
  payload: string | null;
  label: string;
};

function OverviewTab({
  url,
  win,
  buckets,
  windowCapped,
  categoryCounts,
  activityCount,
  delta,
  snapshot,
  busyAgents,
  agentCount,
  activeServices,
  serviceCount,
  sensorEvents,
  queue,
  latency,
  topActors,
  topKinds,
  feed,
}: {
  url: UrlState;
  win: ActivityWindow;
  buckets: ActivityChartBucket[];
  windowCapped: boolean;
  categoryCounts: Record<ActivityCategory, number>;
  activityCount: number;
  delta: number | null;
  snapshot: AtlasSnapshot | null;
  busyAgents: number;
  agentCount: number;
  activeServices: number;
  serviceCount: number;
  sensorEvents: number;
  queue: QueueStats | null;
  latency: LatencySummary;
  topActors: Array<{ actor: MessageActor; count: number }>;
  topKinds: Array<[string, number]>;
  feed: FeedItem[];
}) {
  const backlog = queue ? queue.queued + queue.claimed + queue.retryable : null;
  const maxActor = Math.max(1, ...topActors.map((a) => a.count));
  const maxCategory = Math.max(1, ...ACTIVITY_CATEGORIES.map((c) => categoryCounts[c.key]));

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <Tile
          label="Events"
          value={activityCount.toLocaleString("en-AU")}
          sub={delta != null ? `${delta >= 0 ? "↑" : "↓"} ${Math.abs(delta)}% vs ${win.prevLabel}` : undefined}
          foot={`${categoryCounts.system.toLocaleString("en-AU")} system events hidden`}
        />
        <Tile
          label="Busy agents"
          value={snapshot ? `${busyAgents}/${agentCount}` : "—"}
          foot={snapshot ? "live Atlas snapshot" : "snapshot unavailable"}
        />
        <Tile
          label="Sensor alerts"
          value={snapshot ? String(sensorEvents) : "—"}
          tone={!snapshot ? undefined : sensorEvents === 0 ? "ok" : "warn"}
          foot={snapshot ? (sensorEvents === 0 ? "● all clear" : "● open monitor events") : "snapshot unavailable"}
        />
        <Tile
          label="Queue backlog"
          value={backlog == null ? "—" : String(backlog)}
          tone={queue && queue.failed > 0 ? "crit" : undefined}
          foot={queue ? (queue.failed > 0 ? `● ${queue.failed} failed jobs` : "no failed jobs") : "unavailable"}
        />
        <Tile
          label="Host services"
          value={snapshot ? `${activeServices}/${serviceCount}` : "—"}
          foot="active units"
        />
        <Tile
          label="PM latency p50"
          value={formatLatency(latency.p50Ms)}
          foot={`p95 ${formatLatency(latency.p95Ms)} · n=${latency.count}`}
        />
      </section>

      <section className="grid gap-card lg:grid-cols-4">
        <div className="rounded-panel border border-line bg-panel p-card shadow-sm lg:col-span-3">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-body font-semibold text-text">Activity — {win.label}</h2>
            <p className="text-caption text-text-muted">
              System/heartbeat events excluded
              {windowCapped ? " · truncated to latest 20k rows" : ""}
            </p>
          </div>
          <SystemActivityChart buckets={buckets} />

          <div className="mt-5 border-t border-line pt-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-body font-semibold text-text">Latest events</h3>
              <Link
                href={hrefFor(url, { tab: "events" })}
                className="text-caption font-medium text-accent hover:underline"
              >
                View all →
              </Link>
            </div>
            {feed.length === 0 ? (
              <p className="rounded-card border border-dashed border-line p-card text-body text-text-muted">
                No activity in this window.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {feed.map((item) => (
                  <li key={item.id} className="flex items-center gap-3 py-2">
                    <time className="w-11 shrink-0 text-right text-caption font-medium tabular-nums text-text-muted">
                      {item.clock}
                    </time>
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: CATEGORY_CSS[item.category] }}
                      title={item.category}
                    />
                    <MessageAvatar actor={item.actor} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-body" title={item.label}>
                      {item.label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="space-y-card lg:col-span-1">
          <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
            <h2 className="text-body font-semibold text-text">By category</h2>
            <div className="mt-4 space-y-3">
              {ACTIVITY_CATEGORIES.map((c) => {
                const count = categoryCounts[c.key];
                return (
                  <div key={c.key} title={c.hint}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="inline-flex items-center gap-2 text-caption text-text">
                        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: CATEGORY_CSS[c.key] }} />
                        {c.label}
                      </span>
                      <span className="text-caption font-medium tabular-nums text-text">
                        {count.toLocaleString("en-AU")}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-soft">
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${Math.min(100, (count / maxCategory) * 100)}%`, background: CATEGORY_CSS[c.key] }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {topKinds.length > 0 ? (
              <div className="mt-5 border-t border-line pt-3">
                <h3 className="text-nano font-semibold uppercase tracking-wider text-text-muted">Top event kinds</h3>
                <ul className="mt-2 space-y-1">
                  {topKinds.map(([kind, count]) => (
                    <li key={kind} className="flex items-baseline justify-between gap-3 text-caption">
                      <code className="truncate text-text-muted" title={kind}>
                        {kind}
                      </code>
                      <span className="tabular-nums text-text">{count.toLocaleString("en-AU")}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
            <h2 className="text-body font-semibold text-text">Most active</h2>
            {topActors.length === 0 ? (
              <p className="mt-4 rounded-card border border-dashed border-line p-card text-body text-text-muted">
                No activity in this window.
              </p>
            ) : (
              <ul className="mt-4 space-y-3">
                {topActors.map(({ actor, count }) => (
                  <li key={actor.id ?? actor.username} className="flex items-center gap-2.5">
                    <MessageAvatar actor={actor} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-caption font-medium text-text">{actorLabel(actor)}</span>
                        <span className="text-caption tabular-nums text-text">{count.toLocaleString("en-AU")}</span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-panel-soft">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.min(100, (count / maxActor) * 100)}%` }}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Events tab
// ---------------------------------------------------------------------------

function EventsTab({
  url,
  win,
  categoryCounts,
  groups,
  shown,
}: {
  url: UrlState;
  win: ActivityWindow;
  categoryCounts: Record<ActivityCategory, number>;
  groups: Array<{ dayKey: string; heading: string; items: FeedItem[] }>;
  shown: number;
}) {
  const activityCount = categoryCounts.work + categoryCounts.chat + categoryCounts.agents;
  const scopeTotal =
    url.cat === "all" ? activityCount : categoryCounts[url.cat as ActivityCategory] ?? activityCount;
  const chips: Array<{ key: ActivityScope; label: string; count: number }> = [
    { key: "all", label: "All activity", count: activityCount },
    ...ACTIVITY_CATEGORIES.map((c) => ({ key: c.key as ActivityScope, label: c.label, count: categoryCounts[c.key] })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => {
          const active = url.cat === chip.key;
          return (
            <Link
              key={chip.key}
              href={hrefFor(url, { cat: chip.key })}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-caption font-medium transition ${
                active
                  ? "border-accent bg-accent text-bg"
                  : "border-line text-text-muted hover:border-accent hover:text-accent"
              }`}
            >
              {chip.key !== "all" ? (
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: CATEGORY_CSS[chip.key as ActivityCategory], opacity: active ? 0.9 : 1 }}
                />
              ) : null}
              {chip.label}
              <span className={`tabular-nums ${active ? "text-bg/80" : "text-text-dim"}`}>
                {chip.count.toLocaleString("en-AU")}
              </span>
            </Link>
          );
        })}
      </div>

      <section className="rounded-panel border border-line bg-panel p-card shadow-sm">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-body font-semibold text-text">Events — {win.label}</h2>
          <p className="text-caption text-text-muted">
            {shown < scopeTotal
              ? `showing latest ${shown.toLocaleString("en-AU")} of ${scopeTotal.toLocaleString("en-AU")}`
              : `${shown.toLocaleString("en-AU")} event${shown === 1 ? "" : "s"}`}
          </p>
        </div>

        {groups.length === 0 ? (
          <p className="rounded-card border border-dashed border-line p-card text-body text-text-muted">
            Nothing recorded in this window{url.cat !== "all" ? " for this category" : ""}.
          </p>
        ) : (
          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.dayKey}>
                <h3 className="mb-2 border-b border-line pb-1 text-caption font-semibold uppercase tracking-wider text-text">
                  {group.heading}
                </h3>
                <ul className="space-y-2">
                  {group.items.map((item) => (
                    <li key={item.id} className="flex items-start gap-3">
                      <time className="w-11 shrink-0 pt-0.5 text-right text-caption font-medium tabular-nums text-accent">
                        {item.clock}
                      </time>
                      <span
                        className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                        style={{ background: CATEGORY_CSS[item.category] }}
                        title={item.category}
                      />
                      <MessageAvatar actor={item.actor} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="text-body leading-snug text-text">{item.label}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-micro text-text-dim">
                          <code>{item.kind}</code>
                          {item.projectSlug ? (
                            <Link href={`/projects/${item.projectSlug}`} className="hover:text-accent hover:underline">
                              {item.projectSlug}
                            </Link>
                          ) : null}
                          {item.payload ? (
                            <details className="inline-block">
                              <summary className="cursor-pointer hover:text-accent">payload</summary>
                              <pre className="mt-1 max-h-48 max-w-full overflow-auto whitespace-pre-wrap rounded-lg bg-panel-soft p-2 text-micro text-text-muted">
                                {prettyPayload(item.payload)}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

// ---------------------------------------------------------------------------
// Monitor tab (signals & sensors — the live Atlas view)
// ---------------------------------------------------------------------------

function MonitorTab({ snapshot, lastSyncAt }: { snapshot: AtlasSnapshot | null; lastSyncAt: Date | null }) {
  const monitor = snapshot?.monitor ?? null;
  const events = monitor?.open_events ?? [];
  const decisions = monitor?.recent_decisions ?? [];
  const services = Object.entries(snapshot?.system ?? {});
  const activeServices = services.filter(([, s]) => s.is_active === "active").length;

  if (!snapshot) {
    return (
      <section className="rounded-panel border border-dashed border-line bg-panel p-card text-body text-text-muted shadow-sm">
        Atlas snapshot feed unavailable (127.0.0.1:3013) — no live monitor signal to show.
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-caption text-text-muted">
        Snapshot from <span className="font-medium text-text">{snapshot.host ?? "unknown host"}</span> ·{" "}
        {formatEpochAge(snapshot.ts)} · last agent registry sync {formatDateAge(lastSyncAt)}
      </p>

      <section className="grid gap-card lg:grid-cols-2">
        <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-body font-semibold text-text">Monitor tick</h2>
            <span
              className={
                monitor?.last_tick?.healthy === false
                  ? "text-caption font-semibold text-crit"
                  : "text-caption font-semibold text-ok"
              }
            >
              {monitor?.last_tick ? (monitor.last_tick.healthy === false ? "● attention" : "● healthy") : "unknown"}
            </span>
          </div>
          <p className="mt-3 text-body leading-6 text-text-muted">
            {monitor?.last_tick?.summary ?? "No monitor tick reported."}
          </p>
          {monitor?.last_tick?.actions?.length ? (
            <p className="mt-3 font-mono text-micro text-text-muted">actions: {monitor.last_tick.actions.join(", ")}</p>
          ) : null}

          <h3 className="mt-5 border-t border-line pt-3 text-nano font-semibold uppercase tracking-wider text-text-muted">
            Open sensor events
          </h3>
          {events.length === 0 ? (
            <p className="mt-2 text-body text-ok">● No open sensor events.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {events.map((event) => (
                <li
                  key={event.key ?? `${event.unit}:${event.kind}`}
                  className="rounded-card border border-line bg-panel-soft px-3 py-2 text-body"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium">{event.unit ?? "unknown unit"}</span>
                    <span
                      className={
                        event.severity === "crit"
                          ? "text-caption font-semibold text-crit"
                          : "text-caption font-semibold text-warn"
                      }
                    >
                      ● {event.severity ?? "warn"}
                    </span>
                  </div>
                  <div className="mt-1 text-caption text-text-muted">
                    {event.kind ?? "sensor"}
                    {typeof event.missed_runs === "number" ? ` · missed ${event.missed_runs}` : ""}
                    {event.first_seen != null ? ` · first seen ${formatFlexAge(event.first_seen)}` : ""}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-body font-semibold text-text">Host services</h2>
            <p className="text-caption text-text-muted">
              {activeServices}/{services.length} active
            </p>
          </div>
          {services.length === 0 ? (
            <p className="mt-3 text-body text-text-muted">No service status reported.</p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {services.map(([name, svc]) => {
                const ok = svc.is_active === "active";
                return (
                  <div key={name} className="flex items-center gap-2 rounded-card border border-line bg-panel-soft px-3 py-2">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? "bg-ok" : "bg-crit"}`} />
                    <code className="min-w-0 flex-1 truncate text-caption">{name}</code>
                    <span className={`text-nano font-medium ${ok ? "text-ok" : "text-crit"}`}>
                      {svc.is_active ?? "unknown"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {decisions.length > 0 ? (
        <section className="rounded-panel border border-line bg-panel p-card shadow-sm">
          <h2 className="mb-3 text-body font-semibold text-text">Recent monitor decisions</h2>
          <ul className="divide-y divide-line">
            {decisions.slice(0, 8).map((decision, i) => {
              const when = decision.timestamp ?? decision.ts;
              return (
                <li key={`${decision.incident_id ?? "d"}:${when ?? i}`} className="py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    {decision.decision ? (
                      <span className="rounded-full border border-line px-2 py-0.5 text-nano font-semibold uppercase tracking-wide text-text-muted">
                        {decision.decision}
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 text-body">
                      {decision.reason ?? decision.summary ?? "decision"}
                    </span>
                    {when ? <span className="font-mono text-micro text-text-dim">{formatFlexAge(when)}</span> : null}
                  </div>
                  {decision.actions_taken?.length ? (
                    <p className="mt-1 truncate font-mono text-micro text-text-muted" title={decision.actions_taken.join(", ")}>
                      → {decision.actions_taken.join(", ")}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics tab (PM channel + storage internals)
// ---------------------------------------------------------------------------

function DiagnosticsTab({
  queue,
  runs,
  latency,
  dbHealth,
}: {
  queue: QueueStats | null;
  runs: PmRun[];
  latency: LatencySummary;
  dbHealth: Awaited<ReturnType<typeof getSqliteDbHealth>> | null;
}) {
  const busyStats = getDbBusyStats();

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Queued jobs" value={String(queue?.queued ?? "—")} foot="waiting for worker" />
        <Tile label="Claimed jobs" value={String(queue?.claimed ?? "—")} foot="in local dispatch" />
        <Tile
          label="Retryable jobs"
          value={String(queue?.retryable ?? "—")}
          tone={queue && queue.retryable > 0 ? "warn" : undefined}
          foot="backoff pending"
        />
        <Tile
          label="Failed jobs"
          value={String(queue?.failed ?? "—")}
          tone={queue && queue.failed > 0 ? "crit" : undefined}
          foot={queue && queue.failed > 0 ? "● needs operator check" : "none"}
        />
      </section>

      <section className="rounded-panel border border-line bg-panel p-card shadow-sm">
        <h2 className="mb-3 text-body font-semibold text-text">PM channel queue</h2>
        {queue?.oldestQueued ? (
          <p className="text-body text-text-muted">
            Oldest available job: @{queue.oldestQueued.agentSlug} · {queue.oldestQueued.kind} ·{" "}
            {queue.oldestQueued.availableAt.toISOString().slice(0, 19).replace("T", " ")}
          </p>
        ) : (
          <p className="text-body text-text-muted">No queued or retryable PM-channel jobs.</p>
        )}
        {queue && queue.recentErrors.length > 0 ? (
          <ul className="mt-3 divide-y divide-line text-caption">
            {queue.recentErrors.map((job) => (
              <li key={job.id} className="py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    @{job.agentSlug} · {job.kind} · {job.status} · attempt {job.attemptCount}
                  </span>
                  <time className="font-mono text-micro text-text-muted" dateTime={job.updatedAt.toISOString()}>
                    {job.updatedAt.toISOString().slice(0, 19).replace("T", " ")}
                  </time>
                </div>
                <p className="mt-1 text-text-muted">{job.lastError}</p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section className="grid gap-card lg:grid-cols-2">
        <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-body font-semibold text-text">PM latency spans</h2>
            <p className="font-mono text-micro text-text-muted">
              p50 {formatLatency(latency.p50Ms)} · p95 {formatLatency(latency.p95Ms)} · max{" "}
              {formatLatency(latency.maxMs)} · n={latency.count}
            </p>
          </div>
          {runs.length === 0 ? (
            <p className="mt-3 text-body text-text-muted">No PM channel runs recorded yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line text-caption">
              {runs.slice(0, 12).map((run) => {
                const spans = pmChannelLatencySpans(run);
                return (
                  <li key={run.id} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">
                        @{run.agentSlug} · {run.kind} · {run.status}
                      </span>
                      <time className="font-mono text-micro text-text-muted" dateTime={run.updatedAt.toISOString()}>
                        {run.updatedAt.toISOString().slice(0, 19).replace("T", " ")}
                      </time>
                    </div>
                    <div className="mt-1 font-mono text-micro text-text-muted">
                      send→accepted {formatLatency(spans.sendToAcceptedMs)} · accepted→first-token{" "}
                      {formatLatency(spans.acceptedToFirstTokenMs)} · first-token→final{" "}
                      {formatLatency(spans.firstTokenToFinalMs)} · send→final {formatLatency(spans.sendToFinalMs)}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-body font-semibold text-text">SQLite health</h2>
              <p className="mt-1 font-mono text-caption text-text-muted">{compactDbPath(dbHealth?.path ?? null)}</p>
            </div>
            {dbHealth ? (
              <span
                className={
                  dbHealth.outsideWorktree
                    ? "text-caption font-semibold text-ok"
                    : "text-caption font-semibold text-crit"
                }
              >
                {dbHealth.outsideWorktree ? "● outside worktree" : "● inside/unknown"}
              </span>
            ) : null}
          </div>
          {dbHealth ? (
            <>
              <div className="mt-4 grid grid-cols-2 gap-2 text-body">
                <MiniMetric label="Pages" value={dbHealth.pageCount == null ? "—" : String(dbHealth.pageCount)} />
                <MiniMetric
                  label="Freelist"
                  value={
                    dbHealth.freelistCount == null
                      ? "—"
                      : `${dbHealth.freelistCount} (${formatFreelistRatio(dbHealth.freelistRatio)})`
                  }
                />
                <MiniMetric label="Journal" value={dbHealth.journalMode ?? "—"} />
                <MiniMetric label="Locking" value={dbHealth.lockingMode ?? "—"} />
              </div>
              <p className="mt-3 text-caption text-text-muted">
                busy_timeout {dbHealth.busyTimeoutMs ?? "—"}ms · WAL {dbHealth.walExists ? "present" : "absent"} · SHM{" "}
                {dbHealth.shmExists ? "present" : "absent"}
              </p>
              <p className="mt-1 text-caption text-text-muted">
                lock/busy errors {busyStats.lockErrors}
                {busyStats.lastLockAt ? ` · last ${busyStats.lastLockAt.slice(0, 19).replace("T", " ")}` : ""}
              </p>
              {dbHealth.warnings.length > 0 ? (
                <ul className="mt-3 space-y-1">
                  {dbHealth.warnings.map((w) => (
                    <li key={w.code} className="text-caption font-medium text-crit">
                      ⚠ {w.message}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-caption text-ok">No health warnings.</p>
              )}
              {dbHealth.error ? <p className="mt-2 text-caption text-crit">{dbHealth.error}</p> : null}
            </>
          ) : (
            <p className="mt-3 text-body text-text-muted">Health probe unavailable.</p>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Tile({
  label,
  value,
  foot,
  sub,
  tone,
}: {
  label: string;
  value: string;
  foot: string;
  sub?: string;
  tone?: "ok" | "warn" | "crit";
}) {
  const valueColor =
    tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "crit" ? "text-crit" : "text-text";
  const footColor = tone === "crit" ? "text-crit" : tone === "warn" ? "text-warn" : "text-text-muted";
  return (
    <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
      <div className="text-caption uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-2 text-3xl font-semibold tracking-tight ${valueColor}`}>{value}</div>
      {sub ? <div className="mt-1 text-caption text-text-muted">{sub}</div> : null}
      <div className={`mt-1.5 text-caption ${footColor}`}>{foot}</div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-panel-soft p-3">
      <div className="text-nano uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-caption text-text" title={value}>
        {value}
      </div>
    </div>
  );
}
