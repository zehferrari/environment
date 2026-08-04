import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
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
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import { createActionPlanSubtasksForTask } from "@/lib/tasks/action-plan-subtasks";
import { findInProgressStartConflict, startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";
import { runTaskReviewHandoff } from "@/lib/tasks/review-handoff";
import { createSubTaskItem, deleteSubTaskItem, normalizeSubTaskKind, setSubTaskCompletion } from "@/lib/tasks/subtasks";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { publishBoardTouch } from "@/lib/pm/board-events";
import { assignTaskAfterPlanApproval } from "@/lib/tasks/reviewer-assignment";
import { refillEpicQueue } from "@/lib/epics/queue";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { hasAuthorizedTaskAgentOrigin } from "@/lib/agents/owner-origin";
import {
  ensureTaskCodeWorktree,
  TaskWorktreeError,
} from "@/lib/tasks/worktree-claim";
import { reserveTaskRepositoryState } from "@/lib/tasks/repository-state";
import { enqueueTaskCheckpoint } from "@/lib/deploy/epic-merge";
import {
  activityPayloadUsesCheckpointAuthorization,
  validateCheckpointAuthorizationText,
} from "@/lib/deploy/checkpoint-authorization";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import {
  blockerMetadataFromPayload,
  blockerPermissionGrantForComment,
  isBlockerPermissionKind,
  type BlockerPermissionRequest,
} from "@/lib/tasks/formal-blocker";
import { hasNewerIndependentTaskAlert } from "@/lib/tasks/checkpoint-blocker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = [
  "start",
  "publish_checkpoint",
  "ready_for_review",
  "submit_review",
  "review_feedback",
  "review_done",
  "triage_to_todo",
  "approve_plan",
  "assign_after_plan_approval",
  "add_subtask",
  "complete_subtask",
  "remove_subtask",
  "request_subtask",
  "request_task",
  "flag_blocker",
  "clear_blocker",
  "flag_extra_work_blocker",
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
    assignee?: unknown;
    authorizationCommentId?: unknown;
    permissionKind?: unknown;
    permissionScope?: unknown;
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
        role: true,
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
        repositoryRun: { select: { phase: true, worktreePath: true } },
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
        epic: { select: { id: true, status: true, actingManagerId: true, branchName: true, commitPrefix: true, workItemKey: true } },
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
    if (agent.role !== "coding") {
      return NextResponse.json({ error: "Only an implementation-capable agent may start repository work" }, { status: 403 });
    }
    // P1: start is To Do → In Progress ONLY. There is no resume from Review —
    // a task not promoted to Done comes back via the reviewer's
    // review_feedback, which returns it to the FRONT of To Do.
    if (task.status !== "To Do") {
      return NextResponse.json({
        error: task.status === "Review"
          ? "start cannot resume a task from Review. If the reviewer leaves feedback (review_feedback), the task returns to the front of To Do and must be started from there. If the work is complete and this task is already in Review, there is nothing to start."
          : "Task must be in To Do before start.",
        currentStatus: task.status,
      }, { status: 409 });
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
    if (!task.approvedOn) {
      return NextResponse.json({ error: "Action Plan must be approved before start" }, { status: 409 });
    }
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be In Progress before task work starts" }, { status: 409 });

    // P4: every entry into In Progress passes the shared per-project WIP +
    // effective-branch-clash gate (same helper as PM auto-start).
    const startConflict = await findInProgressStartConflict(db, {
      taskId: task.id,
      projectId: task.projectId,
      assigneeId: agent.user.id,
      candidateBranch: effectiveTaskBranchName(task),
    });
    if (startConflict) {
      const conflictRef = startConflict.activeTask.workItemKey ?? startConflict.activeTask.title;
      return NextResponse.json({
        error: startConflict.kind === "wip"
          ? `You already have an In Progress task in this project (${conflictRef}). The WIP limit is 1 In Progress task per agent per project: finish that task first (call ready_for_review on it), then start this one.`
          : `Another In Progress task (${conflictRef}) resolves to the same effective branch as this one. Wait for it to leave In Progress (ready_for_review) before starting this task — two tasks must never work one branch at once.`,
        conflict: {
          kind: startConflict.kind,
          taskId: startConflict.activeTask.id,
          workItemKey: startConflict.activeTask.workItemKey ?? null,
          title: startConflict.activeTask.title,
        },
      }, { status: 409 });
    }

    let worktree;
    try {
      // In Progress is the provisioning boundary. Approval reserved the
      // repository contract but deliberately did not create a writable tree.
      worktree = await ensureTaskCodeWorktree(task.id, agent.user.id);
    } catch (err) {
      const message = err instanceof TaskWorktreeError
        ? err.message
        : "Task worktree could not be created or validated.";
      return NextResponse.json({ error: message }, { status: 409 });
    }

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
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: "In Progress",
      worktreePath: worktree.required ? worktree.worktreePath : null,
      branchName: worktree.required ? worktree.branchName : null,
    });
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
    // Approval reserves the repository contract only. The writable worktree
    // is created at the In Progress boundary immediately before dispatch.
    const reservation = await reserveTaskRepositoryState(task.id);
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
    let startedAfterApproval = false;
    if (task.assigneeId) {
      const autoStart = await startApprovedTodoTaskIfIdle({
        taskId: task.id,
        actor,
        via: "agent-action-plan-approval",
      });
      startedAfterApproval = autoStart.started;
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
                ? "You already have another In Progress task in this project, so this task remains in To Do until you are idle."
                : autoStart.reason === "worktree_unavailable"
                  ? `PM left the task in To Do because its linked worktree is unavailable: ${autoStart.worktreeError}`
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
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      approved: true,
      status: startedAfterApproval ? "In Progress" : moveToTodo ? "To Do" : task.status,
      repositoryPhase: startedAfterApproval ? "active" : reservation?.phase ?? null,
      worktreePath: null,
      branchName: reservation?.branchName ?? null,
    });
  }

  if (action === "assign_after_plan_approval") {
    // Accept the RESOLVED reviewer (task acting manager -> In Progress epic
    // acting manager -> reporter), not just the raw task.actingManagerId —
    // PM nominates epic-fallback reviewers for this exact action, and the
    // old strict check guaranteed them a 403.
    if (!isReviewer) {
      return NextResponse.json({ error: "Only the resolved task reviewer can assign this task after plan approval" }, { status: 403 });
    }
    // P2: the reviewer may pick the assignee explicitly ({assignee:
    // "<username>"}) on an unassigned task regardless of plan state — the
    // chosen assignee then authors the Action Plan (assignee-only authorship).
    const requestedAssignee = typeof payload.assignee === "string"
      ? payload.assignee.trim().replace(/^@/, "")
      : "";
    const result = await assignTaskAfterPlanApproval({
      taskId: task.id,
      actor,
      assigneeUsername: requestedAssignee || undefined,
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
      planRequested: result.planRequested,
    });
  }

  if (action === "publish_checkpoint") {
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the current assignee can request a repository checkpoint" }, { status: 403 });
    }
    if (agent.role !== "coding") {
      return NextResponse.json({ error: "Only an implementation-capable assignee may publish a repository checkpoint" }, { status: 403 });
    }
    if (task.status !== "In Progress" || !task.approvedOn) {
      return NextResponse.json({ error: "A checkpoint requires an approved In Progress task" }, { status: 409 });
    }
    if (!task.epic || task.epic.status !== "In Progress") {
      return NextResponse.json({ error: "A checkpoint is available only for a task under an In Progress Epic" }, { status: 409 });
    }
    if (task.repositoryRun?.phase !== "active" || !task.repositoryRun.worktreePath) {
      return NextResponse.json({
        error: `The task repository must be active before checkpoint publication (current phase: ${task.repositoryRun?.phase ?? "missing"}).`,
      }, { status: 409 });
    }
    if (!comment) {
      return NextResponse.json({
        error: "comment is required and must explain why an intermediate published checkpoint is needed",
      }, { status: 400 });
    }

    const authorizationCommentId = typeof payload.authorizationCommentId === "string"
      ? payload.authorizationCommentId.trim()
      : "";
    if (!authorizationCommentId) {
      return NextResponse.json({
        error: "authorizationCommentId is required; cite the active owner's explicit checkpoint/deployment authorization comment",
      }, { status: 400 });
    }
    const authorization = await db.comment.findUnique({
      where: { id: authorizationCommentId },
      select: {
        taskId: true,
        body: true,
        createdAt: true,
        deletedAt: true,
        user: { select: { id: true, kind: true, status: true, isOwner: true } },
      },
    });
    if (
      !authorization ||
      authorization.taskId !== task.id ||
      authorization.deletedAt ||
      authorization.createdAt < task.approvedOn ||
      authorization.user.kind !== "human" ||
      authorization.user.status !== "active" ||
      !authorization.user.isOwner
    ) {
      return NextResponse.json({
        error: "Checkpoint authorization must be a live comment on this task, written by the active Mission Control owner after the current Action Plan approval",
      }, { status: 403 });
    }

    const taskBranch = effectiveTaskBranchName(task);
    const epicBranch = effectiveEpicBranchName(task.epic);
    if (!task.project.repositoryPath || !taskBranch || !epicBranch || taskBranch === epicBranch) {
      return NextResponse.json({
        error: "publish_checkpoint requires a repository-backed Epic child with its own local-only task branch",
      }, { status: 409 });
    }
    if (isProtectedBranch(task.project.agentChangeBlockedBranches, epicBranch)) {
      return NextResponse.json({
        error: `The Epic integration branch ${epicBranch} is protected from agent-originated repository changes`,
      }, { status: 409 });
    }

    const explicitAuthorization = validateCheckpointAuthorizationText({
      body: authorization.body,
      taskKey: task.workItemKey,
      taskBranch,
      epicBranch,
    });
    if (!explicitAuthorization.ok) {
      return NextResponse.json({
        error: `The cited owner comment is not an explicit checkpoint capability: ${explicitAuthorization.reason}`,
      }, { status: 403 });
    }
    const priorAuthorizationUses = await db.activityLog.findMany({
      where: {
        taskId: task.id,
        kind: { in: ["pm.repo.checkpoint.enqueue", "pm.repo.checkpoint.ok"] },
      },
      select: { payload: true },
    });
    if (priorAuthorizationUses.some((entry) =>
      activityPayloadUsesCheckpointAuthorization(entry.payload, authorizationCommentId)
    )) {
      return NextResponse.json({
        error: "That owner checkpoint authorization has already been consumed. Obtain a new explicit owner authorization for another publication.",
      }, { status: 409 });
    }

    let checkpoint;
    try {
      checkpoint = await enqueueTaskCheckpoint({
        taskId: task.id,
        projectId: task.projectId,
        requestedByUserId: agent.user.id,
        requestedByUsername: agent.user.username,
        authorizationCommentId,
        note: comment,
      });
    } catch (err) {
      return NextResponse.json({
        error: `PM could not enqueue the repository checkpoint: ${err instanceof Error ? err.message : String(err)}`,
      }, { status: 503 });
    }
    if (checkpoint.blockedByFailedJob) {
      return NextResponse.json({
        error: "A previous checkpoint runner job is marked failed and needs operator retry/cleanup before another can be queued",
        jobId: checkpoint.jobId,
      }, { status: 409 });
    }

    if (checkpoint.enqueued) {
      await db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: agent.user.id,
          kind: "pm.repo.checkpoint.enqueue",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            jobId: checkpoint.jobId,
            taskBranch,
            epicBranch,
            authorizationCommentId,
          }),
        },
      });
    }
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    publishBoardTouch(task.projectId);
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: "In Progress",
      repositoryPhase: task.repositoryRun.phase,
      checkpointJobId: checkpoint.jobId,
      queued: checkpoint.enqueued,
      alreadyQueued: !checkpoint.enqueued,
      taskBranch,
      epicBranch,
    });
  }

  if (action === "ready_for_review" || action === "submit_review") {
    if (!isAssignee) return NextResponse.json({ error: "Only the assignee can send this task to Review" }, { status: 403 });
    if (agent.role !== "coding") {
      return NextResponse.json({ error: "Only an implementation-capable assignee may submit repository work" }, { status: 403 });
    }
    if (task.status !== "In Progress") {
      return NextResponse.json({ error: "Task must be In Progress before ready_for_review" }, { status: 409 });
    }
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be In Progress before task work advances" }, { status: 409 });

    // P3: the implementation checklist is the progress contract — a task with
    // open implementation sub-tasks is by definition not ready for review.
    const openImplementationSubtasks = await db.subTask.findMany({
      where: { taskId: task.id, completedAt: null, kind: { not: "review" } },
      orderBy: { rank: "asc" },
      select: { id: true, text: true },
    });
    if (openImplementationSubtasks.length > 0) {
      return NextResponse.json({
        error: [
          `ready_for_review rejected: ${openImplementationSubtasks.length} implementation sub-task(s) are still open.`,
          "Tick each completed one with action=complete_subtask (you must tick sub-tasks the moment they complete), or delete/convert stale items that no longer apply, then call ready_for_review again.",
          "Open items:",
          ...openImplementationSubtasks.map((s) => `- ${s.text} (id: ${s.id})`),
        ].join("\n"),
        openImplementationSubtasks: openImplementationSubtasks.map((s) => ({ id: s.id, text: s.text })),
      }, { status: 409 });
    }

    // Resolve repoTouched. The assignee can override by sending an explicit
    // boolean; otherwise default to "yes, it touched the repo" iff the task
    // resolves a branch on a project with a repositoryPath set.
    const branchName = effectiveTaskBranchName(task);
    const codeTouching = Boolean(branchName && task.project.repositoryPath);
    const repoTouched = typeof payload.repoTouched === "boolean"
      ? payload.repoTouched
      : codeTouching;

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

    // Code work remains In Progress while the role-resolved Monitor Agent
    // validates it. The handoff itself moves only validated work to Review.
    const handoff = await runTaskReviewHandoff({
      taskId: task.id,
      actor,
      via: "ready-for-review",
      movedFromStatus: task.status,
      repoTouched,
      assigneeNote: comment || null,
    });
    for (const assigned of handoff.refillAssignments) {
      revalidatePath(`/projects/${task.project.slug}/tasks/${assigned.taskId}`);
    }
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: handoff.status,
      repositoryPhase: handoff.repositoryPhase,
      verifyJobId: handoff.verifyJobId,
      repoTouched: handoff.repoTouched,
      commentId: reviewCommentId,
      operationalError: handoff.repositoryPhase === "operational_error"
        ? handoff.error ?? "Repository validation could not start."
        : null,
    });
  }

  if (action === "review_feedback") {
    if (!isReviewer) return NextResponse.json({ error: "Only the resolved reviewer can leave workflow feedback" }, { status: 403 });
    if (task.status !== "Review") return NextResponse.json({ error: "Task must be in Review for review feedback" }, { status: 409 });
    if (task.repositoryRun?.phase === "finalizing") {
      return NextResponse.json({
        error: "Repository finalization is already running; review feedback can no longer reopen this submission.",
      }, { status: 409 });
    }
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
          "Unanswered review feedback is your top priority — address it before starting any other task (WORKFLOW.md § Picking your next task, tier 1).",
          "Add a sub-task (action=add_subtask) for each concrete item in the reviewer's feedback BEFORE starting, so the progress checklist reflects the remaining work and the board bar stays honest (your earlier items are already ticked). Tick each new item off (with minutesSpent) as you address it.",
          "Keep the approved Action Plan unless a material plan change is required, then start the task from To Do through the workflow endpoint (action=start).",
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
      status: completion.status,
      repositoryPhase: completion.finalizing ? "finalizing" : "completed",
      nextTask: completion.nextTask,
      nextTasks: completion.nextTasks,
    });
  }

  if (action === "triage_to_todo") {
    if (!isReviewer) return NextResponse.json({ error: "Only the reviewer, actionable Epic manager, or reporter fallback can move Backlog to To Do" }, { status: 403 });
    if (task.status !== "Backlog") return NextResponse.json({ error: "Task must be in Backlog before triage to To Do" }, { status: 409 });
    if (!epicAllowsAgentAction(task)) return NextResponse.json({ error: "Epic must be To Do or In Progress before task work becomes actionable" }, { status: 409 });

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
    // The sub-task row is a durable outcome of this turn: settle the PM run
    // so a post-action gateway abort cannot mask the completed work (PH-124).
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
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

    // Close the loop (PH-124): when the assignee ticks the LAST open
    // implementation sub-task on an In Progress task, tell them — in this
    // same response, while they still hold a valid reusable token — to call
    // ready_for_review immediately, and belt-and-braces dispatch a fresh
    // workflow turn in case this turn ends without acting.
    let allImplementationSubtasksComplete = false;
    if (
      result.completedAt !== null &&
      subtaskRow.kind !== "review" &&
      isAssignee &&
      task.status === "In Progress"
    ) {
      const remainingOpen = await db.subTask.count({
        where: { taskId: task.id, completedAt: null, kind: { not: "review" } },
      });
      if (remainingOpen === 0) {
        allImplementationSubtasksComplete = true;
        await sendTaskWorkflowNotification({
          taskId: task.id,
          targetUserId: agent.user.id,
          actor,
          reason: "ready_for_review_available",
          body: [
            `All implementation sub-tasks on "${task.title}" are complete.`,
            "Verify every sub-task is genuinely ticked and the work is committed per the commit-hygiene rules, then call the workflow endpoint with action=ready_for_review NOW.",
            "Do not leave finished work sitting in In Progress, and do not post an acknowledgement-only reply.",
          ].join("\n"),
        });
      }
    }
    // Durable outcome: the tick/reopen persisted, so settle the PM run. The
    // ready_for_review_available notification above targets a NEW messageId
    // (its own run), so settling this grant's run does not interfere.
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      subtaskId,
      completed: result.completedAt !== null,
      minutesSpent: result.minutesSpent,
      ...(allImplementationSubtasksComplete
        ? {
            allImplementationSubtasksComplete: true,
            instruction:
              "All implementation sub-tasks are complete — call action=ready_for_review NOW with this same messageId and token (workflow tokens are reusable; you already hold everything you need).",
          }
        : {}),
    });
  }

  if (action === "remove_subtask") {
    const subtaskId = typeof payload.subtaskId === "string" ? payload.subtaskId : "";
    if (!subtaskId) return NextResponse.json({ error: "subtaskId is required" }, { status: 400 });
    const subtaskRow = await db.subTask.findFirst({
      where: { id: subtaskId, taskId: task.id },
      select: { kind: true },
    });
    if (!subtaskRow) return NextResponse.json({ error: "Sub-task not found on this task" }, { status: 404 });
    if (subtaskRow.kind === "review") {
      if (!isReviewer) return NextResponse.json({ error: "Only the resolved reviewer can remove review sub-tasks" }, { status: 403 });
    } else if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can remove implementation sub-tasks" }, { status: 403 });
    }
    const removed = await deleteSubTaskItem({
      subTaskId: subtaskId,
      actorUserId: agent.user.id,
      expectTaskId: task.id,
    });
    if (!removed) return NextResponse.json({ error: "Sub-task not found on this task" }, { status: 404 });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    return NextResponse.json({ ok: true, taskId: task.id, subtaskId, removed: true });
  }

  // Scope-negotiation flow (all in comments): a reviewer/manager asks the
  // assignee for extra implementation sub-tasks; an assignee asks the epic
  // acting manager for a new task; and the assignee can flag an extra-work
  // request as a blocker rather than silently absorbing scope. The requester
  // never mutates the other actor's work directly — they post a described
  // request and PM wakes the owner of that work to accept or push back.
  const requesterUserId = agent.user.id;
  const requesterUsername = agent.user.username;
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

  if (action === "flag_blocker") {
    // Durable escalation for infrastructure, credentials, access, external
    // services, or human decisions that the active assignee cannot resolve.
    // The task stays In Progress: Review remains reserved for completed work.
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can flag an active blocker" }, { status: 403 });
    }
    if (task.status !== "In Progress") {
      return NextResponse.json({ error: "A general blocker can be flagged only while the task is In Progress" }, { status: 409 });
    }
    if (!comment) {
      return NextResponse.json({ error: "comment (the blocker and required intervention) is required" }, { status: 400 });
    }
    const requestedPermissionKind = payload.permissionKind == null
      ? null
      : isBlockerPermissionKind(payload.permissionKind)
        ? payload.permissionKind
        : undefined;
    if (requestedPermissionKind === undefined) {
      return NextResponse.json({
        error: "permissionKind must be reporter_approval or publish_checkpoint when this is a permission-only blocker",
      }, { status: 400 });
    }
    const permissionScope = typeof payload.permissionScope === "string"
      ? payload.permissionScope.trim()
      : "";
    if (permissionScope.length > 500) {
      return NextResponse.json({ error: "permissionScope must be <= 500 chars" }, { status: 400 });
    }
    if (requestedPermissionKind && !task.reporterId) {
      return NextResponse.json({ error: "A permission-only blocker requires a task reporter" }, { status: 409 });
    }

    let permissionRequest: BlockerPermissionRequest | null = null;
    if (requestedPermissionKind === "reporter_approval") {
      if (!permissionScope) {
        return NextResponse.json({
          error: "permissionScope is required for reporter_approval and must name the exact action the reporter is being asked to authorize",
        }, { status: 400 });
      }
      permissionRequest = { kind: requestedPermissionKind, scope: permissionScope };
    } else if (requestedPermissionKind === "publish_checkpoint") {
      const taskBranch = effectiveTaskBranchName(task);
      const epicBranch = task.epic ? effectiveEpicBranchName(task.epic) : null;
      if (
        agent.role !== "coding" ||
        !task.approvedOn ||
        !task.epic ||
        task.epic.status !== "In Progress" ||
        task.repositoryRun?.phase !== "active" ||
        !task.repositoryRun.worktreePath ||
        !task.project.repositoryPath ||
        !taskBranch ||
        !epicBranch ||
        taskBranch === epicBranch
      ) {
        return NextResponse.json({
          error: "publish_checkpoint permission can be requested only for an approved, active repository-backed Epic child with its own task branch",
        }, { status: 409 });
      }
      if (isProtectedBranch(task.project.agentChangeBlockedBranches, epicBranch)) {
        return NextResponse.json({
          error: `The Epic integration branch ${epicBranch} is protected from agent-originated repository changes`,
        }, { status: 409 });
      }
      permissionRequest = {
        kind: requestedPermissionKind,
        scope: permissionScope || `Publish the current ${task.workItemKey ?? taskBranch} checkpoint to ${epicBranch} for deployment-dependent verification.`,
        taskKey: task.workItemKey,
        taskBranch,
        epicBranch,
      };
    }
    const latestBlocker = await db.activityLog.findFirst({
      where: {
        taskId: task.id,
        kind: { in: ["task.blocker", "task.extra_work.blocker", "task.blocker.cleared"] },
      },
      orderBy: { createdAt: "desc" },
      select: { kind: true, payload: true },
    });
    if (latestBlocker && latestBlocker.kind !== "task.blocker.cleared") {
      await recordPmChannelRunWorkflowAction({
        taskId: task.id,
        agentSlug: agent.slug,
        messageId,
        action,
      });
      if (requestedPermissionKind) {
        const activeMetadata = blockerMetadataFromPayload(latestBlocker.payload);
        const permissionGrant = activeMetadata.commentId
          ? blockerPermissionGrantForComment(await db.activityLog.findMany({
              where: { taskId: task.id, kind: "task.blocker.permission.granted" },
              orderBy: { createdAt: "desc" },
              select: { kind: true, payload: true },
            }), activeMetadata.commentId)
          : null;
        const sameRequest =
          activeMetadata.permissionRequest?.kind === permissionRequest?.kind &&
          activeMetadata.permissionRequest?.scope === permissionRequest?.scope;
        if (!sameRequest || permissionGrant) {
          return NextResponse.json({
            error: permissionGrant
              ? "The active permission blocker is already granted and agent-actionable. Use the returned authorizationCommentId for that exact operation; PM closes this permission round automatically when the checkpoint attempt settles. Do not reuse it or create another request inside the same round."
              : "A different formal blocker is already active. Clear it with evidence before creating a new permission request.",
            activeBlockerCommentId: activeMetadata.commentId,
            authorizationCommentId: permissionGrant?.authorizationCommentId ?? null,
          }, { status: 409 });
        }
      }
      return NextResponse.json({ ok: true, taskId: task.id, flagged: "blocker", alreadyFlagged: true });
    }

    const created = await db.$transaction(async (tx) => {
      const row = await tx.comment.create({
        data: {
          taskId: task.id,
          userId: requesterUserId,
          body: [
            `**Blocker raised** by @${requesterUsername} (assignee):`,
            "",
            comment,
            ...(permissionRequest ? [
              "",
              `**Reporter permission requested:** ${permissionRequest.scope}`,
            ] : []),
            "",
            "The task remains In Progress, but active implementation is paused pending external or owner intervention.",
          ].join("\n"),
        },
        select: { id: true },
      });
      await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: requesterUserId,
          kind: "task.blocker",
          targetAgent: agent.slug,
          payload: JSON.stringify({ action, commentId: row.id, permissionRequest }),
        },
      });
      await tx.task.update({ where: { id: task.id }, data: { alertReporter: true } });
      return row;
    });
    const targets = new Set<string>();
    // A permission-only round has exactly one human decision owner: the task
    // reporter. Waking an Epic manager/reviewer coding agent here invited
    // duplicate investigation on work visibly assigned to someone else.
    if (!permissionRequest && reviewerId) targets.add(reviewerId);
    if (task.reporterId) targets.add(task.reporterId);
    for (const targetUserId of targets) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId,
        actor,
        reason: "blocker",
        body: [
          `Assignee @${agent.user.username} raised a blocker on "${task.title}":`,
          comment,
          permissionRequest
            ? `This is marked as permission-only. The task reporter can grant the narrowly scoped permission (${permissionRequest.scope}) from the blocker comment in Mission Control.`
            : "Resolve or decide the external dependency, then reply with the unblocking evidence so the assignee can clear the blocker and resume.",
        ].join("\n"),
      }).catch((error) =>
        console.error("[pm] blocker notification failed:", task.id, targetUserId, error),
      );
    }
    revalidateTaskReplyScope(task.id, "comment");
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    return NextResponse.json({ ok: true, taskId: task.id, flagged: "blocker", commentId: created.id });
  }

  if (action === "clear_blocker") {
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can clear an active blocker" }, { status: 403 });
    }
    if (task.status !== "In Progress") {
      return NextResponse.json({ error: "A blocker can be cleared only while the task is In Progress" }, { status: 409 });
    }
    if (!comment) {
      return NextResponse.json({ error: "comment (the unblocking evidence) is required" }, { status: 400 });
    }
    const latestBlocker = await db.activityLog.findFirst({
      where: {
        taskId: task.id,
        kind: { in: ["task.blocker", "task.extra_work.blocker", "task.blocker.cleared"] },
      },
      orderBy: { createdAt: "desc" },
      select: { kind: true, createdAt: true },
    });
    if (!latestBlocker || latestBlocker.kind === "task.blocker.cleared") {
      await recordPmChannelRunWorkflowAction({
        taskId: task.id,
        agentSlug: agent.slug,
        messageId,
        action,
      });
      return NextResponse.json({ ok: true, taskId: task.id, cleared: "blocker", alreadyCleared: true });
    }

    const hasNewerIndependentAlert = await hasNewerIndependentTaskAlert(
      task.id,
      latestBlocker.createdAt,
    );
    const preserveIndependentAlert =
      task.repositoryRun?.phase === "operational_error" || hasNewerIndependentAlert;
    const [created] = await db.$transaction([
      db.comment.create({
        data: {
          taskId: task.id,
          userId: agent.user.id,
          body: [
            `**Blocker cleared** by @${agent.user.username} (assignee):`,
            "",
            comment,
            "",
            preserveIndependentAlert
              ? "Active implementation may resume, but a separate operational alert remains active."
              : "Active implementation has resumed.",
          ].join("\n"),
        },
        select: { id: true },
      }),
      db.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: agent.user.id,
          kind: "task.blocker.cleared",
          targetAgent: agent.slug,
          payload: JSON.stringify({ action, preserveIndependentAlert }),
        },
      }),
      db.task.update({
        where: { id: task.id },
        data: { alertReporter: preserveIndependentAlert },
      }),
    ]);
    revalidateTaskReplyScope(task.id, "comment");
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      cleared: "blocker",
      commentId: created.id,
      independentAlertActive: preserveIndependentAlert,
    });
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
    revalidateTaskReplyScope(task.id, "comment");
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    // Durable outcome (request comment + notification): settle the PM run.
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
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
    revalidateTaskReplyScope(task.id, "comment");
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    // Durable outcome (request comment + manager notification): settle the run.
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
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
    revalidateTaskReplyScope(task.id, "comment");
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    // Durable outcome (blocker comment + alertReporter flag): settle the run.
    await recordPmChannelRunWorkflowAction({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      action,
    });
    return NextResponse.json({ ok: true, taskId: task.id, flagged: "extra_work_blocker", commentId });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
