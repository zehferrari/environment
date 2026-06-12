import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { recordPmChannelRunWorkflowAction } from "@/lib/agents/pm-channel-runs";
import { verifyEpicWorkflowToken } from "@/lib/agents/epic-workflow-token";
import { assignFirstOpenEpicTask } from "@/lib/epics/assignment";
import { sendTaskWorkflowNotification } from "@/lib/agents/task-workflow-notifications";
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
}) {
  await sendTaskWorkflowNotification({
    taskId: args.taskId,
    targetUserId: args.targetUserId,
    actor: args.actor,
    reason: "todo_start_required",
    body: [
      `Epic manager @${args.actor.username} assigned "${args.taskTitle}" to you in To Do.`,
      "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
      "If you have unresolved review feedback on another Review-stage task, address that feedback first; otherwise prepare the Action Plan for this task now.",
    ].join("\n"),
  });
}

async function promoteBacklogTasks(args: {
  epicId: string;
  projectId: string;
  actorUserId: string;
}) {
  const tasks = await db.task.findMany({
    where: {
      epicId: args.epicId,
      parentTaskId: null,
      archivedAt: null,
      deletedAt: null,
      status: "Backlog",
    },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true },
  });
  if (tasks.length === 0) return [];

  await db.$transaction(async (tx) => {
    const maxRank = await tx.task.aggregate({
      where: { projectId: args.projectId, status: "To Do", archivedAt: null, deletedAt: null },
      _max: { rank: true },
    });
    let nextRank = (maxRank._max.rank ?? 0) + 1;
    const now = new Date();
    for (const task of tasks) {
      await tx.task.update({
        where: { id: task.id },
        data: { status: "To Do", rank: nextRank++, statusChangedAt: now },
      });
      await tx.activityLog.create({
        data: {
          projectId: args.projectId,
          taskId: task.id,
          userId: args.actorUserId,
          kind: "task.move",
          payload: JSON.stringify({
            from: "Backlog",
            to: "To Do",
            via: "epic-manager-workflow",
            action: "advance_queue",
            epicId: args.epicId,
          }),
        },
      });
    }
  });
  return tasks;
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

  const [agent, epic] = await Promise.all([
    db.agent.findUnique({
      where: { slug: grantAgentSlug },
      select: {
        slug: true,
        deactivatedAt: true,
        user: { select: { id: true, username: true, status: true } },
      },
    }),
    db.epic.findUnique({
      where: { id: epicId },
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
            actingManagerId: epic.actingManagerId,
            reporterId: epic.reporterId ?? agent.user!.id,
            branchName: epic.branchName,
            commitPrefix: epic.commitPrefix,
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

      await tx.epic.update({
        where: { id: epic.id },
        data: {
          status: "Backlog",
          statusChangedAt: now,
          approvedOn: null,
          approvedById: null,
        },
      });
      await tx.agentChatMessage.create({
        data: {
          projectId: epic.projectId,
          taskId: null,
          epicId: epic.id,
          agentSlug: "room",
          senderUserId: agent.user!.id,
          body: [
            `Epic manager @${agent.slug} created ${rows.length} new Backlog task${rows.length === 1 ? "" : "s"} and paused the Epic for human approval.`,
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
            previousStatus: epic.status,
            status: "Backlog",
            approvalCleared: true,
          }),
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.status",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            epicId: epic.id,
            from: epic.status,
            to: "Backlog",
            via: "epic-manager-workflow",
            action,
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
    return NextResponse.json({ ok: true, epicId: epic.id, status: "Backlog", tasks: created });
  }

  if (!epic.approvedOn || epic.status !== "Open") {
    return NextResponse.json({
      error: "Epic must be Open and human-approved before the manager can advance the queue",
      currentStatus: epic.status,
      approved: Boolean(epic.approvedOn),
    }, { status: 409 });
  }

  const promoted = action === "advance_queue"
    ? await promoteBacklogTasks({
        epicId: epic.id,
        projectId: epic.projectId,
        actorUserId: agent.user.id,
      })
    : [];

  const assignment = await db.$transaction((tx) =>
    assignFirstOpenEpicTask(tx, {
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

  if (assignment.task && assignment.worker) {
    await notifyAssignedTask({
      taskId: assignment.task.id,
      taskTitle: assignment.task.title,
      targetUserId: assignment.worker.id,
      actor,
    });
  }

  revalidatePath(`/projects/${epic.project.slug}`);
  revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
  if (assignment.task) {
    revalidatePath(`/projects/${epic.project.slug}/tasks/${assignment.task.id}`);
  }
  publishBoardTouch(epic.projectId);

  return NextResponse.json({
    ok: true,
    epicId: epic.id,
    promotedTaskIds: promoted.map((task) => task.id),
    nextTask: assignment.task
      ? { id: assignment.task.id, title: assignment.task.title }
      : null,
    assignedTo: assignment.worker
      ? { id: assignment.worker.id, username: assignment.worker.username }
      : null,
    skipped: assignment.skipped,
  });
}
