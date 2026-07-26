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
import { startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";
import { createSubTaskItem, normalizeSubTaskKind, setSubTaskCompletion } from "@/lib/tasks/subtasks";
import { resolveEffectiveProjectSettings } from "@/lib/settings/effective";
import { effectiveTaskCommitPrefix } from "@/lib/work-items/keys";
import { effectiveTaskBranchName } from "@/lib/work-items/branches";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { assignTaskAfterPlanApproval } from "@/lib/tasks/reviewer-assignment";
import { refillEpicQueue } from "@/lib/epics/queue";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { isProtectedBranch, parseProtectedBranches } from "@/lib/projects/protected-branches";
import { hasAuthorizedTaskAgentOrigin } from "@/lib/agents/owner-origin";

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
  "request_subtask",
  "request_task",
  "flag_extra_work_blocker",
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
    subtaskKind?: unknown;
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
      senderUserId: true,
      sender: { select: { kind: true, status: true } },
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
  if (!(await hasAuthorizedTaskAgentOrigin({
    taskId,
    messageId,
    targetAgentSlug: grantAgentSlug,
    senderUserId: original.senderUserId,
    sender: original.sender,
  }))) {
    return NextResponse.json({ error: "Workflow grant is no longer authorized" }, { status: 403 });
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
    db.task.findFirst({
      where: {
        id: taskId,
        private: false,
        AND: [
          { OR: [{ epicId: null }, { epic: { private: false } }] },
          {
            OR: [
              { parentTaskId: null },
              { parent: { private: false, OR: [{ epicId: null }, { epic: { private: false } }] } },
            ],
          },
        ],
      },
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
        blockedBy: {
          select: {
            workItemKey: true,
            status: true,
            private: true,
            epic: { select: { private: true } },
            parent: { select: { private: true, epic: { select: { private: true } } } },
          },
        },
        project: {
          select: {
            slug: true,
            repositoryPath: true,
            defaultGitUserName: true,
            defaultGitUserEmail: true,
            deploymentProductionBranch: true,
            deploymentPrTargetBranch: true,
            onlyReportersCanApproveActionPlans: true,
            onlyReportersCanSetTasksDone: true,
            agentChangeBlockedBranches: true,
          },
        },
        epic: { select: { status: true, actingManagerId: true, branchName: true, commitPrefix: true, workItemKey: true } },
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
        error: task.blockedBy.private || task.blockedBy.epic?.private || task.blockedBy.parent?.private || task.blockedBy.parent?.epic?.private
          ? "Task is blocked by another task, which must reach Done first."
          : `Task is blocked by ${task.blockedBy.workItemKey ?? "another task"}, which must reach Done first.`,
        blockedBy: task.blockedBy.private || task.blockedBy.epic?.private || task.blockedBy.parent?.private || task.blockedBy.parent?.epic?.private
          ? null
          : task.blockedBy.workItemKey ?? null,
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
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be In Progress before task work starts" }, { status: 409 });

    await moveTaskStatus({
      taskId: task.id,
      projectId: task.projectId,
      actorUserId: agent.user.id,
      from: task.status,
      to: "In Progress",
      action,
    });
    await promoteEpicOnTaskInProgress(db, {
      epicId: task.epicId,
      projectId: task.projectId,
      actorId: agent.user.id,
      via: "agent-workflow",
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
      const autoStart = await startApprovedTodoTaskIfIdle({
        taskId: task.id,
        actor,
        via: "agent-action-plan-approval",
      });
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: task.assigneeId,
        actor,
        reason: "todo_start_required",
        body: autoStart.started
          ? [
              `The Action Plan for "${task.title}" was approved by @${agent.user.username}.`,
              "PM moved the task to In Progress because you have no other In Progress task.",
              "Start implementing the approved plan now. Do not post a visible acknowledgement unless a blocker or material plan change appears.",
            ].join("\n")
          : [
              `The Action Plan for "${task.title}" was approved by @${agent.user.username}.`,
              autoStart.reason === "busy"
                ? "You already have another In Progress task, so this task remains in To Do until you are idle."
                : "You may now call the workflow endpoint with action=start, move the task to In Progress, and implement the approved plan.",
              "Do not post a visible acknowledgement unless a blocker or material plan change appears.",
            ].join("\n"),
      });
    } else {
      // No assignee: assign in the same request instead of asking the
      // reviewer to call back with assign_after_plan_approval — that
      // round-trip 403'd for epic-fallback reviewers and stalled approved
      // tasks indefinitely.
      let autoAssigned = false;
      if (task.epicId) {
        const refill = await refillEpicQueue({
          epicId: task.epicId,
          actor,
          via: "agent-plan-approval",
          contextLine: `The Action Plan for "${task.title}" was approved by @${agent.user.username}.`,
        });
        // Only THIS task being assigned counts — the refill may have handed a
        // different queue-head task to the free worker while the just-approved
        // one stayed unassigned. Conflating the two suppressed the reviewer
        // fallback and stranded the approved task silently.
        autoAssigned = refill.assignments.some((a) => a.task.id === task.id);
        for (const assigned of refill.assignments) {
          revalidateTaskShell(assigned.task.id);
          revalidatePath(`/projects/${task.project.slug}/tasks/${assigned.task.id}`);
        }
      } else {
        const result = await assignTaskAfterPlanApproval({
          taskId: task.id,
          actor,
        });
        autoAssigned = result.ok;
      }
      if (!autoAssigned && reviewerId) {
        await sendTaskWorkflowNotification({
          taskId: task.id,
          targetUserId: reviewerId,
          actor,
          reason: "reviewer_assignment_requested",
          body: [
            `The Action Plan for "${task.title}" was approved by @${agent.user.username}, but the task has no assignee and no pool worker is free right now.`,
            "PM will assign it automatically when a worker frees up. You may also call the workflow endpoint with action=assign_after_plan_approval to assign it explicitly.",
            "Do not start implementation yourself.",
          ].join("\n"),
        });
      }
    }
    if (comment) revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({ ok: true, taskId: task.id, approved: true, status: moveToTodo ? "To Do" : task.status });
  }

  if (action === "assign_after_plan_approval") {
    // Accept the RESOLVED reviewer (task acting manager -> In Progress epic
    // acting manager -> reporter), not just the raw task.actingManagerId —
    // PM nominates epic-fallback reviewers for this exact action, and the
    // old strict check guaranteed them a 403.
    if (!isReviewer) {
      return NextResponse.json({ error: "Only the resolved task reviewer can assign this task after plan approval" }, { status: 403 });
    }
    const result = await assignTaskAfterPlanApproval({
      taskId: task.id,
      actor,
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
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be In Progress before task work advances" }, { status: 409 });

    // Resolve repoTouched. The assignee can override by sending an explicit
    // boolean; otherwise default to "yes, it touched the repo" iff the task
    // resolves a branch on a project with a repositoryPath set.
    const branchName = effectiveTaskBranchName(task);
    const codeTouching = Boolean(branchName && task.project.repositoryPath);
    const repoTouched = typeof payload.repoTouched === "boolean"
      ? payload.repoTouched
      : codeTouching;
    const resolvedCommitPrefix = effectiveTaskCommitPrefix(task);

    if (repoTouched && isProtectedBranch(task.project.agentChangeBlockedBranches, branchName)) {
      return NextResponse.json({
        error: `Agents cannot submit code-changing work from protected branch ${branchName}. Move the work to an allowed task branch, push it, then call ready_for_review again.`,
        branchName,
        protectedBranches: parseProtectedBranches(task.project.agentChangeBlockedBranches),
      }, { status: 409 });
    }

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
    // If the effective branch or repositoryPath is unset, there's nothing for the verifier to
    // check against — skip silently. If the assignee declared repoTouched=
    // false (e.g., doc-only task), also skip.
    let verifyJobId: string | null = null;
    if (repoTouched && branchName && task.project.repositoryPath) {
      const jobId = randomUUID();
      const effectiveSettings = await resolveEffectiveProjectSettings({
        id: task.projectId,
        defaultGitUserName: task.project.defaultGitUserName,
        defaultGitUserEmail: task.project.defaultGitUserEmail,
        deploymentProductionBranch: task.project.deploymentProductionBranch,
        deploymentPrTargetBranch: task.project.deploymentPrTargetBranch,
      });
      const gitIdentity = {
        name: effectiveSettings.gitIdentity.name.value,
        email: effectiveSettings.gitIdentity.email.value,
      };
      const baseBranch = effectiveSettings.deployment.prTargetBranch.value;
      try {
        await enqueueBranchVerifyJob({
          jobId,
          taskId: task.id,
          projectId: task.projectId,
          projectSlug: task.project.slug,
          repositoryPath: task.project.repositoryPath,
          branchName,
          baseBranch,
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
              branchName,
              baseBranch,
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
          "BEFORE reviewing: add the topics you will address as review sub-tasks (action=add_subtask with subtaskKind:\"review\", one per topic), then mark each complete (action=complete_subtask) as you address it — the board shows your review progress from these.",
          "Review the completed work or respond to the assignee's blocker/question using the full task context. If satisfied, move the task to Done through the workflow endpoint without posting an approval-only comment. If changes or blockers remain, leave concise feedback while keeping it in Review.",
        ].filter(Boolean).join("\n"),
      });
    }
    // A task entering Review frees its worker (Review no longer counts
    // toward the per-agent WIP limit): immediately hand the assignee the
    // next unblocked To Do task in the epic queue so nobody idles while a
    // reviewer looks at finished work.
    if (task.epicId && task.status !== "Review") {
      const refill = await refillEpicQueue({
        epicId: task.epicId,
        actor,
        via: "ready-for-review",
        // 2b: hand the agent that just moved this task to Review the Epic's
        // next unblocked task, so the same worker keeps driving its branch.
        preferUserId: actor.id,
        contextLine: `"${task.title}" moved to Review — your review-stage feedback there stays priority one.`,
      });
      for (const assigned of refill.assignments) {
        revalidateTaskShell(assigned.task.id);
        revalidatePath(`/projects/${task.project.slug}/tasks/${assigned.task.id}`);
      }
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

    // Feedback work is the assignee's top priority (WORKFLOW.md § Picking your
    // next task, tier 1), so the task returns to the FRONT of this project's
    // To Do column — not the back of a global queue.
    const minRank = await db.task.aggregate({
      where: { projectId: task.projectId, status: "To Do", deletedAt: null },
      _min: { rank: true },
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
          rank: (minRank._min.rank ?? 0) - 1,
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
          `Review feedback for "${task.title}" moved the task back to To Do, at the front of the queue.`,
          "Unanswered review feedback is your top priority — address it before starting or resuming any other task (WORKFLOW.md § Picking your next task, tier 1).",
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
    for (const next of completion.nextTasks ?? []) {
      revalidateTaskShell(next.id);
      revalidatePath(`/projects/${task.project.slug}/tasks/${next.id}`);
    }
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: "Done",
      nextTask: completion.nextTask,
      nextTasks: completion.nextTasks,
    });
  }

  if (action === "triage_to_todo") {
    if (!isReviewer) return NextResponse.json({ error: "Only the reviewer, In Progress Epic manager, or reporter fallback can move Backlog to To Do" }, { status: 403 });
    if (task.status !== "Backlog") return NextResponse.json({ error: "Task must be in Backlog before triage to To Do" }, { status: 409 });
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be In Progress before task work becomes actionable" }, { status: 409 });

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
    // Implementation checklist items belong to the assignee; review checklist
    // items (the reviewer's topics-to-address list) belong to the resolved
    // reviewer. Both phases share the SubTask table, discriminated by kind.
    const kind = normalizeSubTaskKind(payload.subtaskKind);
    if (kind === "review") {
      if (!isReviewer) return NextResponse.json({ error: "Only the resolved reviewer can add review sub-tasks" }, { status: 403 });
    } else if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can add implementation sub-tasks" }, { status: 403 });
    }
    const text = typeof payload.subtaskText === "string" ? payload.subtaskText.trim() : "";
    if (!text) return NextResponse.json({ error: "subtaskText is required" }, { status: 400 });
    let created: { id: string } | null = null;
    try {
      created = await createSubTaskItem({ taskId: task.id, text, actorUserId: agent.user.id, kind });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Could not add sub-task" }, { status: 409 });
    }
    if (!created) return NextResponse.json({ error: "subtaskText is required" }, { status: 400 });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    return NextResponse.json({ ok: true, taskId: task.id, subtaskId: created.id, subtaskKind: kind });
  }

  if (action === "complete_subtask") {
    const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : "";
    if (!subtaskId) return NextResponse.json({ error: "subtaskId is required" }, { status: 400 });
    const subtaskRow = await db.subTask.findFirst({
      where: { id: subtaskId, taskId: task.id },
      select: { kind: true },
    });
    if (!subtaskRow) return NextResponse.json({ error: "Sub-task not found on this task" }, { status: 404 });
    if (subtaskRow.kind === "review") {
      if (!isReviewer) return NextResponse.json({ error: "Only the resolved reviewer can update review sub-tasks" }, { status: 403 });
    } else if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can update implementation sub-tasks" }, { status: 403 });
    }
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

  // Scope-negotiation flow (all in comments): a reviewer/manager asks the
  // assignee for extra implementation sub-tasks; an assignee asks the epic
  // acting manager for a new task; and the assignee can flag an extra-work
  // request as a blocker rather than silently absorbing scope. The requester
  // never mutates the other actor's work directly — they post a described
  // request and PM wakes the owner of that work to accept or push back.
  const requesterUserId = agent.user.id;
  const requesterSlug = agent.slug;
  const requestTaskId = task.id;
  const requestProjectId = task.projectId;
  async function postWorkflowComment(body: string, kind: string) {
    const created = await db.comment.create({
      data: { taskId: requestTaskId, userId: requesterUserId, body },
      select: { id: true },
    });
    await db.activityLog.create({
      data: {
        projectId: requestProjectId,
        taskId: requestTaskId,
        userId: requesterUserId,
        kind,
        targetAgent: requesterSlug,
        payload: JSON.stringify({ commentId: created.id, action }),
      },
    });
    return created.id;
  }

  if (action === "request_subtask") {
    // Reviewer/acting-manager -> assignee: request an implementation sub-task.
    if (!isReviewer) {
      return NextResponse.json({ error: "Only the resolved reviewer or acting manager can request a sub-task from the assignee" }, { status: 403 });
    }
    const subtaskText = typeof payload.subtaskText === "string" ? payload.subtaskText.trim() : "";
    const reason = comment;
    if (!subtaskText) return NextResponse.json({ error: "subtaskText is required" }, { status: 400 });
    if (!reason) return NextResponse.json({ error: "comment (the reason for the requested sub-task) is required" }, { status: 400 });
    if (!task.assigneeId) return NextResponse.json({ error: "Task has no assignee to receive the request" }, { status: 409 });
    const commentId = await postWorkflowComment(
      [
        `**Sub-task requested** by @${agent.user.username} (reviewer):`,
        `- ${subtaskText}`,
        "",
        `Reason: ${reason}`,
        "",
        "@assignee: add this via action=add_subtask if you agree, or call action=flag_extra_work_blocker with a reason if it blocks the current scope / needs an owner decision.",
      ].join("\n"),
      "task.subtask.requested",
    );
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: task.assigneeId,
      actor,
      reason: "subtask_requested",
      body: [
        `Reviewer @${agent.user.username} requested a new sub-task on "${task.title}":`,
        `"${subtaskText}" — reason: ${reason}`,
        "Add it with action=add_subtask (subtaskKind=implementation) if you agree, or call action=flag_extra_work_blocker with a reason if it should block or needs an owner decision.",
      ].join("\n"),
    });
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    return NextResponse.json({ ok: true, taskId: task.id, requested: "subtask", commentId });
  }

  if (action === "request_task") {
    // Assignee -> epic acting manager: request a new Epic task.
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can request a new task" }, { status: 403 });
    }
    if (!task.epicId || !task.epic) {
      return NextResponse.json({ error: "Task is not under an Epic, so there is no acting manager to request a task from" }, { status: 409 });
    }
    const managerUserId = task.epic.actingManagerId;
    if (!managerUserId) {
      return NextResponse.json({ error: "The Epic has no acting manager to receive the request" }, { status: 409 });
    }
    const requestedTitle = typeof payload.subtaskText === "string" ? payload.subtaskText.trim() : "";
    const reason = comment;
    if (!requestedTitle) return NextResponse.json({ error: "subtaskText (the requested task title) is required" }, { status: 400 });
    if (!reason) return NextResponse.json({ error: "comment (the reason for the requested task) is required" }, { status: 400 });
    const commentId = await postWorkflowComment(
      [
        `**New Epic task requested** by @${agent.user.username} (assignee):`,
        `- ${requestedTitle}`,
        "",
        `Reason: ${reason}`,
        "",
        "@acting-manager: create it via the Epic workflow (action=create_tasks) if you agree, or reply here if it should be deferred.",
      ].join("\n"),
      "task.task.requested",
    );
    await sendTaskWorkflowNotification({
      taskId: task.id,
      targetUserId: managerUserId,
      actor,
      reason: "task_requested",
      body: [
        `Assignee @${agent.user.username} requested a new Epic task from "${task.title}":`,
        `"${requestedTitle}" — reason: ${reason}`,
        "If you agree, create it through the Epic manager workflow (action=create_tasks) so it enters the ordered queue. Otherwise reply with why it is deferred.",
      ].join("\n"),
    });
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    return NextResponse.json({ ok: true, taskId: task.id, requested: "task", commentId });
  }

  if (action === "flag_extra_work_blocker") {
    // Assignee flags a requested extra sub-task/task as blocking scope: raise
    // it to the owner (alert_reporter) and notify the reviewer + reporter.
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can flag extra-work as a blocker" }, { status: 403 });
    }
    const reason = comment;
    if (!reason) return NextResponse.json({ error: "comment (why the extra work blocks) is required" }, { status: 400 });
    const commentId = await postWorkflowComment(
      [
        `**Extra-work blocker raised** by @${agent.user.username} (assignee):`,
        "",
        reason,
        "",
        "This extra scope needs a decision before it is absorbed into the current task.",
      ].join("\n"),
      "task.extra_work.blocker",
    );
    await db.task.update({ where: { id: task.id }, data: { alertReporter: true } });
    const targets = new Set<string>();
    if (reviewerId) targets.add(reviewerId);
    if (task.reporterId) targets.add(task.reporterId);
    for (const targetUserId of targets) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId,
        actor,
        reason: "extra_work_blocker",
        body: [
          `Assignee @${agent.user.username} flagged requested extra work on "${task.title}" as a blocker:`,
          reason,
          "Decide whether the extra scope is in or out before the task proceeds.",
        ].join("\n"),
      });
    }
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    return NextResponse.json({ ok: true, taskId: task.id, flagged: "extra_work_blocker", commentId });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
