import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { describeActivity } from "@/lib/activity";
import { listAssignablePrincipals } from "@/lib/principals";
import { normalizeWorkItemKeyPrefix } from "@/lib/work-items/keys";
import ActivityAgenda from "@/components/activity-agenda";
import AddProjectFab from "./add-project-fab";

export const dynamic = "force-dynamic";

const TASK_STATUSES = ["Backlog", "To Do", "In Progress", "Review", "Done"] as const;
const EPIC_STATUSES = ["Backlog", "Open", "Done"] as const;
const ACTIVE_TASK_STATUSES = new Set(["Backlog", "To Do", "In Progress", "Review"]);
const ACTIVITY_FEED_LIMIT = 20;

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

type ProjectRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  repositoryPath: string | null;
  defaultGitUserName: string | null;
  defaultGitUserEmail: string | null;
  doneTtlDays: number | null;
};

type TaskStatus = (typeof TASK_STATUSES)[number];
type EpicStatus = (typeof EPIC_STATUSES)[number];

type ProjectDashboardStats = {
  task: Record<TaskStatus, number>;
  epic: Record<EpicStatus, number>;
  blocked: number;
  recentActivityAt: Date | null;
};

type WorkspaceDashboardProject = {
  project: ProjectRow;
  stats: ProjectDashboardStats;
};

type WorkspaceDashboardGroup = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  type: string;
  projects: WorkspaceDashboardProject[];
  stats: ProjectDashboardStats;
};

// Create a project with its settings up front (mirrors the task/epic "new"
// modal: one form, the project's own fields).
async function createProject(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 200) return;
  const description = String(formData.get("description") ?? "").trim() || null;
  const slug = String(formData.get("slug") ?? "").trim().toLowerCase();
  if (!slug || !/^[a-zA-Z0-9\-_]+$/.test(slug)) {
    throw new Error("Project slug is required and may only contain letters, numbers, hyphens, and underscores.");
  }
  const repositoryPath = String(formData.get("repositoryPath") ?? "").trim();
  if (!repositoryPath) throw new Error("Repository folder is required");
  const rawWorkItemKeyPrefix = String(formData.get("workItemKeyPrefix") ?? "").trim();
  const workItemKeyPrefix = normalizeWorkItemKeyPrefix(rawWorkItemKeyPrefix);
  if (!workItemKeyPrefix) {
    throw new Error("Project key must start with a letter and contain only 2-10 letters or numbers.");
  }
  const defaultGitUserName =
    String(formData.get("defaultGitUserName") ?? "").trim() || null;
  const defaultGitUserEmail =
    String(formData.get("defaultGitUserEmail") ?? "").trim() || null;
  const defaultAssigneeId =
    String(formData.get("defaultAssigneeId") ?? "").trim() || null;
  const defaultReviewerId =
    String(formData.get("defaultReviewerId") ?? "").trim() || null;
  const doneTtlRaw = String(formData.get("doneTtlDays") ?? "").trim();
  const doneTtlDays =
    doneTtlRaw === "" ? null : Math.max(1, Math.min(365, Number(doneTtlRaw) || 5));

  if (await db.project.findUnique({ where: { slug }, select: { id: true } })) {
    throw new Error("Project slug is already in use.");
  }
  if (await db.project.findUnique({ where: { workItemKeyPrefix }, select: { id: true } })) {
    throw new Error("Project key is already in use.");
  }

  await db.project.create({
    data: {
      slug,
      name,
      description,
      repositoryPath,
      workItemKeyPrefix,
      defaultGitUserName,
      defaultGitUserEmail,
      defaultAssigneeId,
      defaultReviewerId,
      doneTtlDays,
    },
  });
  revalidatePath("/projects");
  redirect(`/projects/${slug}`);
}

function emptyStats(): ProjectDashboardStats {
  return {
    task: { Backlog: 0, "To Do": 0, "In Progress": 0, Review: 0, Done: 0 },
    epic: { Backlog: 0, Open: 0, Done: 0 },
    blocked: 0,
    recentActivityAt: null,
  };
}

function totalTasks(stats: ProjectDashboardStats) {
  return TASK_STATUSES.reduce((sum, status) => sum + stats.task[status], 0);
}

function totalEpics(stats: ProjectDashboardStats) {
  return EPIC_STATUSES.reduce((sum, status) => sum + stats.epic[status], 0);
}

function activeTasks(stats: ProjectDashboardStats) {
  return TASK_STATUSES.reduce(
    (sum, status) => sum + (ACTIVE_TASK_STATUSES.has(status) ? stats.task[status] : 0),
    0,
  );
}

function completionPercent(stats: ProjectDashboardStats) {
  const total = totalTasks(stats);
  if (total === 0) return 0;
  return Math.round((stats.task.Done / total) * 100);
}

function formatRecent(value: Date | null) {
  if (!value) return "No activity yet";
  const seconds = Math.max(0, Math.floor((Date.now() - value.getTime()) / 1000));
  if (seconds < 60) return "Updated just now";
  if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `Updated ${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `Updated ${Math.floor(seconds / 86400)}d ago`;
  return `Updated ${value.toISOString().slice(0, 10)}`;
}

function statusTone(stats: ProjectDashboardStats) {
  if (stats.blocked > 0) return { label: `${stats.blocked} blocked`, className: "border-crit/50 bg-crit/10 text-crit" };
  if (stats.task.Review > 0) return { label: `${stats.task.Review} in review`, className: "border-amber-500/60 bg-amber-500/10 text-amber-700" };
  if (stats.task["In Progress"] > 0) return { label: `${stats.task["In Progress"]} active`, className: "border-ok/50 bg-ok/10 text-ok" };
  if (activeTasks(stats) === 0 && stats.task.Done > 0) return { label: "Complete", className: "border-lime-500/60 bg-lime-500/10 text-lime-700" };
  return { label: "Quiet", className: "border-line bg-panel-soft text-text-muted" };
}

function mergeStats(target: ProjectDashboardStats, source: ProjectDashboardStats) {
  for (const status of TASK_STATUSES) target.task[status] += source.task[status];
  for (const status of EPIC_STATUSES) target.epic[status] += source.epic[status];
  target.blocked += source.blocked;
  if (!target.recentActivityAt || (source.recentActivityAt && source.recentActivityAt > target.recentActivityAt)) {
    target.recentActivityAt = source.recentActivityAt;
  }
  return target;
}

export default async function ProjectsPage() {
  const [workspaces, deletedCount, archivedCount, principals] = await Promise.all([
    db.workspace.findMany({
      where: { archivedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        type: true,
        projects: {
          where: { project: { archivedAt: null, deletedAt: null } },
          orderBy: { createdAt: "asc" },
          select: {
            project: {
              select: {
                id: true,
                slug: true,
                name: true,
                description: true,
                repositoryPath: true,
                defaultGitUserName: true,
                defaultGitUserEmail: true,
                doneTtlDays: true,
              },
            },
          },
        },
      },
    }),
    db.project.count({ where: { deletedAt: { not: null } } }),
    db.project.count({ where: { archivedAt: { not: null }, deletedAt: null } }),
    listAssignablePrincipals(),
  ]);

  const projects = workspaces.flatMap((workspace) => workspace.projects.map(({ project }) => project));
  const projectIds = projects.map((p) => p.id);
  const statsByProject = new Map(projects.map((p) => [p.id, emptyStats()]));

  const [taskStatusCounts, epicStatusCounts, blockedCounts, recentProjectActivity, activity] =
    projectIds.length > 0
      ? await Promise.all([
          db.task.groupBy({
            by: ["projectId", "status"],
            where: { projectId: { in: projectIds }, deletedAt: null, archivedAt: null, parentTaskId: null },
            _count: { _all: true },
          }),
          db.epic.groupBy({
            by: ["projectId", "status"],
            where: { projectId: { in: projectIds }, deletedAt: null, archivedAt: null },
            _count: { _all: true },
          }),
          db.task.groupBy({
            by: ["projectId"],
            where: {
              projectId: { in: projectIds },
              deletedAt: null,
              archivedAt: null,
              parentTaskId: null,
              blockedBy: { is: { deletedAt: null, status: { not: "Done" } } },
            },
            _count: { _all: true },
          }),
          db.activityLog.groupBy({
            by: ["projectId"],
            where: { projectId: { in: projectIds } },
            _max: { createdAt: true },
          }),
          db.activityLog.findMany({
            where: { projectId: { in: projectIds } },
            orderBy: { createdAt: "desc" },
            take: ACTIVITY_FEED_LIMIT,
            include: {
              project: { select: { name: true, slug: true } },
              user: { select: actorSelect },
              task: { select: { title: true } },
            },
          }),
        ])
      : [[], [], [], [], []] as const;

  for (const row of taskStatusCounts) {
    const stats = statsByProject.get(row.projectId);
    if (stats && TASK_STATUSES.includes(row.status as TaskStatus)) {
      stats.task[row.status as TaskStatus] = row._count._all;
    }
  }
  for (const row of epicStatusCounts) {
    const stats = statsByProject.get(row.projectId);
    if (stats && EPIC_STATUSES.includes(row.status as EpicStatus)) {
      stats.epic[row.status as EpicStatus] = row._count._all;
    }
  }
  for (const row of blockedCounts) {
    const stats = statsByProject.get(row.projectId);
    if (stats) stats.blocked = row._count._all;
  }
  for (const row of recentProjectActivity) {
    const stats = row.projectId ? statsByProject.get(row.projectId) : null;
    if (stats) stats.recentActivityAt = row._max.createdAt ?? null;
  }

  const workspaceGroups: WorkspaceDashboardGroup[] = workspaces.map((workspace) => {
    const workspaceProjects = workspace.projects.map(({ project }) => ({
      project,
      stats: statsByProject.get(project.id) ?? emptyStats(),
    }));
    const stats = workspaceProjects.reduce(
      (acc, item) => mergeStats(acc, item.stats),
      emptyStats(),
    );
    return {
      id: workspace.id,
      slug: workspace.slug,
      name: workspace.name,
      description: workspace.description,
      type: workspace.type,
      projects: workspaceProjects,
      stats,
    };
  });

  const totals = Array.from(statsByProject.values()).reduce(
    (acc, stats) => {
      acc.tasks += totalTasks(stats);
      acc.active += activeTasks(stats);
      acc.review += stats.task.Review;
      acc.blocked += stats.blocked;
      acc.epics += totalEpics(stats);
      return acc;
    },
    { workspaces: workspaceGroups.length, projects: projectIds.length, tasks: 0, active: 0, review: 0, blocked: 0, epics: 0 },
  );

  const feed = activity.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    label: `${row.project?.name ?? "Project"}: ${describeActivity({
      kind: row.kind,
      payload: row.payload,
      actorName: row.user?.username ?? null,
      taskTitle: row.task?.title ?? null,
    })}`,
    actor: row.user
      ? {
          id: row.user.id,
          username: row.user.username,
          kind: row.user.kind,
          name: row.user.name,
          avatarUpdatedAt: row.user.avatarUpdatedAt?.toISOString() ?? null,
          agent: row.user.agent,
        }
      : null,
  }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-display font-semibold tracking-tight">Project dashboard</h1>
          <p className="mt-1 max-w-2xl text-body text-text-muted">
            Cross-workspace health, progress, and recent movement across accessible workspaces.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/projects/archive"
            className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent"
          >
            Archive{archivedCount > 0 ? ` (${archivedCount})` : ""}
          </Link>
          <Link
            href="/projects/bin"
            className="rounded-lg border border-line bg-panel px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent"
          >
            Bin{deletedCount > 0 ? ` (${deletedCount})` : ""}
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-card lg:grid-cols-6" aria-label="Cross-workspace summary">
        <SummaryMetric label="Workspaces" value={totals.workspaces} />
        <SummaryMetric label="Projects" value={totals.projects} />
        <SummaryMetric label="Epics" value={totals.epics} />
        <SummaryMetric label="Tasks" value={totals.tasks} />
        <SummaryMetric label="Active" value={totals.active} tone="ok" />
        <SummaryMetric label="Needs attention" value={totals.blocked + totals.review} tone={totals.blocked > 0 ? "crit" : "warn"} />
      </section>

      {workspaceGroups.length === 0 ? (
        <p className="rounded-panel border border-dashed border-line bg-panel p-8 text-center text-body text-text-muted">
          No workspaces yet. Use the workspace settings to group projects, then return here for cross-workspace health.
        </p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <section className="space-y-6" aria-label="Workspace cards">
            {workspaceGroups.map((workspace) => (
              <WorkspaceSection key={workspace.id} workspace={workspace} />
            ))}
          </section>
          <aside className="rounded-panel border border-line bg-panel p-card shadow-sm xl:sticky xl:top-card xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
            <h2 className="mb-3 text-caption uppercase tracking-wider text-text-muted">
              Recent activity
            </h2>
            {feed.length > 0 ? (
              <ActivityAgenda feed={feed} />
            ) : (
              <p className="text-body text-text-muted">No project activity yet.</p>
            )}
          </aside>
        </div>
      )}

      <AddProjectFab
        principals={principals.map((p) => ({ id: p.id, name: p.name }))}
        createProjectAction={createProject}
      />
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "ok" | "warn" | "crit";
}) {
  const toneClass = {
    neutral: "border-line bg-panel text-text",
    ok: "border-ok/30 bg-ok/[0.06] text-ok",
    warn: "border-amber-500/40 bg-amber-500/[0.08] text-amber-700",
    crit: "border-crit/40 bg-crit/[0.08] text-crit",
  }[tone];
  return (
    <div className={`rounded-panel border p-card shadow-sm ${toneClass}`}>
      <div className="text-micro font-semibold uppercase tracking-wider opacity-75">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function WorkspaceSection({ workspace }: { workspace: WorkspaceDashboardGroup }) {
  const tone = statusTone(workspace.stats);
  const donePct = completionPercent(workspace.stats);

  return (
    <article className="rounded-panel border border-line bg-panel p-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold tracking-tight">{workspace.name}</h2>
            <span className="rounded-full border border-line bg-panel-soft px-2 py-0.5 text-micro uppercase tracking-wider text-text-muted">
              {workspace.type}
            </span>
          </div>
          <div className="text-caption text-text-muted">/{workspace.slug}</div>
          {workspace.description ? (
            <p className="mt-2 max-w-3xl text-caption text-text-muted">{workspace.description}</p>
          ) : null}
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-nano font-semibold uppercase tracking-wider ${tone.className}`}>
          {tone.label}
        </span>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="space-y-3 rounded-panel border border-line bg-panel-soft p-4">
          <div>
            <div className="mb-1 flex items-center justify-between text-caption text-text-muted">
              <span>Workspace progress</span>
              <span className="tabular-nums">{donePct}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-bg">
              <div className="h-full rounded-full bg-accent" style={{ width: `${donePct}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 text-center text-caption">
            <StatPill label="Projects" value={workspace.projects.length} />
            <StatPill label="Epics" value={totalEpics(workspace.stats)} />
            <StatPill label="Active" value={activeTasks(workspace.stats)} />
            <StatPill label="Blocked" value={workspace.stats.blocked} />
          </div>
          <p className="text-micro text-text-muted">{formatRecent(workspace.stats.recentActivityAt)}</p>
        </div>

        {workspace.projects.length === 0 ? (
          <p className="rounded-panel border border-dashed border-line p-6 text-center text-body text-text-muted">
            No active projects in this workspace.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-card lg:grid-cols-2 2xl:grid-cols-3">
            {workspace.projects.map((project) => (
              <ProjectCard key={project.project.id} project={project.project} stats={project.stats} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function ProjectCard({ project, stats }: { project: ProjectRow; stats: ProjectDashboardStats }) {
  const donePct = completionPercent(stats);
  const active = activeTasks(stats);
  const total = totalTasks(stats);
  const tone = statusTone(stats);

  return (
    <article className="flex min-h-full flex-col rounded-panel border border-line bg-panel p-card shadow-sm transition hover:border-accent hover:shadow-md">
      <Link href={`/projects/${project.slug}`} className="group min-w-0">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold tracking-tight group-hover:text-accent">
              {project.name}
            </h2>
            <div className="text-caption text-text-muted">/{project.slug}</div>
          </div>
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-nano font-semibold uppercase tracking-wider ${tone.className}`}>
            {tone.label}
          </span>
        </div>
        {project.description ? (
          <p className="mt-2 line-clamp-2 text-caption text-text-muted">
            {project.description}
          </p>
        ) : null}
      </Link>

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between text-caption text-text-muted">
            <span>Task progress</span>
            <span className="tabular-nums">{donePct}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-bg">
            <div className="h-full rounded-full bg-accent" style={{ width: `${donePct}%` }} />
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2 text-center text-caption">
          <StatPill label="Active" value={active} />
          <StatPill label="Review" value={stats.task.Review} />
          <StatPill label="Blocked" value={stats.blocked} />
          <StatPill label="Done" value={stats.task.Done} />
        </div>

        <div className="grid grid-cols-3 gap-2 text-center text-caption">
          <StatPill label="Epics" value={totalEpics(stats)} />
          <StatPill label="Open" value={stats.epic.Open} />
          <StatPill label="Tasks" value={total} />
        </div>
      </div>

      <dl className="mt-4 space-y-1 text-micro text-text-muted">
        <div className="flex gap-2">
          <dt className="shrink-0 uppercase tracking-wider">Recent</dt>
          <dd className="truncate">{formatRecent(stats.recentActivityAt)}</dd>
        </div>
        {project.repositoryPath ? (
          <div className="flex gap-2">
            <dt className="shrink-0 uppercase tracking-wider">Repo</dt>
            <dd className="truncate font-mono" title={project.repositoryPath}>
              {project.repositoryPath}
            </dd>
          </div>
        ) : null}
        {project.defaultGitUserName || project.defaultGitUserEmail ? (
          <div className="flex gap-2">
            <dt className="shrink-0 uppercase tracking-wider">Git</dt>
            <dd className="truncate">
              {project.defaultGitUserName ?? ""}
              {project.defaultGitUserEmail ? ` <${project.defaultGitUserEmail}>` : ""}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="mt-auto flex flex-wrap gap-2 pt-4 text-caption">
        <Link href={`/projects/${project.slug}`} className="rounded-lg border border-line px-3 py-1.5 text-text-muted hover:border-accent hover:text-accent">
          Board
        </Link>
        <Link href={`/projects/${project.slug}/tasks`} className="rounded-lg border border-line px-3 py-1.5 text-text-muted hover:border-accent hover:text-accent">
          Tasks
        </Link>
        <Link href={`/projects/${project.slug}/epics`} className="rounded-lg border border-line px-3 py-1.5 text-text-muted hover:border-accent hover:text-accent">
          Epics
        </Link>
        <Link href={`/projects/${project.slug}/activity`} className="rounded-lg border border-line px-3 py-1.5 text-text-muted hover:border-accent hover:text-accent">
          Activity
        </Link>
      </div>
    </article>
  );
}

function StatPill({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-line bg-panel-soft px-2 py-1">
      <div className="font-semibold tabular-nums text-text">{value}</div>
      <div className="text-micro uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}
