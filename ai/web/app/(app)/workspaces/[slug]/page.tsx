import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { checkStatusTransition, type WorkflowErrorCode } from "@/lib/workflow";
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
import { activeFormalBlockersByTask } from "@/lib/tasks/formal-blocker";
import {
  transitionTask,
  type TaskTransitionIntent,
  type TaskWorkflowStatus,
  type WorkflowEffect,
} from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import { normalizeWorkspaceSlug } from "@/lib/workspaces/service";
import Board from "../../projects/[slug]/board-client";
import { COLUMNS, COLUMN_IDS } from "../../projects/[slug]/columns";
import type { MoveTaskResult } from "../../projects/[slug]/page";
import type { MoveTaskOptions } from "@/lib/tasks/move-status";
import {
  accessibleProjectWhere,
  accessibleTaskWhere,
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

async function requireActor(): Promise<Viewer> {
  return requireViewer();
}

async function moveTask(
  taskId: string,
  status: string,
  workspaceSlug: string,
  options?: MoveTaskOptions,
): Promise<MoveTaskResult> {
  "use server";
  const actor = await requireActor();
  if (!COLUMN_IDS.includes(status)) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: `Unknown column: ${status}` };
  }
  const current = await db.task.findFirst({
    where: accessibleTaskWhere(actor, { id: taskId }),
    select: {
      id: true,
      title: true,
      status: true,
      workflowVersion: true,
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
      workspace: { slug: workspaceSlug, AND: [workspaceAccessWhere(actor)] },
    },
    select: { id: true },
  });
  if (!workspaceProject) return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  if (current.status === status) return { ok: true };

  // Operator override — same admin-only break-glass contract as the project
  // board (lib/tasks/move-status.ts): kernel CAS + audited "operator_override"
  // intent, skipping all gates and side effects beyond a board repaint.
  if (options?.operatorOverride) {
    if (actor.kind !== "human" || !actor.isOwner) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Operator override is restricted to the human operator (admin).",
      };
    }
    await transitionTask({
      taskId,
      projectId: current.projectId,
      actorUserId: actor.id,
      intent: "operator_override",
      from: current.status as TaskWorkflowStatus,
      to: status as TaskWorkflowStatus,
      source: "human-workspace-board-move",
      idempotencyKey: `workspace-board-override:${actor.id}:v${current.workflowVersion + 1}:${status}`,
      expectedVersion: current.workflowVersion,
      evidence: { operatorOverride: true },
      effects: [{ type: "board_touch", key: "board:operator_override", payload: {} }],
    });
    await drainWorkflowOutbox({ limit: 1 }).catch(() => {});
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${current.project.slug}`);
    revalidatePath(`/workspaces/${workspaceSlug}`);
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

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
  if (status === "In Progress" && !current.approvedOn) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Action Plan must be approved before this task can move to In Progress.",
    };
  }
  if (status === "In Progress") {
    if (!current.assigneeId) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Assign an implementation owner before moving this task to In Progress.",
      };
    }
    try {
      await ensureTaskCodeWorktree(current.id, current.assigneeId);
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
    revalidatePath(`/workspaces/${workspaceSlug}`);
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
    revalidatePath(`/workspaces/${workspaceSlug}`);
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  const edge = `${current.status}->${status}`;
  const intentByEdge: Record<string, TaskTransitionIntent> = {
    "Backlog->To Do": "triage",
    "To Do->In Progress": "start",
    "In Progress->To Do": "queue",
    "Review->To Do": "request_changes",
    "Done->To Do": "reopen",
    "To Do->Backlog": "cancel",
    "In Progress->Backlog": "cancel",
    "Review->Backlog": "cancel",
  };
  const intent = intentByEdge[edge];
  if (!intent) {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: `The ${edge} edge requires a dedicated workflow action; board drag cannot override it.`,
    };
  }
  const effects: WorkflowEffect[] = [{ type: "board_touch", key: `board:${intent}`, payload: {} }];
  if (status === "To Do" && current.assigneeId) {
    const approved = Boolean(current.approvedOn);
    effects.push({
      type: "task_notification",
      key: `todo-start-required:${current.assigneeId}`,
      payload: {
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
              "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. Plain chat text is discussion only.",
              "Do not move it to In Progress until approved_on is set.",
            ].join("\n"),
      },
    });
  }
  await transitionTask({
    taskId,
    projectId: current.projectId,
    actorUserId: actor.id,
    intent,
    from: current.status as TaskWorkflowStatus,
    to: status as TaskWorkflowStatus,
    source: actor.kind === "human" ? "human-workspace-board-move" : "agent-workspace-board-move",
    idempotencyKey: `workspace-board:${actor.id}:v${current.workflowVersion + 1}:${status}`,
    expectedVersion: current.workflowVersion,
    rank: current.status === "Review" && status === "To Do" ? "front" : "back",
    effects,
    mutate: async ({ tx }) => {
      await syncEpicOnHumanTaskStatus(tx, {
        epicId: current.epicId,
        projectId: current.projectId,
        taskId,
        actorId: actor.id,
        actorKind: actor.kind,
        targetStatus: status,
        via: "human-board-move",
      });
      if (status === "In Progress" && current.epicId) {
        await promoteEpicOnTaskInProgress(tx, {
          epicId: current.epicId,
          projectId: current.projectId,
          actorId: actor.id,
          via: "board_move",
        });
      }
    },
  });
  await drainWorkflowOutbox({ limit: effects.length }).catch(() => {});
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
  revalidatePath(`/workspaces/${workspaceSlug}`);
  publishBoardTouch(current.projectId);
  return { ok: true };
}

export const dynamic = "force-dynamic";

export default async function WorkspaceBoardPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = await requireViewer();
  const { slug: rawSlug } = await params;
  let slug: string;
  try {
    slug = normalizeWorkspaceSlug(rawSlug);
  } catch {
    notFound();
  }

  const workspace = await db.workspace.findFirst({
    where: { AND: [{ slug }, workspaceAccessWhere(viewer)] },
    include: {
      projects: {
        where: { project: accessibleProjectWhere(viewer, { deletedAt: null, archivedAt: null }) },
        include: { project: { select: { id: true, slug: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!workspace) notFound();
  const workspaceId = workspace.id;

  const projectIds = workspace.projects.map(({ project }) => project.id);
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
        },
      })
    : [];

  const taskIds = tasks.map((task) => task.id);
  const blockerIds = tasks
    .map((task) => task.blockedById)
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

  async function reorderWorkspaceTasks(orderedIds: string[]): Promise<void> {
    "use server";
    const actor = await requireViewer();
    const ids = [...new Set(orderedIds)];
    const allowedWorkspace = await db.workspace.findFirst({
      where: { AND: [{ id: workspaceId }, workspaceAccessWhere(actor)] },
      select: {
        projects: {
          where: { project: accessibleProjectWhere(actor, { deletedAt: null, archivedAt: null }) },
          select: { projectId: true },
        },
      },
    });
    if (!allowedWorkspace) throw new Error("Not authorized");
    const allowedProjectIds = allowedWorkspace.projects.map((row) => row.projectId);
    const visibleCount = await db.task.count({
      where: accessibleTaskWhere(actor, { id: { in: ids }, projectId: { in: allowedProjectIds } }),
    });
    if (visibleCount !== ids.length) throw new Error("Not authorized");
    await Promise.all(ids.map((id) => requireTaskAccess(actor, id)));
    await reorderTasks(ids);
    for (const id of ids) revalidateTaskShell(id);
    revalidatePath(`/workspaces/${slug}`);
  }

  const boardChromeScope = `workspace-${workspace.slug}`;

  return (
    <div>
      <Board
        projectSlug={workspace.slug}
        chromeSlotScope={boardChromeScope}
        boardStreamUrl={`/api/workspaces/${workspace.slug}/board/stream`}
        columns={COLUMNS}
        tasks={tasks.map((t) => {
          const blocker = t.blockedById ? visibleBlockerById.get(t.blockedById) : null;
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
            executionState: t.executionState?.state ?? null,
            executionReason: t.executionState?.reasonDetail ?? null,
            activeBlockerCommentId: activeFormalBlockers.get(t.id)?.commentId ?? null,
            activeWorking:
              (t.status === "In Progress" && Boolean(t.assignee?.agent?.slug && busyAgentSlugs.has(t.assignee.agent.slug))) ||
              (t.status === "Review" && Boolean(t.actingManager?.agent?.slug && busyAgentSlugs.has(t.actingManager.agent.slug))),
            project: { slug: t.project.slug, name: t.project.name },
          };
        })}
        moveTaskAction={moveTask}
        reorderTasksAction={reorderWorkspaceTasks}
        deleteTaskAction={binTask}
        canOperatorOverride={viewer.isOwner}
      />
    </div>
  );
}
