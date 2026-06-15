import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { sendTaskCommentNotifications, sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import { recordPmChannelRunWorkflowAction } from "@/lib/agents/pm-channel/runs";
import { verifyTaskWorkflowToken } from "@/lib/agents/workflow/token/task";
import {
  canApproveActionPlanForActor,
  epicAllowsAgentAction,
  resolveDoneOwnerId,
  resolveReviewOwnerId,
} from "@/lib/tasks/workflow-actors";
import { enqueueBranchVerifyJob } from "@/lib/deploy/branch-verify";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import { createActionPlanSubtasksForTask } from "@/lib/tasks/action-plan-subtasks";
import { createSubTaskItem, setSubTaskCompletion } from "@/lib/tasks/subtasks";
import { resolveGitIdentity } from "@/lib/settings/system";
import { effectiveCommitPrefix } from "@/lib/work-items/keys";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { assignTaskAfterPlanApproval } from "@/lib/tasks/reviewer-assignment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = [
  "start",
  "ready_for_review",
  "submit_review",
  "review_feedback",
  "review_done",
  "triage_to_todo",
  "approve_plan",
  "assign_after_plan_approval",
  "add_subtask",
  "complete_subtask",
] as const;

type WorkflowAction = (typeof ACTIONS)[number];

function isWorkflowAction(value: unknown): value is WorkflowAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

async function workflowNotificationReason(taskId: string, messageId: string) {
  const rows = await db.activityLog.findMany({
    where: {
      taskId,
      kind: "task.workflow.notify",
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { payload: true },
  });
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload ?? "{}") as {
        messageId?: unknown;
        reason?: unknown;
      };
      if (payload.messageId === messageId) {
        return typeof payload.reason === "string" ? payload.reason : null;
      }
    } catch {
      // Ignore malformed historical activity rows; they cannot authorize
      // state-sensitive workflow actions.
    }
  }
  return null;
}

async function commentAuthorId(commentId: string | null) {
  if (!commentId) return null;
  const comment = await db.comment.findUnique({
    where: { id: commentId },
    select: { userId: true, deletedAt: true },
  });
  return comment && !comment.deletedAt ? comment.userId : null;
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
  revalidateTaskShell(args.taskId);
  publishBoardTouch(args.projectId);
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
    subtaskText?: unknown;
    subtaskId?: unknown;
    completed?: unknown;
    minutesSpent?: unknown;
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
  if (comment.length > 8000) {
    return NextResponse.json({ error: "comment must be <= 8000 chars" }, { status: 400 });
  }

  const original = await db.agentChatMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      taskId: true,
      agentSlug: true,
      targetType: true,
      targetValue: true,
      originCommentId: true,
    },
  });
  if (!original || original.taskId !== taskId) {
    return NextResponse.json({ error: "Workflow grant message not found" }, { status: 404 });
  }
  const grantAgentSlug =
    original.agentSlug === "room" &&
    original.targetType === "agent" &&
    original.targetValue?.startsWith("agent:")
      ? original.targetValue.slice("agent:".length)
      : original.agentSlug;
  if (!verifyTaskWorkflowToken(messageId, taskId, grantAgentSlug, token)) {
    return NextResponse.json({ error: "Invalid workflow token" }, { status: 403 });
  }

  const [agent, task] = await Promise.all([
    db.agent.findUnique({
      where: { slug: grantAgentSlug },
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
        approvedOn: true,
        branchName: true,
        commitPrefix: true,
        workItemKey: true,
        deletedAt: true,
        blockedById: true,
        blockedBy: { select: { workItemKey: true, status: true } },
        project: {
          select: {
            slug: true,
            repositoryPath: true,
            defaultGitUserName: true,
            defaultGitUserEmail: true,
            onlyReportersCanApproveActionPlans: true,
            onlyReportersCanSetTasksDone: true,
          },
        },
        epic: { select: { status: true, actingManagerId: true, commitPrefix: true, workItemKey: true } },
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
  const doneOwnerId = resolveDoneOwnerId(task);
  const isReviewer = reviewerId === agent.user.id;
  const canSetDone = doneOwnerId === agent.user.id;
  const isAssignee = task.assigneeId === agent.user.id;

  if (action === "start") {
    if (!isAssignee) return NextResponse.json({ error: "Only the assignee can start this task" }, { status: 403 });
    if (task.status !== "To Do" && task.status !== "Review") {
      return NextResponse.json({ error: "Task must be in To Do or Review before start/resume" }, { status: 409 });
    }
    // Hard dependency (ENV-62): can't start while a blocker is still open.
    if (task.blockedById && task.blockedBy && task.blockedBy.status !== "Done") {
      return NextResponse.json({
        error: `Task is blocked by ${task.blockedBy.workItemKey ?? "another task"}, which must reach Done first.`,
        blockedBy: task.blockedBy.workItemKey ?? null,
      }, { status: 409 });
    }
    if (task.status === "Review") {
      const reason = await workflowNotificationReason(task.id, messageId);
      const authorId = reason === "review_feedback"
        ? null
        : await commentAuthorId(original.originCommentId);
      if (reason !== "review_feedback" && authorId !== reviewerId && authorId !== doneOwnerId) {
        return NextResponse.json({
          error: "This workflow turn cannot resume a task from Review. Wait for review feedback or call ready_for_review only if the work is already complete.",
          currentStatus: task.status,
          workflowReason: reason,
        }, { status: 409 });
      }
    }
    if (!task.approvedOn) {
      return NextResponse.json({ error: "Action Plan must be approved before start" }, { status: 409 });
    }
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
    return NextResponse.json({ ok: true, taskId: task.id, status: "In Progress", resumed: task.status === "Review" });
  }

  if (action === "approve_plan") {
    if (!canApproveActionPlanForActor(task, agent.user.id)) {
      return NextResponse.json({
        error: task.project.onlyReportersCanApproveActionPlans
          ? "Only the task reporter can approve the Action Plan"
          : "Only the resolved reviewer or reporter can approve the Action Plan",
      }, { status: 403 });
    }
    if (task.approvedOn) {
      return NextResponse.json({ ok: true, taskId: task.id, approved: true, alreadyApproved: true });
    }
    const approvedAt = new Date();
    const moveToTodo = task.status === "Backlog";
    await db.$transaction([
      db.task.update({
        where: { id: task.id },
        data: {
          approvedOn: approvedAt,
          approvedById: agent.user.id,
          ...(moveToTodo ? { status: "To Do", statusChangedAt: approvedAt } : {}),
        },
      }),
      db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: agent.user.id,
          kind: "task.action_plan.approve",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            taskId: task.id,
            previousStatus: task.status,
            status: moveToTodo ? "To Do" : task.status,
            via: "agent-workflow",
          }),
        },
      }),
      ...(comment
        ? [
            db.agentChatMessage.create({
              data: {
                projectId: task.projectId,
                taskId: task.id,
                epicId: null,
                agentSlug: "room",
                senderUserId: agent.user.id,
                body: comment,
                allowDescriptionEdit: false,
                originChannel: "chat",
              },
            }),
            db.activityLog.create({
              data: {
                projectId: task.projectId,
                taskId: task.id,
                userId: agent.user.id,
                kind: "task.chat.reply",
                targetAgent: agent.slug,
                payload: JSON.stringify({
                  agentSlug: agent.slug,
                  workflowAction: "approve_plan",
                  source: "approval_comment",
                }),
              },
            }),
          ]
        : []),
      ...(moveToTodo
        ? [
            db.activityLog.create({
              data: {
                projectId: task.projectId,
                taskId: task.id,
                userId: agent.user.id,
                kind: "task.move",
                targetAgent: agent.slug,
                payload: JSON.stringify({
                  from: "Backlog",
                  to: "To Do",
                  via: "action-plan-approval",
                  action,
                }),
              },
            }),
          ]
        : []),
    ]);
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    await createActionPlanSubtasksForTask({
      taskId: task.id,
      approvedAt,
      approvedById: agent.user.id,
    });
    if (task.assigneeId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "todo_start_required",
        body: [
          `The Action Plan for "${task.title}" was approved by @${agent.user.username}.`,
          "You may now call the workflow endpoint with action=start, move the task to In Progress, and implement the approved plan.",
          "Do not post a visible acknowledgement unless a blocker or material plan change appears.",
        ].join("\n"),
      });
    } else if (reviewerId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: reviewerId,
        actor,
        reason: "reviewer_assignment_requested",
        body: [
          `The Action Plan for "${task.title}" was approved by @${agent.user.username}, but the task has no assignee.`,
          "If you are the assigned task reviewer, call the workflow endpoint with action=assign_after_plan_approval. PM will choose an eligible coding agent and move Backlog to To Do if needed.",
          "Do not start implementation yourself.",
        ].join("\n"),
      });
    }
    if (comment) revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, approved: true, status: moveToTodo ? "To Do" : task.status });
  }

  if (action === "assign_after_plan_approval") {
    if (task.actingManagerId !== agent.user.id) {
      return NextResponse.json({ error: "Only the assigned task reviewer can assign this task after plan approval" }, { status: 403 });
    }
    const result = await assignTaskAfterPlanApproval({
      taskId: task.id,
      actor,
      requireReviewerUserId: agent.user.id,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status ?? 400 });
    }
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: result.task.status,
      assignedTo: result.assignee,
      movedToTodo: result.movedToTodo,
    });
  }

  if (action === "ready_for_review" || action === "submit_review") {
    if (!isAssignee) return NextResponse.json({ error: "Only the assignee can send this task to Review" }, { status: 403 });
    if (task.status !== "In Progress" && task.status !== "Review") {
      return NextResponse.json({ error: "Task must be In Progress or already in Review before ready_for_review" }, { status: 409 });
    }
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be Open before task work advances" }, { status: 409 });

    // Resolve repoTouched. The assignee can override by sending an explicit
    // boolean; otherwise default to "yes, it touched the repo" iff the task
    // has a branch name on a project with a repositoryPath set.
    const codeTouching = Boolean(task.branchName && task.project.repositoryPath);
    const repoTouched = typeof payload.repoTouched === "boolean"
      ? payload.repoTouched
      : codeTouching;
    const fallbackCommitPrefix = effectiveCommitPrefix({
      commitPrefix: task.commitPrefix ?? task.epic?.commitPrefix ?? null,
      workItemKey: task.workItemKey,
    });
    const taskKey = task.workItemKey ?? task.id;
    const resolvedCommitPrefix = task.epic?.workItemKey
      ? `${task.epic.workItemKey} ${taskKey}`
      : fallbackCommitPrefix;

    if (task.status !== "Review") {
      await moveTaskStatus({
        taskId: task.id,
        projectId: task.projectId,
        actorUserId: agent.user.id,
        from: task.status,
        to: "Review",
        action,
      });
    }
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });

    let reviewCommentId: string | null = null;
    if (comment) {
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
      reviewCommentId = created.id;
    }

    // Monitor verifier: only enqueue when the task plausibly touched the repo.
    // If branchName or repositoryPath is unset, there's nothing for the verifier to
    // check against — skip silently. If the assignee declared repoTouched=
    // false (e.g., doc-only task), also skip.
    let verifyJobId: string | null = null;
    if (repoTouched && task.branchName && task.project.repositoryPath) {
      const jobId = randomUUID();
      const gitIdentity = await resolveGitIdentity(task.project);
      try {
        await enqueueBranchVerifyJob({
          jobId,
          taskId: task.id,
          projectId: task.projectId,
          projectSlug: task.project.slug,
          repositoryPath: task.project.repositoryPath,
          branchName: task.branchName,
          commitPrefix: resolvedCommitPrefix,
          expectedGitUserName: gitIdentity.name,
          expectedGitUserEmail: gitIdentity.email,
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
              expectedGitUserName: gitIdentity.name,
              expectedGitUserEmail: gitIdentity.email,
            }),
          },
        });
      } catch (err) {
        // Enqueue failure is non-fatal to the Review transition, but it must
        // not wake the reviewer for code work. The reviewer gate is the
        // monitor's pm.repo.verify.ok result.
        console.warn(`[workflow] failed to enqueue branch verify for ${task.id}`, err);
      }
    }

    const reviewerShouldWaitForMonitor = repoTouched && Boolean(verifyJobId);
    if (reviewerId && !reviewerShouldWaitForMonitor) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: reviewerId,
        actor,
        reason: "review_requested",
        body: [
          `Task "${task.title}" was moved to Review by @${agent.user.username}.`,
          comment
            ? `Assignee note:\n${comment}`
            : null,
          repoTouched
            ? "No monitor branch verification could be queued, so treat this as a workflow/setup issue before approving code work."
            : "The assignee indicated this task did not change the repository (or no branch is set). Verify the non-code work directly.",
          "Review the completed work or respond to the assignee's blocker/question using the full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, leave concise feedback while keeping it in Review.",
        ].filter(Boolean).join("\n"),
      });
    }
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: "Review", verifyJobId, repoTouched, commentId: reviewCommentId });
  }

  if (action === "review_feedback") {
    if (!isReviewer) return NextResponse.json({ error: "Only the resolved reviewer can leave workflow feedback" }, { status: 403 });
    if (task.status !== "Review") return NextResponse.json({ error: "Task must be in Review for review feedback" }, { status: 409 });
    if (!comment || comment.length > 8000) {
      return NextResponse.json({ error: "comment is required and must be <= 8000 chars" }, { status: 400 });
    }

    const maxRank = await db.task.aggregate({
      where: { status: "To Do", deletedAt: null },
      _max: { rank: true },
    });
    const created = await db.$transaction(async (tx) => {
      const row = await tx.comment.create({
        data: { taskId: task.id, userId: agent.user!.id, body: comment },
        select: { id: true },
      });
      await tx.task.update({
        where: { id: task.id },
        data: {
          status: "To Do",
          rank: (maxRank._max.rank ?? 0) + 1,
          statusChangedAt: new Date(),
        },
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
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: agent.user!.id,
          kind: "task.move",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            from: "Review",
            to: "To Do",
            via: "agent-workflow",
            action,
            commentId: row.id,
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
    if (task.assigneeId) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "review_feedback",
        body: [
          `Review feedback for "${task.title}" moved the task back to To Do.`,
          "Add a sub-task (action=add_subtask) for each concrete item in the reviewer's feedback BEFORE resuming, so the progress checklist reflects the remaining work and the board bar stays honest (your earlier items are already ticked). Tick each new item off (with minutesSpent) as you address it.",
          "Keep the approved Action Plan unless a material plan change is required, then start/resume work through the workflow endpoint.",
          "Do not post an acknowledgement-only response.",
        ].join("\n"),
      });
    }
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    return NextResponse.json({ ok: true, taskId: task.id, status: "To Do", commentId: created.id });
  }

  if (action === "review_done") {
    if (!canSetDone) {
      return NextResponse.json({
        error: task.project.onlyReportersCanSetTasksDone
          ? "Only the task reporter can complete this task"
          : "Only the resolved reviewer can complete this task",
      }, { status: 403 });
    }
    if (task.status !== "Review") return NextResponse.json({ error: "Task must be in Review before Done" }, { status: 409 });

    const completion = await completeReviewedTaskAndAssignNext({
      taskId: task.id,
      actor,
      via: "agent-workflow",
      requireReviewerUserId: agent.user.id,
    });
    if (!completion.completed) {
      return NextResponse.json({ error: `Could not complete task: ${completion.reason}` }, { status: 409 });
    }
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    if (completion.nextTask) {
      revalidateTaskShell(completion.nextTask.id);
      revalidatePath(`/projects/${task.project.slug}/tasks/${completion.nextTask.id}`);
    }
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: "Done", nextTask: completion.nextTask });
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
          task.approvedOn
            ? "The Action Plan is approved. Move it to In Progress through the workflow endpoint and start work immediately."
            : "Before starting work, post one concise technical implementation plan in Action Plan and wait for reviewer/reporter approval.",
        ].join("\n"),
      });
    }
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, status: "To Do" });
  }

  // Progress checklist (ENV-60). The assignee maintains a lightweight sub-task
  // checklist (text + done) so the board card shows how close the task is to
  // finished. These are NOT child tasks.
  if (action === "add_subtask") {
    if (!isAssignee) return NextResponse.json({ error: "Only the assignee can add sub-tasks" }, { status: 403 });
    const text = typeof payload.subtaskText === "string" ? payload.subtaskText.trim() : "";
    if (!text) return NextResponse.json({ error: "subtaskText is required" }, { status: 400 });
    let created: { id: string } | null = null;
    try {
      created = await createSubTaskItem({ taskId: task.id, text, actorUserId: agent.user.id });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not add sub-task" }, { status: 409 });
    }
    if (!created) return NextResponse.json({ error: "subtaskText is required" }, { status: 400 });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    return NextResponse.json({ ok: true, taskId: task.id, subtaskId: created.id });
  }

  if (action === "complete_subtask") {
    if (!isAssignee) return NextResponse.json({ error: "Only the assignee can update sub-tasks" }, { status: 403 });
    const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : "";
    if (!subtaskId) return NextResponse.json({ error: "subtaskId is required" }, { status: 400 });
    // Default to marking complete; pass completed:false to reopen.
    const completed = payload.completed === undefined ? true : payload.completed === true;
    // Optional self-reported effort for this step.
    const minutesSpent = typeof payload.minutesSpent === "number" ? payload.minutesSpent : undefined;
    const result = await setSubTaskCompletion({
      subTaskId: subtaskId,
      completed,
      minutesSpent,
      actorUserId: agent.user.id,
      expectTaskId: task.id,
    });
    if (!result) return NextResponse.json({ error: "Sub-task not found on this task" }, { status: 404 });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    return NextResponse.json({ ok: true, taskId: task.id, subtaskId, completed: result.completedAt !== null, minutesSpent: result.minutesSpent });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
