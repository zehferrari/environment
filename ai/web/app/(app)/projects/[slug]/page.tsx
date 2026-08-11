import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  checkStatusTransition,
  type WorkflowErrorCode,
} from "@/lib/workflow";
import { reorderTasks } from "@/lib/tasks/reorder";
import { listAssignablePrincipals } from "@/lib/principals";
import { binTask } from "@/lib/bin/actions";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { refillEpicQueue } from "@/lib/epics/queue";
import { runTaskReviewHandoff } from "@/lib/tasks/review-handoff";
import { ensureTaskCodeWorktree, TaskWorktreeError } from "@/lib/tasks/worktree-claim";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { revalidateTaskShell } from "@/lib/tasks/cache";
import { moveTaskStatus } from "@/lib/tasks/move-status";
import { activeFormalBlockersByTask } from "@/lib/tasks/formal-blocker";
import Board from "./board-client";
import AddTaskFab from "./add-task-fab";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { syncEpicOnHumanTaskStatus } from "@/lib/epics/sync-on-human-task-move";
import { COLUMNS, COLUMN_IDS } from "./columns";
import {
  accessibleEpicWhere,
  accessibleTaskWhere,
  assertAgentAssignmentAllowed,
  requireTaskAccess,
  requireProjectAccess,
  requireViewer,
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

// Live agent snapshot (same source the sidebar reads) — used to flag tasks an
// agent is actively working on so the board can show a pulse ring on them.
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

async function createTask(formData: FormData) {
  "use server";
  const actor = await requireActor();
  const projectId = String(formData.get("projectId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  if (!projectId || !title) return;
  if (title.length > 200) return;
  const projectSlug = String(formData.get("projectSlug") ?? "");
  const description = String(formData.get("description") ?? "").trim() || null;
  const epicRaw = String(formData.get("epicId") ?? "");
  if (!actor.isOwner && (
    formData.has("reporterId") ||
    formData.has("assigneeId") ||
    formData.has("actingManagerId")
  )) {
    throw new Error("Only the Mission Control owner can set task roles.");
  }
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const reviewerRaw = String(formData.get("actingManagerId") ?? "");
  if (formData.has("private") && !actor.isOwner) throw new Error("Not authorized");
  const isPrivate = actor.isOwner && formData.get("private") === "on";

  const maxRank = await db.task.aggregate({
    where: { projectId, status: "Backlog", archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });

  // Epic combobox: scope the chosen epic to this project; ignore anything
  // that isn't a live epic here.
  let epicId: string | null = epicRaw === "" ? null : epicRaw;
  if (epicId) {
    const epic = await db.epic.findFirst({
      where: accessibleEpicWhere(actor, { id: epicId, projectId, archivedAt: null, deletedAt: null }),
      select: { id: true },
    });
    if (!epic) epicId = null;
  }
  const taskTitle = epicId ? await nextEpicTaskTitle(epicId, title) : title;

  // Assignee / reviewer come pre-selected (to the project defaults) from
  // the modal, so the submitted value is authoritative. Empty = unset.
  const assigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const actingManagerId = reviewerRaw === "" ? null : reviewerRaw;
  await requireProjectAccess(actor, { id: projectId });
  await assertAgentAssignmentAllowed(actor, [assigneeId, actingManagerId]);

  const task = await db.task.create({
    data: {
      projectId,
      workItemKey: await allocateWorkItemKey(projectId),
      title: taskTitle,
      description,
      private: isPrivate,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      epicId,
      assigneeId,
      actingManagerId,
      reporterId: actor.id,
      // Null means "resolve from the Epic, then the Task work-item key".
      // Do not copy inherited values: later Epic edits must propagate.
      branchName: null,
      commitPrefix: null,
    },
    select: { id: true, title: true },
  });

  await db.activityLog.create({
    data: {
      projectId,
      taskId: task.id,
      userId: actor.id,
      kind: "task.create",
      payload: JSON.stringify({ title: task.title, epicId }),
    },
  });

  if (assigneeId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: assigneeId,
      actor,
      reason: "backlog_plan_requested",
      body: [
        `You have been assigned to "${task.title}" while it is in Backlog.`,
        "Read the full task context and existing comments. Call action=submit_plan with one concise structured technical Action Plan; plain chat text is discussion only.",
        "Do not change task status and do not start work until the task is moved to To Do.",
      ].join("\n"),
    });
  }
  if (actingManagerId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: actingManagerId,
      actor,
      reason: "reviewer_assignment_requested",
      body: [
        `You have been set as Reviewer for "${task.title}".`,
        "If the task has no assignee, call action=assign_task so PM can select an eligible coding agent.",
        "The assignee authors the implementation plan. Review it after submission; do not start implementation yourself.",
      ].join("\n"),
    });
  }

  revalidatePath(`/projects/${projectSlug}`);
}

// Workflow rejections (invalid edge, agent-touches-Review/Done, unknown
// column) are returned as data so the client can roll the optimistic
// move back instead of swallowing a generic thrown Error. Authentication
// failure still throws — that is a true server fault, not a rule
// rejection.
export type MoveTaskResult =
  | { ok: true }
  | { ok: false; code: WorkflowErrorCode | "UNKNOWN_COLUMN"; message: string };

async function moveTask(
  taskId: string,
  status: string,
  slug: string,
): Promise<MoveTaskResult> {
  "use server";
  const actor = await requireActor();
  if (!COLUMN_IDS.includes(status)) {
    return {
      ok: false,
      code: "UNKNOWN_COLUMN",
      message: `Unknown column: ${status}`,
    };
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
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!current || current.deletedAt) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  }
  await requireProjectAccess(actor, { id: current.projectId });
  if (current.status === status) return { ok: true };
  if (current.repositoryRun?.phase === "finalizing") {
    return {
      ok: false,
      code: "EXPLICIT_USER_ACTION_REQUIRED",
      message: "Repository finalization is running; wait for it to complete before changing status.",
    };
  }

  // Browser-session human moves are authoritative. Workflow policy still
  // constrains agent/generic automation paths, but a human board action must
  // persist once the target column is a known PM status.
  if (actor.kind !== "human") {
    const check = checkStatusTransition({
      from: current.status,
      to: status,
      actor,
    });
    if (!check.ok) {
      return { ok: false, code: check.code, message: check.message };
    }
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
    const actorUser = await db.user.findUnique({
      where: { id: actor.id },
      select: { username: true },
    });
    const completion = await completeReviewedTaskAndAssignNext({
      taskId,
      actor: {
        id: actor.id,
        username: actorUser?.username ?? "unknown",
        kind: actor.kind,
      },
      via: "board-move",
    });
    if (!completion.completed) {
      return {
        ok: false,
        code: "EXPLICIT_USER_ACTION_REQUIRED",
        message: "Could not complete this reviewed task.",
      };
    }
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${slug}`);
    for (const next of completion.nextTasks ?? []) {
      revalidateTaskShell(next.id);
      revalidatePath(`/projects/${slug}/tasks/${next.id}`);
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
    const actorUser = await db.user.findUnique({
      where: { id: actor.id },
      select: { username: true },
    });
    const handoff = await runTaskReviewHandoff({
      taskId,
      actor: { id: actor.id, kind: actor.kind, username: actorUser?.username ?? null },
      via: "human-board-move",
      movedFromStatus: current.status,
    });
    for (const assigned of handoff.refillAssignments) {
      revalidatePath(`/projects/${slug}/tasks/${assigned.taskId}`);
    }
    revalidateTaskShell(taskId);
    revalidatePath(`/projects/${slug}`);
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  // This legacy local action is retained only for source compatibility. The
  // rendered board uses moveTaskStatus directly; if another caller reaches
  // this function, it still crosses the same authoritative boundary.
  return moveTaskStatus(taskId, status, slug);
}

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const viewer = await requireViewer();
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    include: {
      tasks: {
        where: accessibleTaskWhere(viewer, { deletedAt: null, archivedAt: null, parentTaskId: null }),
        orderBy: [{ status: "asc" }, { rank: "asc" }],
        include: {
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
      },
    },
  });
  if (!project) notFound();

  // Data for the New Task modal: principals for assignee/reviewer pickers,
  // live epics for the Epic combobox.
  const filteredTaskIds = project.tasks.map((task) => task.id);
  const blockerIds = project.tasks
    .map((task) => task.blockedById)
    .filter((id): id is string => Boolean(id));
  const [principals, epicOptions, taskActivityRows, busyAgentSlugs, actorVisibility, visibleBlockers, legacyBlockerComments] = await Promise.all([
    viewer.isOwner ? listAssignablePrincipals(viewer) : Promise.resolve([]),
    db.epic.findMany({
      where: accessibleEpicWhere(viewer, { projectId: project.id, archivedAt: null, deletedAt: null }),
      orderBy: [{ status: "asc" }, { title: "asc" }],
      select: { id: true, title: true },
    }),
    filteredTaskIds.length > 0
      ? db.activityLog.findMany({
          where: { taskId: { in: filteredTaskIds } },
          orderBy: { createdAt: "desc" },
          select: {
            taskId: true,
            kind: true,
            payload: true,
            createdAt: true,
            user: { select: actorSelect },
          },
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
    filteredTaskIds.length > 0
      ? db.comment.findMany({
          where: {
            taskId: { in: filteredTaskIds },
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

  const projectId = project.id;
  async function reorderBoardTasks(orderedIds: string[]): Promise<void> {
    "use server";
    const actor = await requireViewer();
    await requireProjectAccess(actor, { id: projectId });
    const ids = [...new Set(orderedIds)];
    const taskCount = await db.task.count({
      where: accessibleTaskWhere(actor, { id: { in: ids }, projectId }),
    });
    if (taskCount !== ids.length) throw new Error("Not authorized");
    await Promise.all(ids.map((id) => requireTaskAccess(actor, id)));
    await reorderTasks(ids);
    for (const id of ids) revalidateTaskShell(id);
    revalidatePath(`/projects/${slug}`);
    publishBoardTouch(projectId);
  }

  return (
    <div>
      <Board
        projectSlug={project.slug}
        chromeSlotScope={`project-${project.slug}`}
        columns={COLUMNS}
        tasks={project.tasks.map((t) => {
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
            // Non-owner board identity is role-driven: the assignee slot (To Do /
            // In Progress / Done builder) projects to Owner, while the reviewer
            // slots (task acting-manager, epic acting-manager) project to
            // "Feedback / Review" — or Monitor for a monitor agent.
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
              (t.status === "In Progress" &&
                Boolean(t.assignee?.agent?.slug && busyAgentSlugs.has(t.assignee.agent.slug))) ||
              (t.status === "Review" &&
                Boolean(t.actingManager?.agent?.slug && busyAgentSlugs.has(t.actingManager.agent.slug))),
            project: null,
          };
        })}
        moveTaskAction={moveTaskStatus}
        reorderTasksAction={reorderBoardTasks}
        deleteTaskAction={binTask}
        canOperatorOverride={viewer.isOwner}
        canManageTaskRoles={viewer.isOwner}
        roleOptions={viewer.isOwner ? principals.map((principal) => ({
          value: principal.id,
          label: principal.name,
          actor: {
            id: principal.id,
            username: principal.username,
            kind: principal.kind,
            name: principal.name,
            avatarUpdatedAt: principal.avatarUpdatedAt,
            agent: principal.kind === "agent"
              ? {
                  slug: principal.agentSlug ?? principal.username,
                  name: principal.name,
                  avatar: principal.agentAvatar,
                }
              : null,
          },
        })) : []}
      />

      {/* The shared board (+) speed-dial is the visible FAB; AddTaskFab stays
          mounted (hidden trigger) purely for its New-task modal + the
          ?newTask=1 hand-off the menu routes through. */}
      <AddTaskFab
        projectId={project.id}
        projectSlug={project.slug}
        principals={principals.map((p) => ({
          id: p.id,
          username: p.username,
          name: p.name,
          kind: p.kind,
          avatarUpdatedAt: p.avatarUpdatedAt,
          agentSlug: p.agentSlug,
          agentAvatar: p.agentAvatar,
        }))}
        epics={epicOptions}
        defaultAssigneeId={viewer.isOwner && principals.some((p) => p.id === project.defaultAssigneeId) ? project.defaultAssigneeId : null}
        defaultReviewerId={viewer.isOwner && principals.some((p) => p.id === project.defaultReviewerId) ? project.defaultReviewerId : null}
        canManageAssignments={viewer.isOwner}
        canSetPrivate={viewer.isOwner}
        createTaskAction={createTask}
        hideTrigger
      />
    </div>
  );
}
