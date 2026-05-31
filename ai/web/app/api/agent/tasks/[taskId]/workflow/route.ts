import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { sendTaskCommentNotifications, sendTaskWorkflowNotification } from "@/lib/agents/task-workflow-notifications";
import { recordPmChannelRunWorkflowAction } from "@/lib/agents/pm-channel-runs";
import { verifyTaskWorkflowToken } from "@/lib/agents/task-workflow-token";
import { epicAllowsAgentAction, resolveReviewOwnerId } from "@/lib/tasks/workflow-actors";
import { enqueueBranchVerifyJob } from "@/lib/deploy/branch-verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = [
  "start",
  "ready_for_review",
  "submit_review",
  "review_feedback",
  "review_done",
  "triage_to_todo",
] as const;

type WorkflowAction = (typeof ACTIONS)[number];

function isWorkflowAction(value: unknown): value is WorkflowAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

async function moveTaskStatus(args: {
  taskId: string;
  projectId: string;
  actorUserId: string;
  from: string;
  to: string;
  action: WorkflowAction;
}) {
  const maxRank = await db.task.aggregate({
    where: { status: args.to, deletedAt: null },
    _max: { rank: true },
  });
  await db.$transaction([
    db.task.update({
      where: { id: args.taskId },
      data: {
        status: args.to,
        rank: (maxRank._max.rank ?? 0) + 1,
        statusChangedAt: new Date(),
      },
    }),
    db.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: args.taskId,
        userId: args.actorUserId,
        kind: "task.move",
        payload: JSON.stringify({
          from: args.from,
          to: args.to,
          via: "agent-workflow",
          action: args.action,
        }),
      },
    }),
  ]);
}

async function assignNextEpicTaskAfterDone(args: {
  completedTaskId: string;
  projectId: string;
  actorUserId: string;
  actorUsername: string;
  assigneeId: string | null;
  epicId: string | null;
  reviewerId: string | null;
}) {
  if (!args.epicId || !args.assigneeId) return null;

  const nextTask = await db.task.findFirst({
    where: {
      epicId: args.epicId,
      deletedAt: null,
      status: "To Do",
      assigneeId: null,
    },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      assigneeId: true,
      actingManagerId: true,
      project: { select: { slug: true } },
    },
  });
  if (!nextTask) return null;

  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: nextTask.id },
      data: {
        assigneeId: args.assigneeId,
        actingManagerId: nextTask.actingManagerId ?? args.reviewerId,
      },
    });
    await tx.activityLog.create({
      data: {
        projectId: args.projectId,
        taskId: nextTask.id,
        userId: args.actorUserId,
        kind: "task.assign",
        payload: JSON.stringify({
          from: null,
          to: "previous-assignee",
          via: "agent-workflow",
          action: "review_done",
          afterTaskId: args.completedTaskId,
        }),
      },
    });
    if (!nextTask.actingManagerId && args.reviewerId) {
      await tx.activityLog.create({
        data: {
          projectId: args.projectId,
          taskId: nextTask.id,
          userId: args.actorUserId,
          kind: "task.acting_manager",
          payload: JSON.stringify({
            from: null,
            to: args.actorUsername,
            via: "agent-workflow",
            action: "review_done",
            afterTaskId: args.completedTaskId,
          }),
        },
      });
    }
  });

  await sendTaskWorkflowNotification({
    taskId: nextTask.id,
    targetUserId: args.assigneeId,
    actor: {
      id: args.actorUserId,
      username: args.actorUsername,
      kind: "agent",
    },
    reason: "todo_start_required",
    body: [
      `Previous epic task was accepted by @${args.actorUsername}.`,
      `Next task "${nextTask.title}" is now assigned to you in To Do.`,
      "Read the full task context, move it to In Progress through the workflow endpoint, and start work immediately.",
      "If you have unresolved review feedback on another Review-stage task, address that feedback first; otherwise start this task now.",
    ].join("\n"),
  });

  return { id: nextTask.id, title: nextTask.title, projectSlug: nextTask.project.slug };
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ taskId: string }> },
) {
  const { taskId } = await ctx.params;
  let payload: {
    messageId?: unknown;
    token?: unknown;
    action?: unknown;
    comment?: unknown;
    repoTouched?: unknown;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
  const token = typeof payload.token === "string" ? payload.token : "";
  const action = payload.action;
  const comment = typeof payload.comment === "string" ? payload.comment.trim() : "";
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
      taskId: true,
      agentSlug: true,
    },
  });
  if (!original || original.taskId !== taskId) {
    return NextResponse.json({ error: "Workflow grant message not found" }, { status: 404 });
  }
  if (!verifyTaskWorkflowToken(messageId, taskId, original.agentSlug, token)) {
    return NextResponse.json({ error: "Invalid workflow token" }, { status: 403 });
  }

  const [agent, task] = await Promise.all([
    db.agent.findUnique({
      where: { slug: original.agentSlug },
      select: {
        slug: true,
        deactivatedAt: true,
        user: { select: { id: true, username: true, status: true } },
      },
    }),
    db.task.findUnique({
      where: { id: taskId },
      select: {
        id: true,
        title: true,
        status: true,
        projectId: true,
        epicId: true,
        assigneeId: true,
        actingManagerId: true,
        reporterId: true,
        branchName: true,
        commitPrefix: true,
        deletedAt: true,
        project: { select: { slug: true, repositoryPath: true } },
        epic: { select: { status: true, actingManagerId: true, commitPrefix: true } },
      },
    }),
  ]);

  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  if (!task || task.deletedAt) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  const actor = {
    id: agent.user.id,
    kind: "agent" as const,
    username: agent.user.username,
  };
  const reviewerId = resolveReviewOwnerId(task);
  const isReviewer = reviewerId === agent.user.id;
  const isAssignee = task.assigneeId === agent.user.id;

  if (action === "start") {
    if (!isAssignee) return NextResponse.json({ error: "Only the assignee can start this task" }, { status: 403 });
    if (task.status !== "To Do") return NextResponse.json({ error: "Task must be in To Do before start" }, { status: 409 });
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be Open before task work starts" }, { status: 409 });

    await moveTaskStatus({
      taskId: task.id,
      projectId: task.projectId,
      actorUserId: agent.user.id,
      from: task.status,
      to: "In Progress",
      action,
    });
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: "In Progress" });
  }

  if (action === "ready_for_review" || action === "submit_review") {
    if (!isAssignee) return NextResponse.json({ error: "Only the assignee can send this task to Review" }, { status: 403 });
    if (task.status !== "In Progress") return NextResponse.json({ error: "Task must be In Progress before Review" }, { status: 409 });
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be Open before task work advances" }, { status: 409 });

    // Resolve repoTouched. The assignee can override by sending an explicit
    // boolean; otherwise default to "yes, it touched the repo" iff the task
    // has a branch name on a project with a repositoryPath set.
    const codeTouching = Boolean(task.branchName && task.project.repositoryPath);
    const repoTouched = typeof payload.repoTouched === "boolean"
      ? payload.repoTouched
      : codeTouching;
    const resolvedCommitPrefix = task.commitPrefix ?? task.epic?.commitPrefix ?? null;

    await moveTaskStatus({
      taskId: task.id,
      projectId: task.projectId,
      actorUserId: agent.user.id,
      from: task.status,
      to: "Review",
      action,
    });
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });

    // Karen verifier: only enqueue when the task plausibly touched the repo.
    // If branchName or repositoryPath is unset, there's nothing for Karen to
    // check against — skip silently. If the assignee declared repoTouched=
    // false (e.g., doc-only task), also skip.
    let verifyJobId: string | null = null;
    if (repoTouched && task.branchName && task.project.repositoryPath) {
      const jobId = randomUUID();
      try {
        await enqueueBranchVerifyJob({
          jobId,
          taskId: task.id,
          projectId: task.projectId,
          projectSlug: task.project.slug,
          repositoryPath: task.project.repositoryPath,
          branchName: task.branchName,
          commitPrefix: resolvedCommitPrefix,
          requestedByAgentSlug: agent.slug,
          requestedByUserId: agent.user.id,
          requestedAt: new Date().toISOString(),
        });
        verifyJobId = jobId;
        await db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: agent.user.id,
            kind: "pm.repo.verify.enqueue",
            targetAgent: agent.slug,
            payload: JSON.stringify({
              jobId,
              branchName: task.branchName,
              commitPrefix: resolvedCommitPrefix,
              repositoryPath: task.project.repositoryPath,
            }),
          },
        });
      } catch (err) {
        // Enqueue failure is non-fatal — the Review transition still
        // succeeds; the reviewer just won't see a verification comment.
        console.warn(`[workflow] failed to enqueue branch verify for ${task.id}`, err);
      }
    }

    if (reviewerId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: reviewerId,
        actor,
        reason: "review_requested",
        body: [
          `Task "${task.title}" was moved to Review by @${agent.user.username}.`,
          repoTouched && verifyJobId
            ? `Karen has been asked to verify origin/${task.branchName} reflects the work; a pm.repo.verify.* task comment will follow. Check it before reviewing.`
            : "The assignee indicated this task did not change the repository (or no branch is set). Verify the non-code work directly.",
          "Review the completed work and full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, leave concise feedback while keeping it in Review.",
        ].join("\n"),
      });
    }
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: "Review", verifyJobId, repoTouched });
  }

  if (action === "review_feedback") {
    if (!isReviewer) return NextResponse.json({ error: "Only the resolved reviewer can leave workflow feedback" }, { status: 403 });
    if (task.status !== "Review") return NextResponse.json({ error: "Task must be in Review for review feedback" }, { status: 409 });
    if (!comment || comment.length > 8000) {
      return NextResponse.json({ error: "comment is required and must be <= 8000 chars" }, { status: 400 });
    }

    const created = await db.$transaction(async (tx) => {
      const row = await tx.comment.create({
        data: { taskId: task.id, userId: agent.user!.id, body: comment },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: agent.user!.id,
          kind: "task.comment",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            commentId: row.id,
            workflowAction: action,
            agentSlug: agent.slug,
          }),
        },
      });
      return row;
    });
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    await sendTaskCommentNotifications({
      taskId: task.id,
      commentId: created.id,
      body: comment,
      actor,
      excludeAgentSlugs: [agent.slug],
    });
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: task.status, commentId: created.id });
  }

  if (action === "review_done") {
    if (!isReviewer) return NextResponse.json({ error: "Only the resolved reviewer can complete this task" }, { status: 403 });
    if (task.status !== "Review") return NextResponse.json({ error: "Task must be in Review before Done" }, { status: 409 });

    await moveTaskStatus({
      taskId: task.id,
      projectId: task.projectId,
      actorUserId: agent.user.id,
      from: task.status,
      to: "Done",
      action,
    });
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    if (task.assigneeId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "review_done",
        body: [
          `Task "${task.title}" was reviewed and moved to Done by @${agent.user.username}.`,
          "No further action is required unless the task is reopened.",
        ].join("\n"),
      });
    }
    const nextTask = await assignNextEpicTaskAfterDone({
      completedTaskId: task.id,
      projectId: task.projectId,
      actorUserId: agent.user.id,
      actorUsername: agent.user.username,
      assigneeId: task.assigneeId,
      epicId: task.epicId,
      reviewerId,
    });
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    if (nextTask) {
      revalidatePath(`/projects/${task.project.slug}/tasks/${nextTask.id}`);
    }
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: "Done", nextTask });
  }

  if (action === "triage_to_todo") {
    if (!isReviewer) return NextResponse.json({ error: "Only the reviewer, Open Epic manager, or reporter fallback can move Backlog to To Do" }, { status: 403 });
    if (task.status !== "Backlog") return NextResponse.json({ error: "Task must be in Backlog before triage to To Do" }, { status: 409 });
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be Open before task work becomes actionable" }, { status: 409 });

    await moveTaskStatus({
      taskId: task.id,
      projectId: task.projectId,
      actorUserId: agent.user.id,
      from: task.status,
      to: "To Do",
      action,
    });
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    if (task.assigneeId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "todo_start_required",
        body: [
          `Task "${task.title}" is now in To Do and assigned to you.`,
          "Read the full task context, move it to In Progress through the workflow endpoint, and start work immediately.",
        ].join("\n"),
      });
    }
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: "To Do" });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
