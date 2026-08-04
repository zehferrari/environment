import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { checkStatusTransition } from "@/lib/workflow";
import { reorderTasks } from "@/lib/tasks/reorder";
import { binTask } from "@/lib/bin/actions";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { refillEpicQueue } from "@/lib/epics/queue";
import { runTaskReviewHandoff } from "@/lib/tasks/review-handoff";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { revalidateTaskShell } from "@/lib/tasks/cache";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";
import { activeFormalBlockerTaskIds } from "@/lib/tasks/formal-blocker";
import { createWorkspace, restoreWorkspace } from "@/lib/workspaces/service";
import { workspaceLogoPublicUrl } from "@/lib/workspaces/storage";
import { uploadAttachment } from "@/lib/attachments/actions";
import { attachmentMaxBytes } from "@/lib/attachments/storage";
import Board from "../../projects/[slug]/board-client";
import { COLUMNS, COLUMN_IDS } from "../../projects/[slug]/columns";
import type { MoveTaskResult } from "../../projects/[slug]/page";
import {
  accessibleProjectWhere,
  accessibleTaskWhere,
  requireOwner,
  requireProjectAccess,
  requireTaskAccess,
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

// Landing-board move: identical workflow rules to the per-workspace board,
// but the membership proof accepts any accessible active workspace that
// contains the task's project.
async function moveTask(taskId: string, status: string, _scopeSlug: string): Promise<MoveTaskResult> {
  "use server";
  const actor = await requireViewer();
  if (!COLUMN_IDS.includes(status)) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: `Unknown column: ${status}` };
  }
  const current = await db.task.findFirst({
    where: accessibleTaskWhere(actor, { id: taskId }),
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      deletedAt: true,
      epicId: true,
      repositoryRun: { select: { phase: true } },
      project: { select: { slug: true, onlyReportersCanApproveActionPlans: true, onlyReportersCanSetTasksDone: true } },
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!current || current.deletedAt) return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  await requireProjectAccess(actor, { id: current.projectId });
  const workspaceProject = await db.workspaceProject.findFirst({
    where: {
      projectId: current.projectId,
      workspace: { AND: [{ archivedAt: null }, workspaceAccessWhere(actor)] },
    },
    select: { id: true },
  });
  if (!workspaceProject) return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  if (current.status === status) return { ok: true };
  if (current.repositoryRun?.phase === "finalizing") {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Repository finalization is running; wait for it to complete before changing status.",
    };
  }

  if (actor.kind !== "human") {
    const check = checkStatusTransition({ from: current.status, to: status, actor });
    if (!check.ok) return { ok: false, code: check.code, message: check.message };
  }
  if (actor.kind !== "human" && status === "In Progress" && !current.approvedOn) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Action Plan must be approved before this task can move to In Progress.",
    };
  }
  if (status === "In Progress") {
    try {
      await ensureTaskCodeWorktree(current.id, actor.id);
    } catch (err) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: err instanceof TaskWorktreeError
          ? err.message
          : "Task worktree could not be created or validated.",
      };
    }
  }

  if (current.status === "Review" && status === "Done" && (actor.isOwner || actor.kind === "agent")) {
    const actorUser = await db.user.findUnique({ where: { id: actor.id }, select: { username: true } });
    const completion = await completeReviewedTaskAndAssignNext({
      taskId,
      actor: { id: actor.id, username: actorUser?.username ?? "unknown", kind: actor.kind },
      via: "board-move",
    });
    if (!completion.completed) {
      return { ok: false, code: "EXPLICIT_USER_ACTION_REQUIRED", message: "Could not complete this reviewed task." };
    }
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${current.project.slug}`);
    revalidatePath("/workspaces");
    for (const next of completion.nextTasks ?? []) {
      revalidateTaskShell(next.id);
      revalidatePath(`/projects/${current.project.slug}/tasks/${next.id}`);
    }
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  if (status === "Review") {
    if (current.status !== "In Progress") {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "A task can enter Review only through validation from In Progress.",
      };
    }
    const actorUser = await db.user.findUnique({ where: { id: actor.id }, select: { username: true } });
    const handoff = await runTaskReviewHandoff({
      taskId,
      actor: { id: actor.id, kind: actor.kind, username: actorUser?.username ?? null },
      via: "human-board-move",
      movedFromStatus: current.status,
    });
    for (const assigned of handoff.refillAssignments) {
      revalidateTaskShell(assigned.taskId);
      revalidatePath(`/projects/${current.project.slug}/tasks/${assigned.taskId}`);
    }
    revalidateTaskShell(taskId);
    revalidatePath("/workspaces");
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  // Item 1: a task pulled back from Review to To Do returns to the FRONT of the
  // To Do column (priority for the next assignee pick); every other move appends
  // to the bottom of the target column.
  const toTopOfTodo = current.status === "Review" && status === "To Do";
  let nextRank: number;
  if (toTopOfTodo) {
    const minRank = await db.task.aggregate({
      where: { status: "To Do", archivedAt: null, deletedAt: null },
      _min: { rank: true },
    });
    nextRank = (minRank._min.rank ?? 0) - 1;
  } else {
    const maxRank = await db.task.aggregate({
      where: { status, archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    nextRank = (maxRank._max.rank ?? 0) + 1;
  }
  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: { status, rank: nextRank, statusChangedAt: new Date() },
    }),
    db.activityLog.create({
      data: {
        projectId: current.projectId,
        taskId,
        userId: actor.id,
        kind: "task.move",
        payload: JSON.stringify({
          from: current.status,
          to: status,
          via: actor.kind === "human" ? "human-board-move" : "agent-board-move",
        }),
      },
    }),
  ]);
  await syncEpicOnHumanTaskStatus(db, {
    epicId: current.epicId,
    projectId: current.projectId,
    taskId,
    actorId: actor.id,
    actorKind: actor.kind,
    targetStatus: status,
    via: "human-board-move",
  });
  if (status === "In Progress" && current.epicId) {
    await promoteEpicOnTaskInProgress(db, {
      epicId: current.epicId,
      projectId: current.projectId,
      actorId: actor.id,
      via: "board_move",
    });
  }
  if (status === "To Do" && current.assigneeId) {
    const approved = Boolean(current.approvedOn);
    await sendTaskWorkflowNotification({
      taskId,
      targetUserId: current.assigneeId,
      actor,
      reason: "todo_start_required",
      body: approved
        ? [
            `Task "${current.title}" is now in To Do and assigned to you.`,
            "The Action Plan is approved. Move it to In Progress through the workflow endpoint and start work immediately.",
            "Do not post a visible acknowledgement unless you have new task information to add.",
          ].join("\n")
        : [
            `Task "${current.title}" is now in To Do and assigned to you.`,
            "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
            "Do not move it to In Progress until approved_on is set.",
          ].join("\n"),
    });
  }
  // Proactive queue refill — same trigger as the project board: a human
  // completing a task or parking one unassigned frees capacity now.
  if (
    current.epicId &&
    (status === "Done" || ((status === "To Do" || status === "Backlog") && !current.assigneeId))
  ) {
    const refill = await refillEpicQueue({
      epicId: current.epicId,
      actor,
      via: "board-move",
      contextLine: status === "Done"
        ? `"${current.title}" was completed.`
        : `"${current.title}" was returned to the queue.`,
    });
    for (const assigned of refill.assignments) {
      revalidateTaskShell(assigned.task.id);
      revalidatePath(`/projects/${current.project.slug}/tasks/${assigned.task.id}`);
    }
  }
  revalidateTaskShell(taskId);
  revalidatePath(`/projects/${current.project.slug}`);
  revalidatePath("/workspaces");
  publishBoardTouch(current.projectId);
  return { ok: true };
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
        },
      })
    : [];

  const taskIds = tasks.map((task) => task.id);
  const blockerIds = tasks
    .map((task) => task.blockedById)
    .filter((id): id is string => Boolean(id));
  const [taskActivityRows, busyAgentSlugs, actorVisibility, visibleBlockers] = await Promise.all([
    taskIds.length > 0
      ? db.activityLog.findMany({
          where: { taskId: { in: taskIds } },
          orderBy: { createdAt: "desc" },
          select: { taskId: true, kind: true, user: { select: actorSelect } },
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
  ]);
  const taskActivityActors = buildTaskActivityActorMaps(taskActivityRows, actorVisibility);
  const activeFormalBlockers = activeFormalBlockerTaskIds(taskActivityRows);
  const visibleBlockerById = new Map(visibleBlockers.map((task) => [task.id, task]));

  async function reorderLandingTasks(orderedIds: string[]): Promise<void> {
    "use server";
    const actor = await requireViewer();
    const ids = [...new Set(orderedIds)];
    const allowedProjects = await db.workspaceProject.findMany({
      where: {
        workspace: { AND: [{ archivedAt: null }, workspaceAccessWhere(actor)] },
        project: accessibleProjectWhere(actor, { deletedAt: null, archivedAt: null }),
      },
      select: { projectId: true },
    });
    const allowedProjectIds = [...new Set(allowedProjects.map((row) => row.projectId))];
    const visibleCount = await db.task.count({
      where: accessibleTaskWhere(actor, { id: { in: ids }, projectId: { in: allowedProjectIds } }),
    });
    if (visibleCount !== ids.length) throw new Error("Not authorized");
    await Promise.all(ids.map((id) => requireTaskAccess(actor, id)));
    await reorderTasks(ids);
    for (const id of ids) revalidateTaskShell(id);
    revalidatePath("/workspaces");
  }

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
            const blocker = t.blockedById ? visibleBlockerById.get(t.blockedById) : null;
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
              blockedByKey: blocker && blocker.status !== "Done" ? blocker.workItemKey ?? null : null,
              hasActiveBlocker: activeFormalBlockers.has(t.id),
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
          moveTaskAction={moveTask}
          reorderTasksAction={reorderLandingTasks}
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
