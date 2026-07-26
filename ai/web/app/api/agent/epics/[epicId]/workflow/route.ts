import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { recordPmChannelRunWorkflowAction } from "@/lib/agents/pm-channel/runs";
import { verifyEpicWorkflowToken } from "@/lib/agents/workflow/token/epic";
import { assignOpenEpicTasks, promoteEpicBacklogTasks } from "@/lib/epics/assignment";
import { sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { hasAuthorizedEpicAgentOrigin } from "@/lib/agents/owner-origin";
import { nextEpicTaskTitle } from "@/lib/tasks/epic-numbering";
import { allocateWorkItemKey } from "@/lib/work-items/keys";
import { publishBoardTouch } from "@/lib/pm/board-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["advance_queue", "assign_next", "create_tasks"] as const;

type EpicWorkflowAction = (typeof ACTIONS)[number];

function isWorkflowAction(value: unknown): value is EpicWorkflowAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

function cleanText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > max) return null;
  return text;
}

function parseCreateTasks(value: unknown) {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > 20) return null;
  const tasks = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const title = cleanText(record.title, 220);
    if (!title) return [];
    const description = typeof record.description === "string" && record.description.trim()
      ? record.description.trim().slice(0, 8000)
      : null;
    return [{ title, description }];
  });
  return tasks.length === value.length ? tasks : null;
}

async function notifyAssignedTask(args: {
  taskId: string;
  taskTitle: string;
  targetUserId: string;
  actor: { id: string; username: string; kind: "agent" };
  approvedPlan: boolean;
}) {
  await sendTaskWorkflowNotification({
    taskId: args.taskId,
    targetUserId: args.targetUserId,
    actor: args.actor,
    reason: "todo_start_required",
    body: [
      `Epic manager @${args.actor.username} assigned "${args.taskTitle}" to you in To Do.`,
      args.approvedPlan
        ? "Its Action Plan is already approved: move the task to In Progress through the workflow endpoint and start immediately."
        : "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
      "If you have unresolved review feedback on another Review-stage task, address that feedback first; otherwise begin this task now.",
    ].join("\n"),
  });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ epicId: string }> },
) {
  const { epicId } = await ctx.params;
  let payload: {
    messageId?: unknown;
    token?: unknown;
    action?: unknown;
    summary?: unknown;
    tasks?: unknown;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const action = payload.action;
  if (!messageId || !token || !isWorkflowAction(action)) {
    return NextResponse.json(
      { error: "messageId, token, and valid action are required" },
      { status: 400 },
    );
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      epicId: true,
      agentSlug: true,
      targetType: true,
      targetValue: true,
      senderUserId: true,
      sender: { select: { kind: true, status: true } },
    },
  });
  if (!original || original.epicId !== epicId) {
    return NextResponse.json({ error: "Workflow grant message not found" }, { status: 404 });
  }
  const grantAgentSlug =
    original.agentSlug === "room" &&
    original.targetType === "agent" &&
    original.targetValue?.startsWith("agent:")
      ? original.targetValue.slice("agent:".length)
      : original.agentSlug;
  if (!verifyEpicWorkflowToken(messageId, epicId, grantAgentSlug, token)) {
    return NextResponse.json({ error: "Invalid workflow token" }, { status: 403 });
  }
  if (!(await hasAuthorizedEpicAgentOrigin({
    epicId,
    messageId,
    targetAgentSlug: grantAgentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  }))) {
    return NextResponse.json({ error: "Workflow grant is no longer authorized" }, { status: 403 });
  }

  const [agent, epic] = await Promise.all([
    db.agent.findUnique({
      where: { slug: grantAgentSlug },
      select: {
        slug: true,
        deactivatedAt: true,
        user: { select: { id: true, username: true, status: true } },
      },
    }),
    db.epic.findFirst({
      where: { id: epicId, private: false },
      select: {
        id: true,
        title: true,
        status: true,
        projectId: true,
        actingManagerId: true,
        reporterId: true,
        approvedOn: true,
        branchName: true,
        commitPrefix: true,
        deletedAt: true,
        project: { select: { slug: true } },
      },
    }),
  ]);

  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  if (!epic || epic.deletedAt) {
    return NextResponse.json({ error: "Epic not found" }, { status: 404 });
  }
  if (epic.actingManagerId !== agent.user.id) {
    return NextResponse.json({ error: "Only the Epic acting manager can use this workflow" }, { status: 403 });
  }

  const actor = {
    id: agent.user.id,
    kind: "agent" as const,
    username: agent.user.username,
  };

  if (action === "create_tasks") {
    const summary = cleanText(payload.summary, 4000);
    const requestedTasks = parseCreateTasks(payload.tasks);
    if (!summary || !requestedTasks) {
      return NextResponse.json({
        error: "summary and 1-20 tasks with non-empty title are required",
      }, { status: 400 });
    }

    const created = await db.$transaction(async (tx) => {
      const maxRank = await tx.task.aggregate({
        where: { projectId: epic.projectId, status: "Backlog", archivedAt: null, deletedAt: null },
        _max: { rank: true },
      });
      let nextRank = (maxRank._max.rank ?? 0) + 1;
      const now = new Date();
      const rows: Array<{ id: string; title: string; workItemKey: string | null }> = [];
      for (const task of requestedTasks) {
        const title = await nextEpicTaskTitle(epic.id, task.title, tx);
        const row = await tx.task.create({
          data: {
            projectId: epic.projectId,
            epicId: epic.id,
            parentTaskId: null,
            workItemKey: await allocateWorkItemKey(epic.projectId, tx),
            title,
            description: task.description,
            status: "Backlog",
            rank: nextRank++,
            statusChangedAt: now,
            // Leave the task reviewer unstamped: resolveReviewOwnerId falls
            // back to the epic's CURRENT acting manager while the epic is In
            // Progress. Stamping the manager here froze a stale reference when
            // the human later swapped or deactivated the manager.
            actingManagerId: null,
            reporterId: epic.reporterId ?? null,
            branchName: null,
            commitPrefix: null,
          },
          select: { id: true, title: true, workItemKey: true },
        });
        rows.push(row);
        await tx.activityLog.create({
          data: {
            projectId: epic.projectId,
            taskId: row.id,
            userId: agent.user!.id,
            kind: "task.create",
            payload: JSON.stringify({
              title: row.title,
              epicId: epic.id,
              via: "epic-manager-workflow",
              action,
            }),
          },
        });
      }

      await tx.agentChatMessage.create({
        data: {
          projectId: epic.projectId,
          taskId: null,
          epicId: epic.id,
          agentSlug: "room",
          senderUserId: agent.user!.id,
          body: [
            `Epic manager @${agent.slug} created ${rows.length} new Backlog task${rows.length === 1 ? "" : "s"}.`,
            "A human must still approve/open the Epic before the manager can advance the queue or assign workers.",
            "",
            summary,
            "",
            ...rows.map((row) => `- ${row.workItemKey ?? row.id}: ${row.title}`),
          ].join("\n"),
          allowDescriptionEdit: false,
          originChannel: "chat",
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.manager.create_tasks",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            epicId: epic.id,
            summary,
            taskIds: rows.map((row) => row.id),
            status: epic.status,
            approvalCleared: false,
            epicStatusChanged: false,
          }),
        },
      });
      return rows;
    });

    await recordPmChannelRunWorkflowAction({
      epicId: epic.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    revalidatePath(`/projects/${epic.project.slug}`);
    revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
    publishBoardTouch(epic.projectId);
    return NextResponse.json({ ok: true, epicId: epic.id, status: epic.status, tasks: created });
  }

  if (!epic.approvedOn || !(epic.status === "In Progress" || epic.status === "To Do")) {
    return NextResponse.json({
      error: "Epic must be To Do or In Progress and human-approved before the manager can advance the queue",
      currentStatus: epic.status,
      approved: Boolean(epic.approvedOn),
    }, { status: 409 });
  }

  const promoted = action === "advance_queue"
    ? await db.$transaction((tx) =>
        promoteEpicBacklogTasks(tx, {
          epicId: epic.id,
          projectId: epic.projectId,
          actorUserId: agent.user!.id,
          via: "epic-manager-workflow",
        }),
      )
    : [];

  const assignment = await db.$transaction((tx) =>
    assignOpenEpicTasks(tx, {
      epicId: epic.id,
      projectId: epic.projectId,
      actorUserId: agent.user!.id,
      excludeUserIds: [epic.actingManagerId, epic.reporterId],
      via: "epic-manager-workflow",
    }),
  );

  await recordPmChannelRunWorkflowAction({
    epicId: epic.id,
    agentSlug: agent.slug,
    messageId,
    action,
  });

  for (const assigned of assignment.assignments) {
    await notifyAssignedTask({
      taskId: assigned.task.id,
      taskTitle: assigned.task.title,
      targetUserId: assigned.worker.id,
      actor,
      approvedPlan: assigned.approvedPlan,
    });
  }

  revalidatePath(`/projects/${epic.project.slug}`);
  revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
  for (const assigned of assignment.assignments) {
    revalidatePath(`/projects/${epic.project.slug}/tasks/${assigned.task.id}`);
  }
  publishBoardTouch(epic.projectId);

  const first = assignment.assignments[0] ?? null;
  return NextResponse.json({
    ok: true,
    epicId: epic.id,
    promotedTaskIds: promoted.map((task) => task.id),
    assignments: assignment.assignments.map((assigned) => ({
      task: { id: assigned.task.id, title: assigned.task.title },
      assignedTo: { id: assigned.worker.id, username: assigned.worker.username },
    })),
    nextTask: first ? { id: first.task.id, title: first.task.title } : null,
    assignedTo: first
      ? { id: first.worker.id, username: first.worker.username }
      : null,
    skipped: assignment.skipped,
  });
}
