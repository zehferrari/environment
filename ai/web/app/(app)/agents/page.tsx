import Link from "next/link";
import { db } from "@/lib/db";
import { resolveEffectiveAgentConfig } from "@/lib/agents/management/effective-config";
import { describeActivity } from "@/lib/activity";
import { activityScopeWhere } from "@/lib/activity-categories";
import { formatLatency, pmChannelLatencySpans } from "@/lib/agents/pm-channel/latency";
import { readAtlasSnapshot, type SnapshotAgent } from "@/lib/atlas-snapshot";
import { agentStatusFor, agentStatusRing } from "@/lib/agents/presence";
import { statusPillClass } from "@/lib/board-status";
import AgentAvatar from "@/components/agent-avatar";
import AutoRefresh from "@/components/auto-refresh";
import AgentServiceControls, { type AgentService } from "./agent-service-controls";
import fs from "fs/promises";
import AgentManagementControls from "./agent-management-controls";
import { getSystemSettings } from "@/lib/settings/system";

export const dynamic = "force-dynamic";

function avatarUrl(name: string) {
  const first = name.split(" ")[0] || name;
  return `/agents/avatars/${encodeURIComponent(first)}?v=agent-image-v2`;
}

function localAvatarSrc(agentAvatar: string | null, liveAvatarUrl: string | undefined, name: string) {
  if (liveAvatarUrl?.startsWith("/")) return liveAvatarUrl;
  if (agentAvatar) return avatarUrl(name);
  return null;
}

function shortModel(ref?: string | null) {
  if (!ref) return "model unknown";
  const id = ref.includes("/") ? ref.slice(ref.indexOf("/") + 1) : ref;
  return id.replace(/^claude-/, "").replace(/:cloud$/, "");
}

function accentFor(slug: string) {
  const accents = ["#0a7c66", "#4f63ff", "#b34dd2", "#ea580c", "#6b7280"];
  let hash = 0;
  for (const character of slug) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return accents[Math.abs(hash) % accents.length]!;
}

function formatIdle(seconds?: number | null) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function formatAge(value: Date | string | number | null | undefined) {
  if (!value) return "unknown age";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown age";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// "Temperature" of an agent: how busy it is in the PM system, derived from
// its recorded activity (non-system audit rows over the last 24h) plus the
// tasks it currently has In Progress.
function heatLevel(events24h: number, activeTasks: number) {
  const score = events24h + activeTasks * 5;
  if (score >= 30) return { key: "hot", label: "hot", color: "var(--color-crit)", mercuryTop: 5.5 };
  if (score >= 10) return { key: "warm", label: "warm", color: "var(--color-warn)", mercuryTop: 9 };
  if (score >= 1) return { key: "mild", label: "mild", color: "var(--viz-work)", mercuryTop: 12.5 };
  return { key: "cold", label: "cold", color: "var(--color-text-dim)", mercuryTop: 15.5 };
}

function ThermometerIcon({ color, mercuryTop }: { color: string; mercuryTop: number }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <path
        d="M12 2.5A2.5 2.5 0 0 0 9.5 5v8.7a4.75 4.75 0 1 0 5 0V5A2.5 2.5 0 0 0 12 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="17.6" r="2.5" fill={color} />
      <rect x="11.1" y={mercuryTop} width="1.8" height={17.6 - mercuryTop} rx="0.9" fill={color} />
    </svg>
  );
}

function StopwatchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="13.5" r="8" />
      <path d="M12 9.5v4l2.5 2" />
      <path d="M9.5 2.5h5" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="16" rx="2" />
      <path d="M8 2.5v4M16 2.5v4M3 10h18" />
    </svg>
  );
}

function ClipboardListIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5Z" />
    </svg>
  );
}

function formatClockShort(value: Date) {
  return value.toLocaleString("en-AU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "Working on" ordering: In Progress first, then Review work the agent owns
// as reviewer/epic acting manager, then queued To Do. Backlog and Done never
// show here.
const WORKING_STATUS_ORDER: Record<string, number> = {
  "In Progress": 0,
  Review: 1,
  "To Do": 2,
};

// How recent a PM-channel run or session activity must be to count as "what
// the agent is doing right now". Runs can wedge in `streaming` for days when
// a stream dies, so status alone is not enough.
const LIVE_FRESH_MS = 15 * 60_000;

// Fresh live-session activity preview from the Atlas snapshot (ts is epoch
// ms straight off the agent's CLI jsonl, so it tracks the busy probe).
function liveActivityPreview(live?: SnapshotAgent | null): string | null {
  const last = live?.last_activity;
  if (!last || typeof last === "string") return null;
  if (!last.ts || Date.now() - last.ts > LIVE_FRESH_MS) return null;
  const item = last.items?.find((i) => (i.preview ?? "").trim().length > 0);
  if (!item?.preview) return null;
  const text = item.preview.trim().replace(/\s+/g, " ");
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function workingRank(status: string) {
  return WORKING_STATUS_ORDER[status] ?? 4;
}

type SelectedModel = { provider: string; id: string; name?: string };
type AgentModelConfig = {
  default_model: string;
  fallback_models: string[];
  selected_models: SelectedModel[];
};

function parseAgentRaw(rawJson: string | null) {
  if (!rawJson) return {};
  try {
    return JSON.parse(rawJson) as {
      reasoning?: unknown;
      telegram?: { enabled: boolean; bot: string } | null;
      integrations?: { gmail: boolean; jira: boolean; bitbucket: boolean; maildir?: boolean } | null;
      profileImages?: {
        theme?: unknown;
        customizationMode?: unknown;
        gender?: unknown;
        ageGroup?: unknown;
        ethnicity?: unknown;
        prompt?: unknown;
        username?: unknown;
        fullName?: unknown;
        bio?: unknown;
      };
    };
  } catch {
    return {};
  }
}

async function getModelConfig(slug: string): Promise<AgentModelConfig> {
  const empty: AgentModelConfig = { default_model: "", fallback_models: [], selected_models: [] };
  try {
    const content = await fs.readFile(`/srv/agents/openclaw/${slug}/openclaw.json`, "utf8");
    const json = JSON.parse(content);
    const model = json.agents?.defaults?.model;
    const primary = typeof model === "string" ? model : model?.primary || "";
    const fallbacks = Array.isArray(model?.fallbacks) ? (model.fallbacks as string[]) : [];
    const providers = json.models?.providers ?? {};
    const selected: SelectedModel[] = [];
    for (const [provider, block] of Object.entries(providers) as [string, any][]) {
      for (const m of block?.models ?? []) {
        if (m?.id) selected.push({ provider, id: m.id, name: m.name || m.id });
      }
    }
    return { default_model: primary, fallback_models: fallbacks, selected_models: selected };
  } catch {
    return empty;
  }
}

export default async function AgentsPage() {
  const [agents, snapshot, totalOpenTasks, recentPmRuns, settings] = await Promise.all([
    db.agent.findMany({
      orderBy: { slug: "asc" },
      include: {
        user: {
          include: {
            assignedTasks: {
              where: { status: { notIn: ["Done", "Backlog"] }, deletedAt: null },
              orderBy: { updatedAt: "desc" },
              take: 5,
              include: {
                project: { select: { slug: true, name: true } },
                epic: { select: { actingManagerId: true } },
              },
            },
          },
        },
      },
    }),
    readAtlasSnapshot(),
    db.task.count({
      where: {
        status: { not: "Done" },
        deletedAt: null,
      },
    }),
    db.pmChannelRun.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        agentSlug: true,
        kind: true,
        status: true,
        taskId: true,
        epicId: true,
        createdAt: true,
        updatedAt: true,
        acceptedAt: true,
        streamingAt: true,
        completedAt: true,
        failedAt: true,
        messageId: true,
      },
    }),
    getSystemSettings(),
  ]);

  const liveAgents = snapshot?.agents ?? {};
  const system = snapshot?.system ?? {};
  const monitor = snapshot?.monitor ?? null;

  // Per-agent freshness signals straight from the PM DB (the Atlas snapshot's
  // current_task/last_activity fields lag behind): the agent's latest audit
  // row and its non-system event count over the last 24h (temperature).
  const now = Date.now();
  const dayAgo = new Date(now - 24 * 3_600_000);
  const agentUserIds = agents.map((a) => a.user?.id).filter((id): id is string => Boolean(id));
  // Fresh in-flight PM turns (stale wedged runs excluded) — these say exactly
  // what a busy agent is answering right now.
  const freshPendingRuns = recentPmRuns.filter(
    (run) =>
      (run.status === "queued" || run.status === "accepted" || run.status === "streaming") &&
      now - run.updatedAt.getTime() < LIVE_FRESH_MS,
  );
  const runTaskIds = [...new Set(freshPendingRuns.map((r) => r.taskId).filter((id): id is string => Boolean(id)))];
  const runEpicIds = [...new Set(freshPendingRuns.map((r) => r.epicId).filter((id): id is string => Boolean(id)))];
  const [lastActionRows, activity24hGroups, reviewTasks, runTasks, runEpics] = await Promise.all([
    Promise.all(
      agents.map((a) =>
        a.user
          ? db.activityLog.findFirst({
              where: { userId: a.user.id, AND: [activityScopeWhere("all")] },
              orderBy: { createdAt: "desc" },
              include: { task: { select: { title: true } } },
            })
          : Promise.resolve(null),
      ),
    ),
    agentUserIds.length > 0
      ? db.activityLog.groupBy({
          by: ["userId"],
          where: {
            createdAt: { gte: dayAgo },
            userId: { in: agentUserIds },
            AND: [activityScopeWhere("all")],
          },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    // Review-stage tasks the agent OWNS as reviewer (task acting manager) or
    // as the epic's acting manager — those count as "working on" even when
    // the task is assigned to someone else.
    agentUserIds.length > 0
      ? db.task.findMany({
          where: {
            status: "Review",
            deletedAt: null,
            OR: [
              { actingManagerId: { in: agentUserIds } },
              { epic: { actingManagerId: { in: agentUserIds } } },
            ],
          },
          orderBy: { updatedAt: "desc" },
          include: {
            project: { select: { slug: true, name: true } },
            epic: { select: { actingManagerId: true } },
          },
        })
      : Promise.resolve([]),
    runTaskIds.length > 0
      ? db.task.findMany({
          where: { id: { in: runTaskIds } },
          select: { id: true, title: true, project: { select: { slug: true } } },
        })
      : Promise.resolve([]),
    runEpicIds.length > 0
      ? db.epic.findMany({
          where: { id: { in: runEpicIds } },
          select: { id: true, title: true, project: { select: { slug: true } } },
        })
      : Promise.resolve([]),
  ]);
  const lastActionBySlug = new Map(agents.map((a, i) => [a.slug, lastActionRows[i]]));
  const events24hByUserId = new Map(activity24hGroups.map((row) => [row.userId, row._count._all]));
  const reviewOwnedBy = (userId: string) =>
    reviewTasks.filter((t) => t.actingManagerId === userId || t.epic?.actingManagerId === userId);
  const runTaskById = new Map(runTasks.map((t) => [t.id, t]));
  const runEpicById = new Map(runEpics.map((e) => [e.id, e]));

  // Human line for an in-flight PM-channel turn.
  function liveRunWork(run: (typeof freshPendingRuns)[number]): { label: string; href: string | null } {
    if (run.kind === "direct") {
      return { label: "Replying in direct chat", href: `/agents/${run.agentSlug}/chat` };
    }
    if (run.taskId) {
      const t = runTaskById.get(run.taskId);
      const verb = run.kind === "task-comment" ? "Writing a comment on" : "Replying in chat on";
      return {
        label: `${verb} ${t?.title ?? "a task"}`,
        href: t ? `/projects/${t.project.slug}/tasks/${run.taskId}` : null,
      };
    }
    if (run.epicId) {
      const e = runEpicById.get(run.epicId);
      return {
        label: `Replying on epic ${e?.title ?? ""}`.trim(),
        href: e ? `/projects/${e.project.slug}/epics/${run.epicId}` : null,
      };
    }
    return { label: `PM channel turn (${run.kind})`, href: null };
  }

  const rawAgentJsons = agents.map((agent) => agent.rawJson);
  const clientAgents = await Promise.all(
    agents.map(async (a) => {
      const raw = parseAgentRaw(a.rawJson);
      const modelConfig = await getModelConfig(a.slug);
      return {
        slug: a.slug,
        name: a.name,
        role: a.role,
        reasoning: typeof raw.reasoning === "string" && raw.reasoning.trim() ? raw.reasoning.trim() : "stream",
        email: a.email,
        telegram: raw.telegram || null,
        integrations: raw.integrations || null,
        model_config: modelConfig,
        image_theme: typeof raw.profileImages?.theme === "string" ? raw.profileImages.theme : null,
        image_customization_mode: typeof raw.profileImages?.customizationMode === "string" ? raw.profileImages.customizationMode : null,
        image_gender: typeof raw.profileImages?.gender === "string" ? raw.profileImages.gender : null,
        image_age_group: typeof raw.profileImages?.ageGroup === "string" ? raw.profileImages.ageGroup : null,
        image_ethnicity: typeof raw.profileImages?.ethnicity === "string" ? raw.profileImages.ethnicity : null,
        image_prompt: typeof raw.profileImages?.prompt === "string" ? raw.profileImages.prompt : null,
        image_username: typeof raw.profileImages?.username === "string" ? raw.profileImages.username : null,
        image_full_name: typeof raw.profileImages?.fullName === "string" ? raw.profileImages.fullName : null,
        image_bio: typeof raw.profileImages?.bio === "string" ? raw.profileImages.bio : null,
      };
    })
  );
  const effectiveConfigs = new Map(
    await Promise.all(
      agents.map(async (agent) => [agent.slug, await resolveEffectiveAgentConfig(agent.rawJson, rawAgentJsons)] as const),
    ),
  );
  const agentSlugs = new Set(agents.map((agent) => agent.slug));
  const isAgentService = (name: string) => {
    const [prefix] = name.split("/");
    return name.includes("/") && agentSlugs.has(prefix);
  };
  const hostServices = Object.entries(system).filter(([name]) => !isAgentService(name));
  const onlineCount = agents.filter((a) => agentStatusFor(a, liveAgents[a.slug]) !== "offline").length;
  const openTickets = agents.reduce((sum, a) => sum + (liveAgents[a.slug]?.jira_tickets?.length ?? 0), 0);
  const activeServices = hostServices.filter(([, s]) => s.is_active === "active").length;
  const openSensorEvents = monitor?.open_events ?? [];
  const activePmRuns = recentPmRuns.filter((run) => (
    run.status === "queued" || run.status === "accepted" || run.status === "streaming"
  ));
  const pmRunsByAgent = new Map<string, typeof recentPmRuns>();
  for (const run of recentPmRuns) {
    const rows = pmRunsByAgent.get(run.agentSlug) ?? [];
    rows.push(run);
    pmRunsByAgent.set(run.agentSlug, rows);
  }
  return (
    <div className="space-y-6">
      <AutoRefresh intervalMs={15_000} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">Agents</h1>
          <AgentManagementControls agents={clientAgents} defaultPrompt={settings.profileImagePrompt} />
        </div>
        <Link
          href="/system/activity"
          className="rounded-card border border-line bg-panel px-card py-control-y text-body font-medium text-text-muted hover:border-accent hover:text-accent"
        >
          System activity →
        </Link>
      </div>

      <section className="grid gap-3 @min-[30rem]/agents-col:grid-cols-3 @min-[60rem]/agents-col:grid-cols-6">
        <Kpi label="Agents online" value={`${onlineCount}`} foot={`/ ${agents.length} registered`} />
        <Kpi label="Open tickets" value={`${openTickets}`} foot="From live Atlas snapshot" />
        <Kpi label="Open PM tasks" value={`${totalOpenTasks}`} foot="Assigned and not Done" />
        <Kpi label="PM turns" value={`${activePmRuns.length}`} foot="Queued or streaming channel turns" />
        <Kpi label="Host services" value={`${activeServices}`} foot={`/ ${hostServices.length || 0} total`} />
        <Kpi label="Sensor alerts" value={`${openSensorEvents.length}`} foot="Open monitor events" />
      </section>

      {agents.length === 0 ? (
        <p className="rounded-card border border-dashed border-line p-card text-body text-text-muted">
          No agents have been synced yet. Trigger {`/api/debug/sync`} or wait for the next cycle.
        </p>
      ) : (
        <section className="grid gap-card @min-[80rem]/agents-col:grid-cols-2">
          {agents.map((a) => {
            const live = liveAgents[a.slug];
            const recentAgentPmRuns = pmRunsByAgent.get(a.slug) ?? [];
            const pendingRuns = recentAgentPmRuns.filter((run) => (
              run.status === "queued" || run.status === "accepted" || run.status === "streaming"
            ));
            const newestPmRun = recentAgentPmRuns[0] ?? null;
            const newestPmLatency = newestPmRun ? pmChannelLatencySpans(newestPmRun) : null;
            const status = agentStatusFor(a, live);
            const ring = agentStatusRing(status);
            const tickets = live?.jira_tickets ?? [];
            const avatarSrc = localAvatarSrc(a.avatar, live?.avatar_url, a.name);
            const effective = effectiveConfigs.get(a.slug);
            const configuredServices = effective?.services ?? [];
            const liveServiceNames = Object.keys(system)
              .filter((name) => name.startsWith(`${a.slug}/`))
              .map((name) => name.slice(a.slug.length + 1));
            const agentServices: AgentService[] = Array.from(new Set([...configuredServices, ...liveServiceNames])).map((name) => ({
              name,
              status: system[`${a.slug}/${name}`]?.is_active ?? system[name]?.is_active ?? null,
            }));
            // Assigned open tasks (Backlog/Done excluded in the query). A task
            // sitting in Review is the *reviewer's* work, so it only counts
            // for this agent when they are its acting manager (or the epic's);
            // reviewer-owned Review tasks assigned to others are merged in.
            const userId = a.user?.id ?? null;
            const assignedOpen = (a.user?.assignedTasks ?? []).filter((t) =>
              t.status === "Review"
                ? userId != null && (t.actingManagerId === userId || t.epic?.actingManagerId === userId)
                : true,
            );
            const reviewing = userId ? reviewOwnedBy(userId) : [];
            const workingTasks = [...new Map([...assignedOpen, ...reviewing].map((t) => [t.id, t])).values()]
              .sort((x, y) => workingRank(x.status) - workingRank(y.status))
              .slice(0, 3);
            // "Right now" line: a fresh in-flight PM turn wins; a busy agent
            // without one falls back to its live session preview / busy
            // signals so the tile always says what the pulse is about.
            const liveRun = pendingRuns.find((run) => now - run.updatedAt.getTime() < LIVE_FRESH_MS) ?? null;
            const busy = status === "busy";
            const livePreview = busy ? liveActivityPreview(live) : null;
            const busySignals = live?.busy_state?.signals?.filter(Boolean) ?? [];
            const liveWork = liveRun
              ? liveRunWork(liveRun)
              : busy
                ? livePreview
                  ? { label: livePreview, href: null }
                  : busySignals.length > 0
                    ? { label: `Busy — ${busySignals.join(", ")}`, href: null }
                    : { label: "Busy — live session active", href: null }
                : null;
            const hasWork = liveWork !== null || workingTasks.length > 0;
            const lastAction = lastActionBySlug.get(a.slug) ?? null;
            const lastActionLabel = lastAction
              ? describeActivity({
                  kind: lastAction.kind,
                  payload: lastAction.payload,
                  actorName: a.user?.username ?? a.slug,
                  taskTitle: lastAction.task?.title ?? null,
                  targetAgent: lastAction.targetAgent,
                  targetFile: lastAction.targetFile,
                })
              : null;
            const events24h = a.user ? events24hByUserId.get(a.user.id) ?? 0 : 0;
            const activeTaskCount = (a.user?.assignedTasks ?? []).filter(
              (t) => t.status === "In Progress" || t.status === "Review",
            ).length;
            const heat = heatLevel(events24h, activeTaskCount);
            return (
              <article
                key={a.id}
                className="group relative overflow-hidden rounded-panel border border-line bg-panel p-card shadow-sm transition hover:border-accent hover:shadow-md"
                style={{ "--agent-hue": accentFor(a.slug) } as React.CSSProperties}
              >
                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,color-mix(in_srgb,var(--agent-hue)_14%,transparent),transparent_42%)]" />

                <div className="relative grid gap-3 @min-[34rem]/agents-col:grid-cols-4">
                  <div className="min-w-0 @min-[34rem]/agents-col:col-span-3">
                    <div className="flex items-start gap-2.5">
                      <Link href={`/agents/${a.slug}`} className="relative shrink-0" title={`${a.name} — profile`}>
                        <AgentAvatar
                          slug={a.slug}
                          name={a.name}
                          src={avatarSrc ?? live?.avatar_url ?? null}
                          sizeClass="h-14 w-14"
                          roundedClass="rounded-panel"
                          initialStatus={status}
                          fallback={live?.avatar ?? a.name.slice(0, 1)}
                        />
                        <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-line bg-panel px-1.5 py-0.5 text-pico font-semibold uppercase tracking-wide" style={{ color: ring.ring }}>{status}</span>
                      </Link>
                      <div className="min-w-0 flex-1">
                        <Link href={`/agents/${a.slug}`} className="group/head block" title={`${a.name} — profile`}>
                          <h2 className="truncate text-subheading font-semibold tracking-tight transition-colors group-hover/head:text-accent" title={a.name}>
                            {a.name}
                          </h2>
                          <p className="truncate font-mono text-caption text-text-muted" title={`@${a.slug} · ${a.role}`}>
                            @{a.slug} · {a.role}
                          </p>
                        </Link>
                        <div className="mt-1 flex min-w-0 items-center gap-2.5 font-mono text-micro text-text-dim">
                          <span className="min-w-0 truncate" title={live?.model_primary ?? "model unknown"}>
                            {shortModel(live?.model_primary)}
                          </span>
                          <span
                            className="inline-flex shrink-0 items-center gap-1 font-medium"
                            style={{ color: heat.color }}
                            title={`Load: ${heat.label} — ${events24h} event${events24h === 1 ? "" : "s"} in 24h · ${activeTaskCount} active task${activeTaskCount === 1 ? "" : "s"}`}
                          >
                            <ThermometerIcon color={heat.color} mercuryTop={heat.mercuryTop} />
                            <span className="tabular-nums">{events24h}</span>
                          </span>
                          <span
                            className="inline-flex shrink-0 items-center gap-1 font-medium text-text-muted"
                            title="Session idle time"
                          >
                            <StopwatchIcon />
                            <span className="tabular-nums">{formatIdle(live?.session_idle_s)}</span>
                          </span>
                        </div>

                        {/* One or the other: current work when there is any,
                            otherwise the most recent recorded action. */}
                        {hasWork ? (
                          <div className="mt-2.5 min-w-0">
                            <div className="inline-flex items-center gap-1.5 text-micro font-bold uppercase tracking-wider text-text">
                              <span className="text-accent"><ClipboardListIcon /></span>
                              Working on
                            </div>
                            <ul className="mt-1 space-y-1">
                              {liveWork ? (
                                <li className="flex min-w-0 items-center gap-2 text-body">
                                  <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60" />
                                    <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
                                  </span>
                                  <span className="shrink-0 rounded-full border border-ok/40 bg-ok/10 px-1.5 py-px text-pico font-semibold uppercase text-ok">
                                    live
                                  </span>
                                  {liveWork.href ? (
                                    <Link
                                      href={liveWork.href}
                                      className="min-w-0 truncate font-medium hover:text-accent hover:underline"
                                      title={liveWork.label}
                                    >
                                      {liveWork.label}
                                    </Link>
                                  ) : (
                                    <span className="min-w-0 truncate font-medium" title={liveWork.label}>
                                      {liveWork.label}
                                    </span>
                                  )}
                                </li>
                              ) : null}
                              {workingTasks.map((t) => (
                                <li key={t.id} className="flex min-w-0 items-center gap-2 text-body">
                                  <span className={`shrink-0 rounded-full border px-1.5 py-px text-pico font-semibold ${statusPillClass(t.status)}`}>
                                    {t.status}
                                  </span>
                                  <Link
                                    href={`/projects/${t.project.slug}/tasks/${t.id}`}
                                    className="min-w-0 truncate font-medium hover:text-accent hover:underline"
                                    title={t.title}
                                  >
                                    {t.title}
                                  </Link>
                                  <span className="shrink-0 text-caption text-text-muted">· {t.project.slug}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : (
                          <div className="mt-2.5 min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span className="inline-flex items-center gap-1.5 text-micro font-bold uppercase tracking-wider text-text">
                                <span className="text-accent"><HistoryIcon /></span>
                                Last action
                              </span>
                              {lastAction ? (
                                <span
                                  className="inline-flex items-center gap-1 text-micro font-medium text-accent"
                                  title={lastAction.createdAt.toISOString()}
                                >
                                  <CalendarIcon />
                                  {formatAge(lastAction.createdAt)} · {formatClockShort(lastAction.createdAt)}
                                </span>
                              ) : null}
                            </div>
                            {lastAction && lastActionLabel ? (
                              <p className="mt-0.5 truncate text-body" title={lastActionLabel}>
                                {lastActionLabel}
                              </p>
                            ) : (
                              <p className="mt-0.5 text-body text-text-muted">No recorded activity</p>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0 @min-[34rem]/agents-col:col-span-1">
                    <AgentServiceControls agent={a.slug} services={agentServices} />
                  </div>
                </div>

                <div className="relative mt-3 flex flex-wrap items-center gap-2 text-caption">
                  <span className="rounded-full border border-line px-2 py-0.5 text-text-muted">{tickets.length} tickets</span>
                  <span className="rounded-full border border-line px-2 py-0.5 text-text-muted">{pendingRuns.length} PM turns</span>
                  {newestPmRun ? (
                    <span
                      className="rounded-full border border-line px-2 py-0.5 text-text-muted"
                      title={newestPmLatency ? `send→accepted ${formatLatency(newestPmLatency.sendToAcceptedMs)} · accepted→first ${formatLatency(newestPmLatency.acceptedToFirstTokenMs)} · first→final ${formatLatency(newestPmLatency.firstTokenToFinalMs)}` : undefined}
                    >
                      pm {newestPmRun.status} · {formatAge(newestPmRun.updatedAt)}
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  <Link
                    href={`/agents/${a.slug}/chat`}
                    className="grid h-10 w-10 place-items-center rounded-full border border-accent/30 bg-accent-soft text-accent shadow-sm transition hover:bg-accent hover:text-bg"
                    title={`Chat with ${a.name}`}
                    aria-label={`Chat with ${a.name}`}
                  >
                    <ChatIcon />
                  </Link>
                </div>
              </article>
            );
          })}
        </section>
      )}

    </div>
  );
}

function Kpi({ label, value, foot }: { label: string; value: string; foot: string }) {
  return (
    <div className="rounded-panel border border-line bg-panel p-card shadow-sm">
      <div className="text-caption uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-3 text-4xl font-semibold tracking-tight">{value}</div>
      <div className="mt-2 text-caption text-text-muted">{foot}</div>
    </div>
  );
}
