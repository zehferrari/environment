import { notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  checkStatusTransition,
  type ActorKind,
  type WorkflowErrorCode,
} from "@/lib/workflow";
import { reorderTasks } from "@/lib/tasks/reorder";
import { listAssignablePrincipals } from "@/lib/principals";
import { binTask } from "@/lib/bin/actions";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { sendTaskWorkflowNotification } from "@/lib/agents/task-workflow-notifications";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { revalidateTaskShell } from "@/lib/tasks/cache";
import Board from "./board-client";
import AddTaskFab from "./add-task-fab";
import { COLUMNS, COLUMN_IDS } from "./columns";

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

function serializeActor(actor: ActorRow | null) {
  if (!actor) return null;
  return {
    id: actor.id,
    username: actor.username,
    kind: actor.kind,
    name: actor.name,
    avatarUpdatedAt: actor.avatarUpdatedAt?.toISOString() ?? null,
    agent: actor.agent,
  };
}

type SerializedActor = NonNullable<ReturnType<typeof serializeActor>>;
type TaskActivityActorRow = {
  taskId: string | null;
  kind: string;
  user: ActorRow | null;
};

function buildTaskActivityActorMaps(rows: TaskActivityActorRow[]) {
  const createdBy = new Map<string, SerializedActor>();
  const updatedBy = new Map<string, SerializedActor>();

  for (const row of rows) {
    if (!row.taskId || !row.user) continue;
    const actor = serializeActor(row.user);
    if (!actor) continue;
    if (!updatedBy.has(row.taskId)) updatedBy.set(row.taskId, actor);
    if (row.kind === "task.create" && !createdBy.has(row.taskId)) {
      createdBy.set(row.taskId, actor);
    }
  }

  return { createdBy, updatedBy };
}

async function requireActor(): Promise<{ id: string; kind: ActorKind }> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) throw new Error("Unauthenticated");
  const kind: ActorKind = session.user?.kind === "agent" ? "agent" : "human";
  return { id, kind };
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
  const assigneeRaw = String(formData.get("assigneeId") ?? "");
  const reviewerRaw = String(formData.get("actingManagerId") ?? "");

  const maxRank = await db.task.aggregate({
    where: { projectId, status: "Backlog", archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });

  // Epic combobox: scope the chosen epic to this project; ignore anything
  // that isn't a live epic here.
  let epicId: string | null = epicRaw === "" ? null : epicRaw;
  let epicDefaults: { branchName: string | null; commitPrefix: string | null } | null = null;
  if (epicId) {
    const epic = await db.epic.findFirst({
      where: { id: epicId, projectId, archivedAt: null, deletedAt: null },
      select: { id: true, branchName: true, commitPrefix: true },
    });
    if (!epic) epicId = null;
    else epicDefaults = epic;
  }
  const taskTitle = epicId ? await nextEpicTaskTitle(epicId, title) : title;

  // Assignee / reviewer come pre-selected (to the project defaults) from
  // the modal, so the submitted value is authoritative. Empty = unset.
  const assigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const actingManagerId = reviewerRaw === "" ? null : reviewerRaw;

  const task = await db.task.create({
    data: {
      projectId,
      workItemKey: await allocateWorkItemKey(projectId),
      title: taskTitle,
      description,
      status: "Backlog",
      rank: (maxRank._max.rank ?? 0) + 1,
      statusChangedAt: new Date(),
      epicId,
      assigneeId,
      actingManagerId,
      reporterId: actor.id,
      branchName: epicDefaults?.branchName ?? null,
      commitPrefix: epicDefaults?.commitPrefix ?? null,
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
        "Read the full task context and existing comments. Post one concise technical implementation plan in Action Plan.",
        "Do not change task status and do not start work until the task is moved to To Do.",
      ].join("\n"),
    });
  }
  if (actingManagerId) {
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: actingManagerId,
      actor,
      reason: "reviewer_plan_requested",
      body: [
        `You have been set as Reviewer for "${task.title}".`,
        "If the task has no assignee, read the full task context and post one reviewer plan of action in Action Plan, including the subtasks/topics/items that must be addressed or watched.",
        "Do not start implementation or move status. After the reporter approves the plan, call action=assign_after_plan_approval so PM can assign an eligible coding agent and move Backlog to To Do if needed.",
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
  const current = await db.task.findUnique({
    where: { id: taskId },
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
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!current || current.deletedAt) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  }
  if (current.status === status) return { ok: true };

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

  if (current.status === "Review" && status === "Done") {
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
    if (completion.nextTask) {
      revalidateTaskShell(completion.nextTask.id);
      revalidatePath(`/projects/${slug}/tasks/${completion.nextTask.id}`);
    }
    publishBoardTouch(current.projectId);
    return { ok: true };
  }

  const maxRank = await db.task.aggregate({
    where: { status, archivedAt: null, deletedAt: null },
    _max: { rank: true },
  });
  await db.$transaction([
    db.task.update({
      where: { id: taskId },
      data: {
        status,
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: new Date(),
      },
    }),
    db.activityLog.create({
      data: {
        projectId: current.projectId,
        taskId,
        userId: actor.id,
        kind: "task.move",
        payload: JSON.stringify({ from: current.status, to: status }),
      },
    }),
  ]);
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
  if (status === "Review") {
    const reviewerId = resolveReviewOwnerId(current);
    if (reviewerId) {
      await sendTaskWorkflowNotification({
        taskId,
        targetUserId: reviewerId,
        actor,
        reason: "review_requested",
        body: [
          `Task "${current.title}" was moved to Review.`,
          "Review the completed work and full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, leave concise feedback while keeping it in Review.",
        ].join("\n"),
      });
    }
  }
  revalidateTaskShell(taskId);
  revalidatePath(`/projects/${slug}`);
  publishBoardTouch(current.projectId);
  return { ok: true };
}

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const project = await db.project.findUnique({
    where: { slug, deletedAt: null },
    include: {
      tasks: {
        where: { deletedAt: null, archivedAt: null, parentTaskId: null },
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
        },
      },
    },
  });
  if (!project) notFound();

  // Data for the New Task modal: principals for assignee/reviewer pickers,
  // live epics for the Epic combobox.
  const filteredTaskIds = project.tasks.map((task) => task.id);
  const [principals, epicOptions, taskActivityRows, busyAgentSlugs] = await Promise.all([
    listAssignablePrincipals(),
    db.epic.findMany({
      where: { projectId: project.id, archivedAt: null, deletedAt: null },
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
            user: { select: actorSelect },
          },
        })
      : Promise.resolve([]),
    readBusyAgentSlugs(),
  ]);
  const taskActivityActors = buildTaskActivityActorMaps(taskActivityRows);

  const projectId = project.id;
  async function reorderBoardTasks(orderedIds: string[]): Promise<void> {
    "use server";
    await reorderTasks(orderedIds);
    for (const id of orderedIds) revalidateTaskShell(id);
    revalidatePath(`/projects/${slug}`);
    publishBoardTouch(projectId);
  }

  return (
    <div>
      <Board
        projectSlug={project.slug}
        columns={COLUMNS}
        tasks={project.tasks.map((t) => ({
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
          reporter: serializeActor(t.reporter),
          assignee: serializeActor(t.assignee),
          reviewer: serializeActor(t.actingManager),
          manager: serializeActor(t.epic?.actingManager ?? null),
          createdBy: taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter),
          updatedBy: taskActivityActors.updatedBy.get(t.id) ?? taskActivityActors.createdBy.get(t.id) ?? serializeActor(t.reporter),
          epicTitle: t.epic?.title ?? null,
          // An agent is actively working on this task when it is In Progress
          // and its assignee is a currently-busy agent (live snapshot).
          activeWorking:
            t.status === "In Progress" &&
            Boolean(t.assignee?.agent?.slug && busyAgentSlugs.has(t.assignee.agent.slug)),
        }))}
        moveTaskAction={moveTask}
        reorderTasksAction={reorderBoardTasks}
        deleteTaskAction={binTask}
      />

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
        defaultAssigneeId={project.defaultAssigneeId}
        defaultReviewerId={project.defaultReviewerId}
        createTaskAction={createTask}
      />
    </div>
  );
}
