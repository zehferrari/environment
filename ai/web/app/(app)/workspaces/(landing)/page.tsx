import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { binTask } from "@/lib/bin/actions";
import { activeFormalBlockersByTask } from "@/lib/tasks/formal-blocker";
import { createWorkspace, restoreWorkspace } from "@/lib/workspaces/service";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";
import { uploadAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import Board from "../../projects/[slug]/board-client";
import { COLUMNS } from "../../projects/[slug]/columns";
import {
  accessibleProjectWhere,
  accessibleTaskWhere,
  requireOwner,
  requireViewer,
  workspaceAccessWhere,
  type Viewer,
} from "@/lib/auth/permissions";
import {
  getActorVisibility,
  serializeVisibleActor,
  serializeVisibleActorAs,
  type ActorVisibility,
} from "@/lib/users/actor-visibility";
import { LANDING_CHROME_SCOPE } from "./landing-chrome";

type ActorRow = {
  id: string;
  username: string;
  kind: string;
  name: string | null;
  avatarUpdatedAt: Date | null;
  agent: { slug: string; name: string; avatar: string | null } | null;
};

const actorSelect = {
  id: true,
  username: true,
  kind: true,
  name: true,
  avatarUpdatedAt: true,
  agent: { select: { slug: true, name: true, avatar: true } },
};

async function readBusyAgentSlugs(): Promise<Set<string>> {
  try {
    const res = await fetch("http://127.0.0.1:3013/agents/snapshot", {
      cache: "no-store",
      next: { revalidate: 0 },
    });
    if (!res.ok) return new Set();
    const snapshot = (await res.json()) as {
      agents?: Record<string, { busy_state?: { is_busy?: boolean } | null }>;
    };
    const busy = new Set<string>();
    for (const [slug, agent] of Object.entries(snapshot.agents ?? {})) {
      if (agent?.busy_state?.is_busy) busy.add(slug);
    }
    return busy;
  } catch {
    return new Set();
  }
}

function serializeActor(actor: ActorRow | null, visibility: ActorVisibility) {
  return serializeVisibleActor(actor, visibility);
}

type SerializedActor = NonNullable<ReturnType<typeof serializeActor>>;
type TaskActivityActorRow = {
  taskId: string | null;
  kind: string;
  user: ActorRow | null;
};

function buildTaskActivityActorMaps(rows: TaskActivityActorRow[], visibility: ActorVisibility) {
  const createdBy = new Map<string, SerializedActor>();
  const updatedBy = new Map<string, SerializedActor>();

  for (const row of rows) {
    if (!row.taskId || !row.user) continue;
    const actor = serializeActor(row.user, visibility);
    if (!actor) continue;
    if (!updatedBy.has(row.taskId)) updatedBy.set(row.taskId, actor);
    if (row.kind === "task.create" && !createdBy.has(row.taskId)) {
      createdBy.set(row.taskId, actor);
    }
  }

  return { createdBy, updatedBy };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

async function createWorkspaceAction(formData: FormData) {
  "use server";
  await requireOwner();
  const workspace = await createWorkspace({
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    type: String(formData.get("type") ?? "internal"),
    description: String(formData.get("description") ?? ""),
  });
  revalidatePath("/workspaces");
  redirect(`/workspaces/${workspace.slug}/settings`);
}

async function restoreWorkspaceAction(formData: FormData) {
  "use server";
  await requireOwner();
  const slug = String(formData.get("slug") ?? "");
  await restoreWorkspace(slug);
  revalidatePath("/workspaces");
  revalidatePath(`/workspaces/${slug}`);
  revalidatePath(`/workspaces/${slug}/settings`);
}

export const dynamic = "force-dynamic";

export default async function WorkspacesLandingPage({ searchParams }: { searchParams?: Promise<{ archived?: string }> }) {
  const params = await searchParams;
  const showingArchived = params?.archived === "1";
  const viewer = await requireViewer();

  if (showingArchived) {
    return <ArchivedWorkspaces viewer={viewer} restoreAction={restoreWorkspaceAction} />;
  }

  // Every accessible active workspace with its accessible active projects.
  // A project may sit in several workspaces; the first workspace in display
  // order owns the card's "workspace / project" label.
  const workspaces = await db.workspace.findMany({
    where: { AND: [{ archivedAt: null }, workspaceAccessWhere(viewer)] },
    orderBy: [{ type: "asc" }, { name: "asc" }],
    include: {
      projects: {
        where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
        include: { project: { select: { id: true, slug: true, name: true, backgroundColor: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const workspaceColorById = new Map<string, string | null>();
  for (const workspace of workspaces) {
    for (const { project } of workspace.projects) {
      if (!workspaceColorById.has(project.id)) {
        workspaceColorById.set(project.id, workspace.borderColor);
      }
    }
  }

  const projectById = new Map<string, { id: string; slug: string; name: string; backgroundColor: string | null; workspace: { slug: string; name: string } }>();
  for (const workspace of workspaces) {
    for (const { project } of workspace.projects) {
      if (!projectById.has(project.id)) {
        projectById.set(project.id, {
          ...project,
          workspace: { slug: workspace.slug, name: workspace.name },
        });
      }
    }
  }

  const projects = [...projectById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const projectIds = projects.map((project) => project.id);

  const tasks = projectIds.length > 0
    ? await db.task.findMany({
        where: accessibleTaskWhere(viewer, { projectId: { in: projectIds }, deletedAt: null, archivedAt: null, parentTaskId: null }),
        orderBy: [{ status: "asc" }, { rank: "asc" }],
        include: {
          project: { select: { slug: true, name: true } },
          reporter: { select: actorSelect },
          assignee: { select: actorSelect },
          actingManager: { select: actorSelect },
          epic: {
            select: {
              title: true,
              deploymentStatus: true,
              actingManager: { select: actorSelect },
            },
          },
          checklist: { select: { completedAt: true, minutesSpent: true, kind: true } },
          // ENV-123 — drives the board's execution badge. Only the state word
          // is needed here; the full four-line strip lives on the task page.
          executionState: { select: { state: true, reasonDetail: true } },
          blockedBy: { select: { status: true } },
          dependencies: {
            select: { prerequisite: { select: { id: true, status: true } } },
          },
        },
      })
    : [];

  const taskIds = tasks.map((task) => task.id);
  const blockerIds = tasks
    .flatMap((task) => [task.blockedById, ...task.dependencies.map((edge) => edge.prerequisite.id)])
    .filter((id): id is string => Boolean(id));
  const [taskActivityRows, busyAgentSlugs, actorVisibility, visibleBlockers, legacyBlockerComments] = await Promise.all([
    taskIds.length > 0
      ? db.activityLog.findMany({
          where: { taskId: { in: taskIds } },
          orderBy: { createdAt: "desc" },
          select: { taskId: true, kind: true, payload: true, createdAt: true, user: { select: actorSelect } },
        })
      : Promise.resolve([]),
    viewer.isOwner ? readBusyAgentSlugs() : Promise.resolve(new Set<string>()),
    getActorVisibility(viewer),
    blockerIds.length > 0
      ? db.task.findMany({
          where: accessibleTaskWhere(viewer, { id: { in: blockerIds } }),
          select: { id: true, workItemKey: true, status: true },
        })
      : Promise.resolve([]),
    taskIds.length > 0
      ? db.comment.findMany({
          where: {
            taskId: { in: taskIds },
            deletedAt: null,
            body: { startsWith: "**Blocker raised**" },
          },
          select: { id: true, taskId: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);
  const taskActivityActors = buildTaskActivityActorMaps(taskActivityRows, actorVisibility);
  const activeFormalBlockers = activeFormalBlockersByTask(taskActivityRows, legacyBlockerComments);
  const visibleBlockerById = new Map(visibleBlockers.map((task) => [task.id, task]));

  return (
    // data-board-focus-root scopes the sidebar's hover-to-highlight effect
    // (desktop landing only) to this board's cards.
    <div data-board-focus-root>
      {workspaces.length === 0 ? (
        <div className="rounded-panel border border-dashed border-line bg-panel p-card text-body text-text-muted">
          No active workspaces yet. Use the (+) button to create one, then manage projects, boards, and agents here.
        </div>
      ) : (
        <Board
          projectSlug="workspaces"
          chromeSlotScope={LANDING_CHROME_SCOPE}
          boardStreamUrl="/api/workspaces/board/stream"
          columns={COLUMNS}
          tasks={tasks.map((t) => {
            const unresolvedIds = [...new Set([
              ...(t.blockedById && t.blockedBy?.status !== "Done" ? [t.blockedById] : []),
              ...t.dependencies.filter((edge) => edge.prerequisite.status !== "Done").map((edge) => edge.prerequisite.id),
            ])];
            const blockedByKeys = unresolvedIds.map((id) => visibleBlockerById.get(id)?.workItemKey ?? "another task");
            const project = projectById.get(t.projectId) ?? null;
            return {
              id: t.id,
              workItemKey: t.workItemKey ?? null,
              title: t.title,
              status: t.status,
              rank: t.rank,
              createdAt: t.createdAt.toISOString(),
              updatedAt: t.updatedAt.toISOString(),
              statusChangedAt: t.statusChangedAt?.toISOString() ?? null,
              approvedOn: t.approvedOn?.toISOString() ?? null,
              deploymentStatus: t.epic?.deploymentStatus ?? t.deploymentStatus,
              epicId: t.epicId,
              reporter: serializeActor(t.reporter, actorVisibility),
              // Role-driven non-owner board identity (see project board page).
              assignee: serializeVisibleActorAs(t.assignee, "assignee", actorVisibility),
              reviewer: serializeVisibleActorAs(t.actingManager, "reviewer", actorVisibility),
              manager: serializeVisibleActorAs(t.epic?.actingManager ?? null, "reviewer", actorVisibility),
              createdBy: taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter, actorVisibility),
              updatedBy: taskActivityActors.updatedBy.get(t.id) ?? taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter, actorVisibility),
              epicTitle: t.epic?.title ?? null,
              subtaskImplTotal: t.checklist.filter((c) => c.kind !== "review").length,
              subtaskImplDone: t.checklist.filter((c) => c.kind !== "review" && c.completedAt !== null).length,
              subtaskReviewTotal: t.checklist.filter((c) => c.kind === "review").length,
              subtaskReviewDone: t.checklist.filter((c) => c.kind === "review" && c.completedAt !== null).length,
              subtaskMinutes: t.checklist.reduce((sum, c) => sum + (c.minutesSpent ?? 0), 0),
              blockedByKeys,
              hasActiveBlocker: activeFormalBlockers.has(t.id),
            executionState: t.executionState?.state ?? null,
            executionReason: t.executionState?.reasonDetail ?? null,
              activeBlockerCommentId: activeFormalBlockers.get(t.id)?.commentId ?? null,
              activeWorking:
                (t.status === "In Progress" && Boolean(t.assignee?.agent?.slug && busyAgentSlugs.has(t.assignee.agent.slug))) ||
                (t.status === "Review" && Boolean(t.actingManager?.agent?.slug && busyAgentSlugs.has(t.actingManager.agent.slug))),
              project: {
                slug: t.project.slug,
                name: t.project.name,
                workspace: project?.workspace ?? null,
              },
              workspaceColor: workspaceColorById.get(t.projectId) ?? null,
              projectColor: project?.backgroundColor ?? null,
            };
          })}
          deleteTaskAction={binTask}
        />
      )}
    </div>
  );
}

async function ArchivedWorkspaces({
  viewer,
  restoreAction,
}: {
  viewer: Viewer;
  restoreAction: (formData: FormData) => Promise<void>;
}) {
  const workspaces = await db.workspace.findMany({
    where: { AND: [{ archivedAt: { not: null } }, workspaceAccessWhere(viewer)] },
    orderBy: [{ archivedAt: "desc" }, { name: "asc" }],
    include: {
      projects: { where: { project: accessibleProjectWhere(viewer) }, select: { projectId: true } },
      agentPool: { select: { agentId: true } },
    },
  });

  if (workspaces.length === 0) {
    return (
      <div className="rounded-panel border border-dashed border-line bg-panel p-card text-body text-text-muted">
        No archived workspaces. Archived workspaces will appear here for restore.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-card sm:grid-cols-2 xl:grid-cols-3">
      {workspaces.map((workspace) => {
        const logoUrl = workspace.logoPath ? workspaceLogoPublicUrl(workspace.slug, workspace.logoUpdatedAt) : null;
        return (
          <div
            key={workspace.id}
            className="group flex min-h-48 flex-col gap-4 rounded-panel border border-line bg-panel p-card shadow-sm transition hover:border-accent hover:shadow-md"
          >
            <Link href={`/workspaces/${workspace.slug}`} className="flex flex-1 flex-col gap-4">
              <div className="flex items-start gap-3">
                <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-2xl border border-line bg-panel-soft text-base font-semibold uppercase text-text">
                  {logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    workspace.name.slice(0, 1)
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-base font-semibold tracking-tight group-hover:text-accent">
                    {workspace.name}
                  </div>
                  <div className="truncate text-caption text-text-muted">/{workspace.slug}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span className="inline-flex rounded-full bg-accent-soft px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-accent">
                      {workspace.type}
                    </span>
                    <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-nano font-semibold uppercase tracking-wider text-amber-700">
                      Archived
                    </span>
                  </div>
                </div>
              </div>
              {workspace.description ? (
                <p className="line-clamp-3 text-caption text-text-muted">{workspace.description}</p>
              ) : null}
              <dl className="mt-auto grid grid-cols-2 gap-2 text-caption text-text-muted">
                <div className="rounded-xl border border-line bg-bg px-3 py-2">
                  <dt className="text-nano uppercase tracking-wider">Projects</dt>
                  <dd className="text-body font-semibold text-text">{workspace.projects.length}</dd>
                </div>
                {viewer.isOwner ? (
                  <div className="rounded-xl border border-line bg-bg px-3 py-2">
                    <dt className="text-nano uppercase tracking-wider">Agent pool</dt>
                    <dd className="text-body font-semibold text-text">{workspace.agentPool.length}</dd>
                  </div>
                ) : null}
              </dl>
            </Link>
            {viewer.isOwner ? (
              <form action={restoreAction}>
                <input type="hidden" name="slug" value={workspace.slug} />
                <button type="submit" className="w-full rounded-lg border border-line bg-bg px-control-x py-control-y text-caption font-medium text-text-muted hover:border-accent hover:text-accent">
                  Restore workspace
                </button>
              </form>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
