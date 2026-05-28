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
import { resolveDoneTtlDays } from "@/lib/settings/system";
import { binTask } from "@/lib/bin/actions";
import { sendTaskWorkflowNotification } from "@/lib/agents/task-workflow-notifications";
import { resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
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
    where: { projectId, status: "Backlog", deletedAt: null },
    _max: { rank: true },
  });

  // Epic combobox: scope the chosen epic to this project; ignore anything
  // that isn't a live epic here.
  let epicId: string | null = epicRaw === "" ? null : epicRaw;
  let epicDefaults: { branchName: string | null; commitPrefix: string | null } | null = null;
  if (epicId) {
    const epic = await db.epic.findFirst({
      where: { id: epicId, projectId, deletedAt: null },
      select: { id: true, branchName: true, commitPrefix: true },
    });
    if (!epic) epicId = null;
    else epicDefaults = epic;
  }

  // Assignee / reviewer come pre-selected (to the project defaults) from
  // the modal, so the submitted value is authoritative. Empty = unset.
  const assigneeId = assigneeRaw === "" ? null : assigneeRaw;
  const actingManagerId = reviewerRaw === "" ? null : reviewerRaw;

  const task = await db.task.create({
    data: {
      projectId,
      title,
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
        "Read the full task context and existing comments. Post a concise task comment with your implementation plan or opinion.",
        "Do not change task status and do not start work until the task is moved to To Do.",
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
      deletedAt: true,
      epic: { select: { status: true, actingManagerId: true } },
    },
  });
  if (!current || current.deletedAt) {
    return { ok: false, code: "UNKNOWN_COLUMN", message: "Task not found" };
  }
  if (current.status === status) return { ok: true };

  const check = checkStatusTransition({
    from: current.status,
    to: status,
    actor,
  });
  if (!check.ok) {
    return { ok: false, code: check.code, message: check.message };
  }

  const maxRank = await db.task.aggregate({
    where: { status, deletedAt: null },
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
    await sendTaskWorkflowNotification({
      taskId,
      targetUserId: current.assigneeId,
      actor,
      reason: "todo_start_required",
      body: [
        `Task "${current.title}" is now in To Do and assigned to you.`,
        "Read the full task context, move it to In Progress through the workflow endpoint, and start work immediately.",
        "Do not post a visible acknowledgement unless you have new task information to add.",
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
  revalidatePath(`/projects/${slug}`);
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
        where: { deletedAt: null },
        orderBy: [{ status: "asc" }, { rank: "asc" }],
        include: {
          reporter: { select: actorSelect },
          assignee: { select: actorSelect },
          actingManager: { select: actorSelect },
          epic: {
            select: {
              title: true,
              actingManager: { select: actorSelect },
            },
          },
        },
      },
    },
  });
  if (!project) notFound();

  // Done-column TTL filter: keep Done tasks only if statusChangedAt is
  // within doneTtlDays of now. Other columns pass through unchanged.
  // statusChangedAt is null for rows that pre-date the migration; treat
  // null as "recently touched" so legacy Done items aren't auto-hidden.
  const doneTtlDays = await resolveDoneTtlDays(project.doneTtlDays);
  const doneCutoff = new Date(Date.now() - doneTtlDays * 24 * 60 * 60 * 1000);
  const filteredTasks = project.tasks.filter((t) => {
    if (t.status !== "Done") return true;
    if (!t.statusChangedAt) return true;
    return t.statusChangedAt >= doneCutoff;
  });

  // Data for the New Task modal: principals for assignee/reviewer pickers,
  // live epics for the Epic combobox.
  const [principals, epicOptions] = await Promise.all([
    listAssignablePrincipals(),
    db.epic.findMany({
      where: { projectId: project.id, status: { not: "Archive" }, deletedAt: null },
      orderBy: [{ status: "asc" }, { title: "asc" }],
      select: { id: true, title: true },
    }),
  ]);

  async function reorderBoardTasks(orderedIds: string[]): Promise<void> {
    "use server";
    await reorderTasks(orderedIds);
    revalidatePath(`/projects/${slug}`);
  }

  return (
    <div>
      <Board
        projectSlug={project.slug}
        columns={COLUMNS}
        tasks={filteredTasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          rank: t.rank,
          createdAt: t.createdAt.toISOString(),
          updatedAt: t.updatedAt.toISOString(),
          reporter: serializeActor(t.reporter),
          assignee: serializeActor(t.assignee),
          reviewer: serializeActor(t.actingManager),
          manager: serializeActor(t.epic?.actingManager ?? null),
          epicTitle: t.epic?.title ?? null,
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
