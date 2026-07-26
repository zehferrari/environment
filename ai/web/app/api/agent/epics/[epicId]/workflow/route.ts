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

const ACTIONS = [
  "advance_queue",
  "assign_next",
  "create_tasks",
  // Deploy-review actions — authorized for the epic's Deploy Reviewer (or the
  // monitor agent when none is set), NOT the acting manager.
  "deploy_review_approve",
  "deploy_review_reject",
] as const;

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
    reason?: unknown;
    taskId?: unknown;
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
        role: true,
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
        deployReviewerId: true,
        deploymentStatus: true,
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

  const actor = {
    id: agent.user.id,
    kind: "agent" as const,
    username: agent.user.username,
  };

  // Deploy-review actions belong to the epic's Deploy Reviewer (or the monitor
  // agent when none is set) — a distinct role from the acting manager who runs
  // the queue actions below.
  if (action === "deploy_review_approve" || action === "deploy_review_reject") {
    const isDeployReviewer = epic.deployReviewerId
      ? epic.deployReviewerId === agent.user.id
      : agent.role === "monitor";
    if (!isDeployReviewer) {
      return NextResponse.json({ error: "Only the Epic's deploy reviewer (or the monitor agent) can review the deployment" }, { status: 403 });
    }
    if (epic.deploymentStatus !== "Ready to Deploy") {
      return NextResponse.json({
        error: "Epic is not awaiting deploy review",
        deploymentStatus: epic.deploymentStatus,
      }, { status: 409 });
    }

    if (action === "deploy_review_approve") {
      await db.$transaction(async (tx) => {
        await tx.epic.update({
          where: { id: epic.id },
          data: { deploymentStatus: "Deployment Approved" },
        });
        await tx.agentChatMessage.create({
          data: {
            projectId: epic.projectId,
            taskId: null,
            epicId: epic.id,
            agentSlug: "room",
            senderUserId: agent.user!.id,
            body: [
              `Deploy reviewer @${agent.slug} APPROVED this Epic's contribution for merge.`,
              "The whole-contribution review found no unaddressed requests and no security/data-integrity risk.",
              "Awaiting the merge to the production branch; the deployment will resolve automatically once the work lands there.",
            ].join("\n"),
            allowDescriptionEdit: false,
            originChannel: "chat",
          },
        });
        await tx.activityLog.create({
          data: {
            projectId: epic.projectId,
            userId: agent.user!.id,
            kind: "epic.deploy_review.approve",
            targetAgent: agent.slug,
            payload: JSON.stringify({ epicId: epic.id, from: "Ready to Deploy", to: "Deployment Approved" }),
          },
        });
      });
      await recordPmChannelRunWorkflowAction({ epicId: epic.id, agentSlug: agent.slug, messageId, action });
      revalidatePath(`/projects/${epic.project.slug}`);
      revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
      publishBoardTouch(epic.projectId);
      return NextResponse.json({ ok: true, epicId: epic.id, deploymentStatus: "Deployment Approved" });
    }

    // deploy_review_reject
    const reason = cleanText(payload.reason, 8000);
    const flaggedTaskId = cleanText(payload.taskId, 100);
    if (!reason) {
      return NextResponse.json({ error: "reason is required for deploy_review_reject" }, { status: 400 });
    }
    let flaggedTask: { id: string; title: string; status: string; assigneeId: string | null } | null = null;
    if (flaggedTaskId) {
      flaggedTask = await db.task.findFirst({
        where: { id: flaggedTaskId, epicId: epic.id, deletedAt: null },
        select: { id: true, title: true, status: true, assigneeId: true },
      });
      if (!flaggedTask) {
        return NextResponse.json({ error: "taskId must reference a task of this Epic" }, { status: 400 });
      }
    }

    const now = new Date();
    // Bounced work returns to the FRONT of this project's To Do column.
    const minRank = await db.task.aggregate({
      where: { projectId: epic.projectId, status: "To Do", deletedAt: null },
      _min: { rank: true },
    });
    await db.$transaction(async (tx) => {
      // The Epic drops out of the deploy gate and re-opens for work.
      await tx.epic.update({
        where: { id: epic.id },
        data: { status: "To Do", statusChangedAt: now, deploymentStatus: "Not Required" },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.status",
          payload: JSON.stringify({ epicId: epic.id, from: epic.status, to: "To Do", via: "deploy_review_reject" }),
        },
      });
      if (flaggedTask) {
        const commentRow = await tx.comment.create({
          data: {
            taskId: flaggedTask.id,
            userId: agent.user!.id,
            body: `Deploy review flagged this task and returned it to To Do:\n\n${reason}`,
          },
          select: { id: true },
        });
        await tx.task.update({
          where: { id: flaggedTask.id },
          data: {
            status: "To Do",
            statusChangedAt: now,
            // The auto-Done rollup leaves child tasks live, but a human-closed
            // Epic archives them — un-archive so the bounce is workable either way.
            archivedAt: null,
            archivedById: null,
            rank: (minRank._min.rank ?? 0) - 1,
          },
        });
        await tx.activityLog.create({
          data: {
            projectId: epic.projectId,
            taskId: flaggedTask.id,
            userId: agent.user!.id,
            kind: "task.move",
            targetAgent: agent.slug,
            payload: JSON.stringify({ from: flaggedTask.status, to: "To Do", via: "deploy_review_reject", commentId: commentRow.id }),
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
            `Deploy reviewer @${agent.slug} REJECTED this Epic's contribution.`,
            flaggedTask ? `Flagged task returned to To Do: ${flaggedTask.title}` : "No single task was flagged; the Epic returns to To Do for rework.",
            "",
            "Reason:",
            reason,
          ].join("\n"),
          allowDescriptionEdit: false,
          originChannel: "chat",
        },
      });
      await tx.activityLog.create({
        data: {
          projectId: epic.projectId,
          userId: agent.user!.id,
          kind: "epic.deploy_review.reject",
          targetAgent: agent.slug,
          payload: JSON.stringify({ epicId: epic.id, taskId: flaggedTask?.id ?? null, reason }),
        },
      });
    });

    if (flaggedTask?.assigneeId) {
      await sendTaskWorkflowNotification({
        taskId: flaggedTask.id,
        targetUserId: flaggedTask.assigneeId,
        actor,
        reason: "review_feedback",
        body: [
          `Deploy review flagged "${flaggedTask.title}" and moved it back to To Do (front of the queue).`,
          "The whole-contribution deploy review found an issue with this task before merge. Read the reviewer's comment on the task for the technical reason.",
          "Address it before starting or resuming any other task, then move it back through Review through the workflow endpoint.",
          "Do not post an acknowledgement-only response.",
        ].join("\n"),
      });
    }
    await recordPmChannelRunWorkflowAction({ epicId: epic.id, agentSlug: agent.slug, messageId, action });
    revalidatePath(`/projects/${epic.project.slug}`);
    revalidatePath(`/projects/${epic.project.slug}/epics/${epic.id}`);
    if (flaggedTask) revalidatePath(`/projects/${epic.project.slug}/tasks/${flaggedTask.id}`);
    publishBoardTouch(epic.projectId);
    return NextResponse.json({
      ok: true,
      epicId: epic.id,
      epicStatus: "To Do",
      deploymentStatus: "Not Required",
      bouncedTaskId: flaggedTask?.id ?? null,
    });
  }

  // All remaining actions are Epic-manager actions.
  if (epic.actingManagerId !== agent.user.id) {
    return NextResponse.json({ error: "Only the Epic acting manager can use this workflow" }, { status: 403 });
  }

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
