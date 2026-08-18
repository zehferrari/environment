import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { sendTaskCommentNotifications, sendTaskWorkflowNotification } from "@/lib/agents/workflow/notifications/task";
import type { Prisma } from "@prisma/client";
import { recordPmChannelRunWorkflowAction } from "@/lib/agents/pm-channel/runs";
import { runWorkflowActionAtomically } from "@/lib/agents/workflow/transactional-action";
import { workflowActionResult } from "@/lib/agents/workflow/action-effect";
import { verifyTaskWorkflowToken } from "@/lib/agents/workflow/token/task";
import {
  canApproveActionPlanForActor,
  canSetTaskDoneForActor,
  epicAllowsAgentAction,
  resolveReviewOwnerId,
} from "@/lib/tasks/workflow-actors";
import { completeReviewedTaskAndAssignNext } from "@/lib/tasks/review-automation";
import { revalidateTaskReplyScope, revalidateTaskShell } from "@/lib/tasks/cache";
import {
  createChecklistAndDelegatableTasksFromPlan,
  persistActionPlan,
  validateActionPlanInput,
} from "@/lib/tasks/action-plan-store";
import { findInProgressStartConflict, startApprovedTodoTaskIfIdle } from "@/lib/tasks/auto-start";
import { runTaskReviewHandoff } from "@/lib/tasks/review-handoff";
import {
  REPOSITORY_FINALIZATION_FENCE_MESSAGE,
  repositoryFinalizationFenceSelect,
  repositoryFinalizationOwnsTask,
} from "@/lib/tasks/repository-finalization";
import { createSubTaskItem, deleteSubTaskItem, normalizeSubTaskKind, setSubTaskCompletion } from "@/lib/tasks/subtasks";
import { effectiveEpicBranchName, effectiveTaskBranchName } from "@/lib/work-items/branches";
import { publishBoardTouch } from "@/lib/pm/board-events";
import {
  applyTaskTransition,
  enqueueWorkflowEffects,
  isTaskWorkflowStatus,
  type WorkflowEffect,
} from "@/lib/tasks/transition-kernel";
import { drainWorkflowOutbox } from "@/lib/tasks/workflow-outbox-drain";
import { assignTaskAfterPlanApproval } from "@/lib/tasks/reviewer-assignment";
import { refillEpicQueue } from "@/lib/epics/queue";
import { promoteEpicOnTaskInProgress } from "@/lib/epics/promote-on-start";
import { unresolvedTaskPrerequisites } from "@/lib/tasks/blocking";
import { hasAuthorizedTaskAgentOrigin } from "@/lib/agents/owner-origin";
import {
  ensureTaskCodeWorktree,
  TaskWorktreeError,
} from "@/lib/tasks/worktree-claim";
import { reserveTaskRepositoryState } from "@/lib/tasks/repository-state";
import { enqueueTaskCheckpoint } from "@/lib/deploy/epic-merge";
import {
  inspectOriginBranch,
  inspectValidatedCandidateWorktree,
} from "@/lib/deploy/epic-merge-git";
import {
  activityPayloadUsesCheckpointAuthorization,
  validateCheckpointAuthorizationText,
} from "@/lib/deploy/checkpoint-authorization";
import { isProtectedBranch } from "@/lib/projects/protected-branches";
import {
  blockerDiagnosticsFingerprint,
  blockerFailureSignature,
  blockerMetadataFromPayload,
  blockerPermissionGrantForComment,
  classifyBlockerFailure,
  formalBlockerReportFromValue,
  isBlockerPermissionKind,
  type BlockerPermissionRequest,
  type FormalBlockerReport,
} from "@/lib/tasks/formal-blocker";
import { hasNewerIndependentTaskAlert } from "@/lib/tasks/checkpoint-blocker";
import {
  EPISODE_CLOSE_REASON,
  latestTaskExecutionCheckpoint,
  resolveEpisodeRolloverBarrier,
  taskExecutionEpisodeHistory,
  type EpisodeCheckpoint,
} from "@/lib/agents/episodes/lifecycle";
import {
  EPISODE_SEAL_REASON,
  sealEpisodeRolloverBarrier,
} from "@/lib/agents/episodes/rollover";
import { recordWorkflowActionExecutionState } from "@/lib/agents/watchdog/transitions";
import type { TaskWorkflowCommand, TaskWorkflowIntent } from "@/lib/tasks/orchestrator/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ORCH-09/10: Map legacy workflow actions to orchestrator intents.
const ACTION_TO_INTENT: Partial<Record<WorkflowAction, TaskWorkflowIntent>> = {
  approve_plan: "approve_plan",
  start: "start_implementation",
  ready_for_review: "submit_for_review",
  submit_review: "submit_for_review",
  review_feedback: "request_review_changes",
  review_done: "accept_review",
};

// ORCH-09/10: V2 comparison probe. Called INSIDE each action handler, AFTER
// all safety gates have passed. This is a COMPUTE-ONLY probe — it never calls
// submitWorkflowCommand and never returns early. The legacy path remains
// authoritative for all mutations.
//
// The probe works in two phases:
//   1. computeV2Prediction: called BEFORE the legacy mutation, computes the
//      V2 decision (authorize + guard + decide) and returns a prediction
//      object. This is fire-and-forget — errors are logged, not thrown.
//   2. recordV2Comparison: called AFTER the legacy mutation completes,
//      persists the prediction alongside the actual legacy result (status,
//      workflowVersion) and an explicit matches/differences payload.
//
// Flag semantics:
//   PM_ORCHESTRATOR_V2_SHADOW=1: compute + record for ALL projects.
//   PM_ORCHESTRATOR_V2_PROJECTS=<slugs>: compute + record for allowlisted
//     projects only. This is NOT Phase E — no V2 transitions are executed.
//     It is a comparison probe that produces rollout evidence.
//   No flags: no probe, zero overhead.

type V2Prediction = {
  action: WorkflowAction;
  intent: TaskWorkflowIntent;
  authAllowed: boolean;
  authReason: string;
  guardOk: boolean;
  guardReason: string | null;
  v2DecisionStatus: string;
  v2DecisionToStatus: string | null;
  predictedFromStatus: string;
  predictedToStatus: string | null;
  legacyStatusBefore: string;
  workflowVersionBefore: number;
} | null;

async function computeV2Prediction(
  action: WorkflowAction,
  task: { id: string; projectId: string; status: string; workflowVersion: number; activeWorkflowCycleId: string | null; project: { slug: string } },
  agentUser: { id: string; username: string },
  agentRole: string,
  messageId: string,
  comment: string,
  validatedContext: {
    candidateSha?: string | null;
    worktreePath?: string | null;
    branchName?: string | null;
    actionPlanId?: string | null;
  },
): Promise<V2Prediction> {
  const intent = ACTION_TO_INTENT[action];
  if (!intent) return null;

  const { shouldComputeV2Decision } = await import("@/lib/tasks/orchestrator/flags");
  if (!shouldComputeV2Decision(task.project.slug)) return null;

  const command: TaskWorkflowCommand = {
    taskId: task.id,
    intent,
    actor: {
      id: agentUser.id,
      kind: "agent",
      username: agentUser.username,
      role: agentRole === "monitor" ? "monitor" : undefined,
    },
    expectedWorkflowVersion: task.workflowVersion,
    workflowCycleId: task.activeWorkflowCycleId ?? undefined,
    idempotencyKey: `${action}:${messageId}`,
    source: "agent-workflow-v2",
    messageId,
    evidence: {
      comment: comment || undefined,
      legacyAction: action,
      ...(validatedContext.actionPlanId ? { actionPlanId: validatedContext.actionPlanId } : {}),
    },
    payload: {
      candidateSha: validatedContext.candidateSha ?? undefined,
      comment: comment || undefined,
      worktreePath: validatedContext.worktreePath ?? undefined,
      branchName: validatedContext.branchName ?? undefined,
    },
  };

  try {
    const { loadTaskState, authorizeCommand, runGuards, decideCommand } = await import("@/lib/tasks/orchestrator");
    const state = await loadTaskState(task.id);
    if (!state) return null;
    const auth = authorizeCommand(state, command);
    const guardResult = runGuards(state, command);
    let v2DecisionStatus = "computed";
    let v2DecisionToStatus: string | null = null;
    let predictedFromStatus = state.status;
    let predictedToStatus: string | null = null;
    try {
      const decision = decideCommand(state, command, auth);
      if (!("status" in decision)) {
        v2DecisionToStatus = decision.toStatus;
        predictedToStatus = decision.toStatus;
      } else {
        v2DecisionStatus = `invalid: ${decision.reason}`;
      }
    } catch (error) {
      v2DecisionStatus = `error: ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      action,
      intent,
      authAllowed: auth.allowed,
      authReason: auth.reason,
      guardOk: guardResult.ok,
      guardReason: guardResult.ok ? null : guardResult.reason,
      v2DecisionStatus,
      v2DecisionToStatus,
      predictedFromStatus,
      predictedToStatus,
      legacyStatusBefore: task.status,
      workflowVersionBefore: task.workflowVersion,
    };
  } catch (error) {
    console.error("[pm] V2 comparison probe compute failed:", error);
    return null;
  }
}

async function recordV2Comparison(
  prediction: V2Prediction,
  task: { id: string; projectId: string; project: { slug: string } },
  agentUserId: string,
  legacyResult: { status: string; workflowVersion: number; ok: boolean; error?: string | null },
): Promise<void> {
  if (!prediction) return;
  const { orchestratorShadowEnabled, shouldRunV2Effects } = await import("@/lib/tasks/orchestrator/flags");
  const isShadow = orchestratorShadowEnabled();
  const isCanary = shouldRunV2Effects(task.project.slug);
  if (!isShadow && !isCanary) return;

  // Compare the V2 prediction against the actual legacy result.
  const actualToStatus = legacyResult.status;
  const predictedToStatus = prediction.predictedToStatus;
  const statusMatches = predictedToStatus === actualToStatus;
  const versionAdvanced = legacyResult.workflowVersion > prediction.workflowVersionBefore;
  const differences: string[] = [];
  if (!statusMatches && predictedToStatus) {
    differences.push(`V2 predicted ${predictedToStatus}, legacy produced ${actualToStatus}`);
  }
  if (!legacyResult.ok) {
    differences.push(`legacy failed: ${legacyResult.error ?? "unknown"}`);
  }
  if (!prediction.authAllowed) {
    differences.push(`V2 auth denied: ${prediction.authReason}`);
  }
  if (!prediction.guardOk) {
    differences.push(`V2 guard failed: ${prediction.guardReason}`);
  }

  const kind = isShadow ? "task.workflow.v2_shadow" : "task.workflow.v2_canary";
  await db.activityLog.create({
    data: {
      projectId: task.projectId,
      taskId: task.id,
      userId: agentUserId,
      kind,
      payload: JSON.stringify({
        action: prediction.action,
        intent: prediction.intent,
        v2AuthAllowed: prediction.authAllowed,
        v2AuthReason: prediction.authReason,
        v2GuardOk: prediction.guardOk,
        v2GuardReason: prediction.guardReason,
        v2DecisionStatus: prediction.v2DecisionStatus,
        v2PredictedToStatus: predictedToStatus,
        legacyStatusBefore: prediction.legacyStatusBefore,
        legacyStatusAfter: actualToStatus,
        legacyWorkflowVersionBefore: prediction.workflowVersionBefore,
        legacyWorkflowVersionAfter: legacyResult.workflowVersion,
        legacyOk: legacyResult.ok,
        legacyError: legacyResult.error ?? null,
        statusMatches,
        versionAdvanced,
        differences: differences.length > 0 ? differences : null,
      }),
    },
  }).catch((error) => console.error("[pm] V2 comparison record failed:", error));
}

const ACTIONS = [
  "start",
  "checkpoint",
  "publish_checkpoint",
  "ready_for_review",
  "submit_review",
  "review_feedback",
  "review_done",
  "triage_to_todo",
  "approve_plan",
  "submit_plan",
  "assign_task",
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

// ENV-122: Look up the active PmChannelRun for a workflow action to wire
// runId, provider, and model provenance into comment metadata.
async function resolveActiveRunId(messageId: string, agentSlug: string): Promise<{ id: string | null; provider: string | null; model: string | null }> {
  const run = await db.pmChannelRun.findFirst({
    where: { messageId, agentSlug, status: { in: ["queued", "accepted", "streaming", "completed"] } },
    select: { id: true, provider: true, model: true },
    orderBy: { createdAt: "desc" },
  });
  return { id: run?.id ?? null, provider: run?.provider ?? null, model: run?.model ?? null };
}

// ENV-118: takes a transaction client so a continuation-required action can
// commit the status move together with its continuation-outbox row. `client`
// defaults to the base db, which keeps the multi-statement write atomic on its
// own for the callers that do not participate in a larger transaction.
async function moveTaskStatus(args: {
  taskId: string;
  projectId: string;
  actorUserId: string;
  from: string;
  to: string;
  action: WorkflowAction;
  messageId: string;
  effects?: WorkflowEffect[];
  client?: Prisma.TransactionClient;
}) {
  const write = async (tx: Prisma.TransactionClient) => {
    if (!isTaskWorkflowStatus(args.from) || !isTaskWorkflowStatus(args.to)) {
      throw new Error(`Unsupported task workflow status edge: ${args.from} -> ${args.to}`);
    }
    await applyTaskTransition(tx, {
      taskId: args.taskId,
      projectId: args.projectId,
      actorUserId: args.actorUserId,
      intent: args.action === "triage_to_todo" ? "triage" : "start",
      from: args.from,
      to: args.to,
      source: "agent-workflow",
      idempotencyKey: `${args.action}:${args.messageId}`,
      effects: [
        { type: "board_touch", key: `board:${args.action}`, payload: {} },
        ...(args.effects ?? []),
      ],
    });
  };
  if (args.client) await write(args.client);
  else await db.$transaction((tx) => write(tx));
  // Cache/board fan-out is not rollback-able, so it deliberately stays outside
  // the transaction. Callers inside one call these after it commits.
  if (!args.client) {
    revalidateTaskShell(args.taskId);
    publishBoardTouch(args.projectId);
  }
}

// ENV-118. Every successful action answers with an explicit action result, so
// the agent learns whether its episode continues instead of inferring "done"
// from a bare `ok: true`. The handler below stays a plain per-action function;
// the exported POST decorates whatever it returned.
async function handleTaskWorkflowAction(
  req: NextRequest,
  ctx: { params: Promise<{ taskId: string }> },
  captured: { action?: WorkflowAction; taskId?: string; agentSlug?: string },
) {
  const { taskId } = await ctx.params;
  captured.taskId = taskId;
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
    blockerReport?: unknown;
    actionPlan?: unknown;
    completedWork?: unknown;
    evidence?: unknown;
    openChecklist?: unknown;
    nextAction?: unknown;
    risks?: unknown;
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
  captured.action = action;

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
  // Tool-budget exhaustion deliberately settles the transport run before it
  // aborts the oversized gateway turn. The episode barrier still owns the
  // message after that settlement and must be allowed to return its precise
  // checkpoint-only fence; otherwise this generic terminal-run guard masks it
  // with a bare 409 and the agent never learns that the episode rolled over.
  const rolloverBarrier = await resolveEpisodeRolloverBarrier({
    taskId,
    agentSlug: grantAgentSlug,
    messageId,
  });
  const matchingRun = await db.pmChannelRun.findFirst({
    where: { taskId, agentSlug: grantAgentSlug, messageId },
    orderBy: { createdAt: "desc" },
    select: { status: true, settledByAction: true, lastAction: true },
  });
  const exactIdempotentReplay = matchingRun &&
    matchingRun.status === "completed" &&
    (matchingRun.settledByAction === action || matchingRun.lastAction === action);
  if (
    matchingRun &&
    !["queued", "accepted", "streaming"].includes(matchingRun.status) &&
    !exactIdempotentReplay &&
    !rolloverBarrier
  ) {
    return NextResponse.json(
      { error: `Workflow grant belongs to a ${matchingRun.status} run and is fenced from further actions` },
      { status: 409 },
    );
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
        workflowVersion: true,
        projectId: true,
        epicId: true,
        assigneeId: true,
        actingManagerId: true,
        reporterId: true,
        approvedOn: true,
        approvedById: true,
        branchName: true,
        commitPrefix: true,
        workItemKey: true,
        activeWorkflowCycleId: true,
        deletedAt: true,
        blockedById: true,
        blockedBy: {
          select: {
            id: true,
            workItemKey: true,
            status: true,
            private: true,
            epic: { select: { private: true } },
            parent: { select: { private: true, epic: { select: { private: true } } } },
          },
        },
        dependencies: {
          select: {
            prerequisite: {
              select: {
                id: true,
                workItemKey: true,
                status: true,
                private: true,
                epic: { select: { private: true } },
                parent: { select: { private: true, epic: { select: { private: true } } } },
              },
            },
          },
        },
        repositoryRun: {
          select: {
            ...repositoryFinalizationFenceSelect,
            worktreePath: true,
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
        epic: { select: { id: true, status: true, actingManagerId: true, branchName: true, commitPrefix: true, workItemKey: true } },
      },
    }),
  ]);

  if (!agent?.user || agent.deactivatedAt || agent.user.status !== "active") {
    return NextResponse.json({ error: "Agent not active" }, { status: 403 });
  }
  // ENV-121: the response decorator needs the slug to report episode/cycle
  // state back to the caller.
  captured.agentSlug = agent.slug;
  if (!task || task.deletedAt) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }

  // Bound once so the narrowing above survives into the transaction callbacks
  // below: TypeScript discards property narrowing inside a function expression.
  const agentUser = agent.user;
  const actor = {
    id: agentUser.id,
    kind: "agent" as const,
    username: agentUser.username,
  };
  const reviewerId = resolveReviewOwnerId(task);
  const isReviewer = reviewerId === agent.user.id;
  const canSetDone = canSetTaskDoneForActor(task, agent.user.id);
  const isAssignee = task.assigneeId === agent.user.id;

  // ORCH-09/10: V2 comparison probe is handled INSIDE each action block, AFTER
  // all safety gates (episode rollover, plan validation, coding-role, WIP,
  // worktree preparation) have passed. The probe computes the V2 decision
  // (authorize + guard + decide) WITHOUT executing, and records a comparison
  // activity alongside the actual legacy result. See computeV2Prediction()
  // and recordV2Comparison().

  // ENV-121 (review) — THE ROLLOVER BARRIER.
  //
  // Opening episode N+1 when a budget ran out is only half a boundary. The
  // message that spent the budget was still live, and every action it kept
  // making was accepted and counted against the successor — so one stable
  // conversation could span arbitrarily many nominal episodes while the
  // "fresh session per episode" property quietly did not hold.
  //
  // The fence is server-side and sits ahead of every action branch: an
  // exhausted message may write exactly ONE final structured checkpoint, onto
  // the episode it exhausted, and is then done. PM dispatches the successor in
  // a fresh session briefed from that checkpoint.
  if (rolloverBarrier) {
    const barrierEpisode = {
      episodeNo: rolloverBarrier.episode.episodeNo,
      cycleCount: rolloverBarrier.episode.cycleCount,
      cycleBudget: rolloverBarrier.episode.cycleBudget,
      toolCycleCount: rolloverBarrier.episode.toolCycleCount,
      toolCycleBudget: rolloverBarrier.episode.toolCycleBudget,
      closeReason: rolloverBarrier.episode.closeReason,
    };
    if (action !== "checkpoint" || rolloverBarrier.state === "consumed") {
      return NextResponse.json({
        error: rolloverBarrier.state === "consumed"
          ? "This execution episode is closed and its final checkpoint is already recorded. Stop this turn now — PM has already dispatched the next episode in a fresh session. Nothing you send from this turn will be applied."
          : `This execution episode is closed (${rolloverBarrier.episode.closeReason}). The only action still accepted from this turn is action=checkpoint. Record completedWork, evidence, openChecklist, nextAction and risks, then stop — PM dispatches the next episode in a fresh session briefed from that checkpoint.`,
        episodeBudgetExhausted: true,
        episodeClosed: true,
        episode: barrierEpisode,
      }, { status: 409 });
    }

    // The one act still permitted. It is written onto the CLOSED episode, not
    // the successor: the successor belongs to a session that has not run yet,
    // and crediting this turn's state to it would be the same lie the barrier
    // exists to prevent.
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can checkpoint execution state" }, { status: 403 });
    }
    const finalCheckpoint = {
      completedWork: payload.completedWork,
      evidence: payload.evidence,
      openChecklist: payload.openChecklist,
      nextAction: payload.nextAction,
      risks: payload.risks,
    } as EpisodeCheckpoint;
    if (
      finalCheckpoint.completedWork === undefined &&
      finalCheckpoint.evidence === undefined &&
      finalCheckpoint.openChecklist === undefined &&
      finalCheckpoint.nextAction === undefined &&
      finalCheckpoint.risks === undefined
    ) {
      return NextResponse.json({
        error: "checkpoint requires at least one of completedWork, evidence, openChecklist, nextAction, risks.",
      }, { status: 400 });
    }
    // The seal is what SCHEDULES the successor episode: PM deliberately does
    // not arm a continuation at rollover time, because episode N+1 must never
    // be dispatched before N's checkpoint is durable. Consuming the barrier is
    // a conditional atomic update, so a concurrent duplicate checkpoint gets
    // null here and is rejected below rather than overwriting these words.
    const sealed = await sealEpisodeRolloverBarrier({
      taskId: task.id,
      agentSlug: agent.slug,
      messageId,
      checkpoint: finalCheckpoint,
      reason: EPISODE_SEAL_REASON.agentCheckpoint,
    });
    if (!sealed) {
      return NextResponse.json({
        error: "This execution episode's final checkpoint is already recorded. Stop this turn now — PM has already dispatched the next episode in a fresh session. Nothing you send from this turn will be applied.",
        episodeBudgetExhausted: true,
        episodeClosed: true,
        episode: barrierEpisode,
      }, { status: 409 });
    }
    const released = sealed.episode;
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      episodeNo: released.episodeNo,
      cycleCount: released.cycleCount,
      cycleBudget: released.cycleBudget,
      // Deliberately NOT `checkpoint`: the POST decorator spreads the workflow
      // action result over this body, and that result carries a `checkpoint`
      // LABEL string. Naming the structured checkpoint separately is what stops
      // the agent's own words from being replaced by "execution_checkpoint_saved".
      savedCheckpoint: released.checkpoint,
      successorScheduled: sealed.successorScheduled,
      // Read by the POST decorator: this response already carries the terminal
      // episode instruction, so it must not be re-decorated with the generic
      // "record a checkpoint and stop" one.
      episodeClosed: true,
      episodeBudgetExhausted: true,
      instruction:
        "Final checkpoint recorded and this episode is closed. Stop this turn now — PM dispatches the next episode in a fresh session briefed from it. No further action from this turn will be accepted.",
    });
  }

  if (action === "submit_plan") {
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can submit the Action Plan" }, { status: 403 });
    }
    if (task.status !== "Backlog" && task.status !== "To Do") {
      return NextResponse.json({
        error: "Action Plans can be submitted only before implementation starts",
        currentStatus: task.status,
      }, { status: 409 });
    }
    if (task.approvedOn) {
      return NextResponse.json({ error: "The Action Plan is already approved and immutable" }, { status: 409 });
    }
    if (exactIdempotentReplay) {
      const existingPlan = await db.actionPlan.findUnique({
        where: { taskId: task.id },
        select: { id: true },
      });
      return NextResponse.json({
        ok: true,
        taskId: task.id,
        actionPlanSubmitted: true,
        actionPlanId: existingPlan?.id ?? null,
        alreadySubmitted: true,
      });
    }
    const validated = validateActionPlanInput(payload.actionPlan);
    if ("errors" in validated) {
      return NextResponse.json({ error: "Invalid action plan", details: validated.errors }, { status: 400 });
    }

    const renderedPlan = [
      "## Action Plan",
      "",
      validated.summary,
      "",
      "### Implementation steps",
      ...validated.steps.flatMap((step, index) => [
        `${index + 1}. ${step.title}`,
        ...(step.acceptanceCriteria.length > 0
          ? step.acceptanceCriteria.map((criterion) => `   - Acceptance: ${criterion}`)
          : []),
      ]),
      ...(comment ? ["", "### Notes", comment] : []),
    ].join("\n");
    const workflowRun = await resolveActiveRunId(messageId, agent.slug);
    const { value: planMessage } = await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: task.status },
      async (tx) => {
        const plan = await persistActionPlan({
          taskId: task.id,
          input: validated,
          authorId: agentUser.id,
          sourceRunId: workflowRun.id,
          sourceMessageId: messageId,
          client: tx,
        });
        const message = await tx.agentChatMessage.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            epicId: null,
            agentSlug: "room",
            senderUserId: agentUser.id,
            body: renderedPlan,
            allowDescriptionEdit: false,
            originChannel: "chat",
          },
          select: { id: true },
        });
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: agentUser.id,
            kind: "task.action_plan.submit",
            targetAgent: agent.slug,
            payload: JSON.stringify({
              action,
              actionPlanId: plan.id,
              messageId: message.id,
              inReplyToMessageId: messageId,
              runId: workflowRun.id,
              provider: workflowRun.provider,
              model: workflowRun.model,
            }),
          },
        });
        return message;
      },
    );

    if (reviewerId && reviewerId !== agentUser.id) {
      await sendTaskWorkflowNotification({
        taskId: task.id,
        targetUserId: reviewerId,
        actor,
        reason: "action_plan_review_requested",
        body: [
          `@${agent.slug} submitted a structured Action Plan for "${task.title}".`,
          "Review the Action Plan. Approve it with action=approve_plan, or reply there with concise revision feedback.",
        ].join("\n"),
      });
    }
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      actionPlanSubmitted: true,
      actionPlanMessageId: planMessage.id,
      awaitingReviewer: Boolean(reviewerId && reviewerId !== agentUser.id),
    });
  }

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
    const unresolvedPrerequisites = unresolvedTaskPrerequisites(task);
    if (unresolvedPrerequisites.length > 0) {
      const visibleKeys = unresolvedPrerequisites.flatMap((prerequisite) => {
        const detail = prerequisite as typeof task.blockedBy;
        return detail && !detail.private && !detail.epic?.private && !detail.parent?.private && !detail.parent?.epic?.private
          ? [detail.workItemKey ?? "another task"]
          : [];
      });
      return NextResponse.json({
        error: visibleKeys.length > 0
          ? `Task is waiting for ${visibleKeys.join(", ")}; every prerequisite must reach Done first.`
          : "Task is waiting for another task; every prerequisite must reach Done first.",
        blockedBy: visibleKeys,
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

    // ORCH-09/10: V2 comparison probe — compute prediction BEFORE legacy.
    const v2StartPrediction = await computeV2Prediction(action, task, agentUser, agent.role, messageId, comment, {
      worktreePath: worktree.required ? worktree.worktreePath : null,
      branchName: worktree.required ? worktree.branchName : null,
    }).catch(() => null);

    // ENV-118 (review): the status move, the Epic promotion and the
    // continuation-outbox arm commit together. A crash anywhere in here leaves
    // the task in To Do, which the agent can simply retry — never In Progress
    // with nobody scheduled to work it.
    await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: "In Progress" },
      async (tx) => {
        await moveTaskStatus({
          taskId: task.id,
          projectId: task.projectId,
          actorUserId: agentUser.id,
          from: task.status,
          to: "In Progress",
          action,
          messageId,
          client: tx,
        });
        await promoteEpicOnTaskInProgress(tx, {
          epicId: task.epicId,
          projectId: task.projectId,
          actorId: agentUser.id,
          via: "agent-workflow",
        });
      },
    );
    revalidateTaskShell(task.id);
    publishBoardTouch(task.projectId);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    const taskAfterStart = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true } });
    await recordV2Comparison(v2StartPrediction, task, agentUser.id, { status: taskAfterStart.status, workflowVersion: taskAfterStart.workflowVersion, ok: true });
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      status: "In Progress",
      worktreePath: worktree.required ? worktree.worktreePath : null,
      branchName: worktree.required ? worktree.branchName : null,
    });
  }

  // ENV-121. The agent's own words, persisted before its episode budget runs
  // out. Every other continuation-required action folds a DERIVED checkpoint
  // into the episode ("checklist_updated (complete_subtask)"), which records
  // that something happened but not what the agent knows. This action is how
  // the next episode inherits intent — the next exact action and the live
  // risks — instead of re-deriving them from the board.
  //
  // It writes nothing to the task itself, so it deliberately does not spend a
  // cycle: an agent must never have to choose between checkpointing and
  // working.
  if (action === "checkpoint") {
    if (!isAssignee) {
      return NextResponse.json({ error: "Only the assignee can checkpoint execution state" }, { status: 403 });
    }
    if (task.status !== "In Progress") {
      return NextResponse.json({
        error: "Execution checkpoints only exist for active implementation. Move the task to In Progress with action=start first.",
        currentStatus: task.status,
      }, { status: 409 });
    }
    const checkpoint = {
      completedWork: payload.completedWork,
      evidence: payload.evidence,
      openChecklist: payload.openChecklist,
      nextAction: payload.nextAction,
      risks: payload.risks,
    } as EpisodeCheckpoint;
    if (
      checkpoint.completedWork === undefined &&
      checkpoint.evidence === undefined &&
      checkpoint.openChecklist === undefined &&
      checkpoint.nextAction === undefined &&
      checkpoint.risks === undefined
    ) {
      return NextResponse.json({
        error: "checkpoint requires at least one of completedWork, evidence, openChecklist, nextAction, risks.",
      }, { status: 400 });
    }
    // The recorder itself is the single writer (applyWorkflowActionEpisode),
    // so the checkpoint and the run bookkeeping share one transaction and the
    // mutation callback has nothing of its own to do.
    const outcome = await runWorkflowActionAtomically(
      {
        taskId: task.id,
        agentSlug: agent.slug,
        messageId,
        action,
        taskState: task.status,
        checkpoint,
        countsAgainstEpisodeBudget: false,
      },
      async () => null,
    );
    const saved = await latestTaskExecutionCheckpoint({ taskId: task.id, agentSlug: agent.slug });
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      episodeNo: outcome.result.episode?.episodeNo ?? saved?.episodeNo ?? null,
      cycleCount: outcome.result.episode?.cycleCount ?? saved?.cycleCount ?? null,
      cycleBudget: outcome.result.episode?.cycleBudget ?? saved?.cycleBudget ?? null,
      checkpoint: saved?.checkpoint ?? null,
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
    const structuredPlan = await db.actionPlan.findUnique({
      where: { taskId: task.id },
      select: { id: true, version: true, status: true, approvedOn: true, steps: { select: { id: true }, take: 1 } },
    });
    if (!structuredPlan || structuredPlan.steps.length === 0) {
      return NextResponse.json({
        error: "A validated structured Action Plan must be submitted before approval",
      }, { status: 409 });
    }
    if (structuredPlan.status !== "draft" && !task.approvedOn) {
      return NextResponse.json({
        error: structuredPlan.status === "revision_required"
          ? "The previous Action Plan is historical. The assignee must submit a revised structured Action Plan before approval."
          : "Only the latest submitted Action Plan revision can be approved.",
        actionPlanStatus: structuredPlan.status,
      }, { status: 409 });
    }
    if (task.approvedOn) {
      if (!structuredPlan.approvedOn) {
        const approvedById = task.approvedById ?? agent.user.id;
        await db.$transaction([
          db.actionPlan.update({
            where: { id: structuredPlan.id },
            data: { status: "approved", approvedOn: task.approvedOn, approvedById },
          }),
          db.actionPlanRevision.updateMany({
            where: { actionPlanId: structuredPlan.id, version: structuredPlan.version, status: "draft" },
            data: { status: "approved", approvedOn: task.approvedOn, approvedById },
          }),
        ]);
      }
      return NextResponse.json({ ok: true, taskId: task.id, approved: true, alreadyApproved: true });
    }
    // Approval reserves the repository contract only. The writable worktree
    // is created at the In Progress boundary immediately before dispatch.
    const reservation = await reserveTaskRepositoryState(task.id);
    const approvedAt = new Date();
    const moveToTodo = task.status === "Backlog";
    const approvalEffects: WorkflowEffect[] = [
      { type: "board_touch", key: "board-plan-approved", payload: {} },
    ];
    if (task.assigneeId) {
      approvalEffects.push({
        type: "task_notification",
        key: `plan-approved:${task.assigneeId}`,
        payload: {
          taskId: task.id,
          targetUserId: task.assigneeId,
          actor,
          reason: "todo_start_required",
          body: [
            `The Action Plan for "${task.title}" was approved by @${agent.user.username}.`,
            "PM will start it automatically if the assignee lane and repository gates are free. Check the current task status: if it is In Progress, implement now; if it remains To Do, use action=start when the lane is free.",
            "Do not post a visible acknowledgement unless a blocker or material plan change appears.",
          ].join("\n"),
        },
      });
    }
    // ORCH-09/10: V2 comparison probe — compute prediction BEFORE legacy,
    // record comparison AFTER. Fire-and-forget, no early return.
    const v2Prediction = await computeV2Prediction(action, task, agentUser, agent.role, messageId, comment, {
      actionPlanId: structuredPlan.id,
    }).catch(() => null);
    await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: moveToTodo ? "To Do" : task.status },
      async (tx) => {
        if (moveToTodo) {
          await applyTaskTransition(tx, {
            taskId: task.id,
            projectId: task.projectId,
            actorUserId: agent.user!.id,
            intent: "approve_plan",
            from: "Backlog",
            to: "To Do",
            source: "action-plan-approval",
            idempotencyKey: `approve-plan:${messageId}`,
            taskData: { approvedOn: approvedAt, approvedById: agent.user!.id },
            evidence: { actionPlanId: structuredPlan.id },
            effects: approvalEffects,
          });
        } else {
          await tx.task.update({
            where: { id: task.id },
            data: { approvedOn: approvedAt, approvedById: agent.user!.id },
          });
          await enqueueWorkflowEffects(tx, {
            taskId: task.id,
            projectId: task.projectId,
            aggregateVersion: task.workflowVersion,
            effects: approvalEffects,
          });
        }
        await tx.actionPlan.update({
        where: { id: structuredPlan.id },
        data: { status: "approved", approvedOn: approvedAt, approvedById: agentUser.id },
        });
        await tx.actionPlanRevision.updateMany({
        where: { actionPlanId: structuredPlan.id, version: structuredPlan.version, status: "draft" },
        data: { status: "approved", approvedOn: approvedAt, approvedById: agentUser.id },
        });
        await tx.activityLog.create({
        data: {
          projectId: task.projectId,
          taskId: task.id,
          userId: agentUser.id,
          kind: "task.action_plan.approve",
          targetAgent: agent.slug,
          payload: JSON.stringify({
            taskId: task.id,
            previousStatus: task.status,
            status: moveToTodo ? "To Do" : task.status,
            via: "agent-workflow",
          }),
        },
        });
        if (comment) {
          await tx.agentChatMessage.create({
              data: {
                projectId: task.projectId,
                taskId: task.id,
                epicId: null,
                agentSlug: "room",
                senderUserId: agentUser.id,
                body: comment,
                allowDescriptionEdit: false,
                originChannel: "chat",
              },
          });
          await tx.activityLog.create({
              data: {
                projectId: task.projectId,
                taskId: task.id,
                userId: agentUser.id,
                kind: "task.chat.reply",
                targetAgent: agent.slug,
                payload: JSON.stringify({
                  agentSlug: agent.slug,
                  workflowAction: "approve_plan",
                  source: "approval_comment",
                }),
              },
          });
        }
        await createChecklistAndDelegatableTasksFromPlan({
          taskId: task.id,
          approvedAt,
          approvedById: agent.user!.id,
          client: tx,
        });
      },
    );
    let startedAfterApproval = false;
    if (task.assigneeId) {
      const autoStart = await startApprovedTodoTaskIfIdle({
        taskId: task.id,
        actor,
        via: "agent-action-plan-approval",
      });
      startedAfterApproval = autoStart.started;
    } else {
      // No assignee: assign in the same request instead of asking the
      // reviewer to call back with assign_task — that
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
            "PM will assign it automatically when a worker frees up. You may also call the workflow endpoint with action=assign_task to assign it explicitly.",
            "Do not start implementation yourself.",
          ].join("\n"),
        });
      }
    }
    await drainWorkflowOutbox({ limit: approvalEffects.length }).catch(() => {});
    if (comment) revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    const approveStatus = startedAfterApproval ? "In Progress" : moveToTodo ? "To Do" : task.status;
    // Record V2 comparison AFTER legacy completes.
    const taskAfterApprove = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true } });
    await recordV2Comparison(v2Prediction, task, agentUser.id, { status: taskAfterApprove.status, workflowVersion: taskAfterApprove.workflowVersion, ok: true });
    return NextResponse.json({
      ok: true,
      taskId: task.id,
      approved: true,
      status: approveStatus,
      repositoryPhase: startedAfterApproval ? "active" : reservation?.phase ?? null,
      worktreePath: null,
      branchName: reservation?.branchName ?? null,
    });
  }

  if (action === "assign_task" || action === "assign_after_plan_approval") {
    // Accept the RESOLVED reviewer (task acting manager -> In Progress epic
    // acting manager -> reporter), not just the raw task.actingManagerId —
    // PM nominates epic-fallback reviewers for this exact action, and the
    // old strict check guaranteed them a 403.
    if (!isReviewer) {
      return NextResponse.json({ error: "Only the resolved task reviewer can assign this task" }, { status: 403 });
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

    // ENV-118 (review): the enqueue itself is a filesystem job spool, which no
    // database transaction can cover. Its DURABLE database half — the
    // authorization-consuming `pm.repo.checkpoint.enqueue` row — does share the
    // transaction with the continuation arm, so the record that spends the
    // owner's single-use grant and the turn that follows it commit together.
    await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: task.status },
      async (tx) => {
        if (!checkpoint.enqueued) return;
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: agentUser.id,
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
      },
    );
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

    let reviewCommentId: string | null = null;
    if (comment) {
      const run = await resolveActiveRunId(messageId, agent.slug);
      const created = await db.$transaction(async (tx) => {
        const row = await tx.comment.create({
          data: { taskId: task.id, userId: agent.user!.id, body: comment, authorAgentSlug: agent.slug, commentKind: "agent_reply", isGenerated: false, runId: run.id, provider: run.provider, model: run.model },
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

    // ORCH-09/10: V2 comparison probe — compute prediction BEFORE legacy handoff.
    const v2ReviewPrediction = await computeV2Prediction(action, task, agentUser, agent.role, messageId, comment, {
      candidateSha: task.repositoryRun?.candidateSha ?? null,
    }).catch(() => null);

    // Code work remains In Progress while the role-resolved Monitor Agent
    // validates it. The handoff itself moves only validated work to Review.
    const handoff = await runTaskReviewHandoff({
      taskId: task.id,
      actor,
      via: "ready-for-review",
      movedFromStatus: task.status,
      assigneeNote: comment || null,
      workflowAction: {
        taskId: task.id,
        agentSlug: agent.slug,
        messageId,
        action,
      },
    });
    if (handoff.error) {
      return NextResponse.json({
        error: handoff.error,
        taskId: task.id,
        status: handoff.status,
        repositoryPhase: handoff.repositoryPhase,
      }, { status: handoff.repositoryPhase === "operational_error" ? 503 : 409 });
    }
    for (const assigned of handoff.refillAssignments) {
      revalidatePath(`/projects/${task.project.slug}/tasks/${assigned.taskId}`);
    }
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    const taskAfterReview = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true } });
    await recordV2Comparison(v2ReviewPrediction, task, agentUser.id, { status: taskAfterReview.status, workflowVersion: taskAfterReview.workflowVersion, ok: handoff.repositoryPhase !== "operational_error", error: handoff.error });
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
    if (repositoryFinalizationOwnsTask(task.repositoryRun)) {
      return NextResponse.json({
        error: REPOSITORY_FINALIZATION_FENCE_MESSAGE,
      }, { status: 409 });
    }
    if (!comment || comment.length > 8000) {
      return NextResponse.json({ error: "comment is required and must be <= 8000 chars" }, { status: 400 });
    }

    const run = await resolveActiveRunId(messageId, agent.slug);
    const effects: WorkflowEffect[] = [
      { type: "board_touch", key: "board-review-feedback", payload: {} },
    ];
    if (task.assigneeId) {
      effects.push({
        type: "task_notification",
        key: `review-feedback:${task.assigneeId}`,
        payload: {
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
        },
      });
    }
    // ORCH-09/10: V2 comparison probe — compute prediction BEFORE legacy.
    const v2FeedbackPrediction = await computeV2Prediction(action, task, agentUser, agent.role, messageId, comment, {}).catch(() => null);
    const created = (await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: "To Do" },
      async (tx) => {
        const row = await tx.comment.create({
          data: { taskId: task.id, userId: agent.user!.id, body: comment, authorAgentSlug: agent.slug, commentKind: "agent_reply", isGenerated: false, runId: run.id, provider: run.provider, model: run.model },
          select: { id: true },
        });
        await applyTaskTransition(tx, {
          taskId: task.id,
          projectId: task.projectId,
          actorUserId: agent.user!.id,
          intent: "request_changes",
          from: "Review",
          to: "To Do",
          source: "agent-workflow",
          idempotencyKey: `review-feedback:${messageId}`,
          rank: "front",
          evidence: { commentId: row.id },
          effects,
        });
      await tx.reviewRun.updateMany({
        where: { taskId: task.id, status: "awaiting_review" },
        data: {
          status: "changes_requested",
          reviewerId: agentUser.id,
          reviewedAt: new Date(),
          invalidatedAt: new Date(),
          invalidatedReason: comment.slice(0, 1000),
        },
      });
      await tx.taskRepositoryRun.updateMany({
        where: { taskId: task.id },
        data: {
          phase: "action_required",
          reviewedSha: null,
          validationOutcome: null,
          lastError: comment.slice(0, 2000),
          version: { increment: 1 },
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
      return row;
      },
    )).value;
    await sendTaskCommentNotifications({
      taskId: task.id,
      commentId: created.id,
      body: comment,
      actor,
      excludeAgentSlugs: [agent.slug],
    });
    await drainWorkflowOutbox({ limit: effects.length }).catch(() => {});
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
    const taskAfterFeedback = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true } });
    await recordV2Comparison(v2FeedbackPrediction, task, agentUser.id, { status: taskAfterFeedback.status, workflowVersion: taskAfterFeedback.workflowVersion, ok: true });
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

    // ORCH-09/10: V2 comparison probe — compute prediction BEFORE legacy.
    const v2DonePrediction = await computeV2Prediction(action, task, agentUser, agent.role, messageId, comment, {
      candidateSha: task.repositoryRun?.candidateSha ?? null,
    }).catch(() => null);

    const completion = await completeReviewedTaskAndAssignNext({
      taskId: task.id,
      actor,
      via: "agent-workflow",
      requireReviewerUserId: agent.user.id,
      workflowAction: {
        taskId: task.id,
        agentSlug: agent.slug,
        messageId,
        action,
      },
    });
    if (!completion.completed) {
      const taskAfterDoneFail = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true } });
      await recordV2Comparison(v2DonePrediction, task, agentUser.id, { status: taskAfterDoneFail.status, workflowVersion: taskAfterDoneFail.workflowVersion, ok: false, error: completion.reason });
      return NextResponse.json({ error: `Could not complete task: ${completion.reason}` }, { status: 409 });
    }
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    for (const next of completion.nextTasks ?? []) {
      revalidateTaskShell(next.id);
      revalidatePath(`/projects/${task.project.slug}/tasks/${next.id}`);
    }
    revalidatePath(`/projects/${task.project.slug}`);
    const taskAfterDone = await db.task.findUniqueOrThrow({ where: { id: task.id }, select: { status: true, workflowVersion: true } });
    await recordV2Comparison(v2DonePrediction, task, agentUser.id, { status: taskAfterDone.status, workflowVersion: taskAfterDone.workflowVersion, ok: true });
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

    const effects: WorkflowEffect[] = [];
    if (task.assigneeId) {
      effects.push({
        type: "task_notification",
        key: `todo-start-required:${task.assigneeId}`,
        payload: {
          taskId: task.id,
          targetUserId: task.assigneeId,
          actor,
          reason: "todo_start_required",
          body: [
            `Task "${task.title}" is now in To Do and assigned to you.`,
            task.approvedOn
              ? "The Action Plan is approved. Move it to In Progress through the workflow endpoint and start work immediately."
              : "Before starting work, call action=submit_plan with one structured technical Action Plan and wait for reviewer/reporter approval. A plain chat reply is discussion only.",
          ].join("\n"),
        },
      });
    }
    await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: "To Do" },
      async (tx) => {
        await moveTaskStatus({
          taskId: task.id,
          projectId: task.projectId,
          actorUserId: agent.user!.id,
          from: task.status,
          to: "To Do",
          action,
          messageId,
          effects,
          client: tx,
        });
      },
    );
    await drainWorkflowOutbox({ limit: effects.length + 1 }).catch(() => {});
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
    } else if (!task.approvedOn) {
      return NextResponse.json({
        error: "Submit the structured Action Plan with action=submit_plan and wait for approval before adding implementation sub-tasks",
      }, { status: 409 });
    } else if (task.status !== "To Do" && task.status !== "In Progress") {
      return NextResponse.json({
        error: "Implementation sub-tasks can be added only to an approved To Do or In Progress task",
        currentStatus: task.status,
      }, { status: 409 });
    }
    const text = typeof payload.subtaskText === "string" ? payload.subtaskText.trim() : "";
    if (!text) return NextResponse.json({ error: "subtaskText is required" }, { status: 400 });
    const existingChecklistItem = await db.subTask.findFirst({
      where: { taskId: task.id, kind, text },
      select: { id: true },
    });
    if (existingChecklistItem) {
      return NextResponse.json({
        ok: true,
        taskId: task.id,
        subtaskId: existingChecklistItem.id,
        subtaskKind: kind,
        alreadyExists: true,
      });
    }
    // The checklist row and the continuation arm commit together (ENV-118
    // review): a crash must not leave a recorded sub-task whose turn nothing
    // will resume.
    let created: { id: string } | null = null;
    try {
      created = (await runWorkflowActionAtomically(
        { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: task.status },
        (tx) => createSubTaskItem({ taskId: task.id, text, actorUserId: agentUser.id, kind, client: tx }),
      )).value;
    } catch (err) {
      if ((err as { code?: unknown })?.code === "P2002") {
        const raced = await db.subTask.findFirst({
          where: { taskId: task.id, kind, text },
          select: { id: true },
        });
        if (raced) {
          return NextResponse.json({
            ok: true,
            taskId: task.id,
            subtaskId: raced.id,
            subtaskKind: kind,
            alreadyExists: true,
          });
        }
      }
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
    } else if (!task.approvedOn || (task.status !== "To Do" && task.status !== "In Progress")) {
      return NextResponse.json({
        error: "Implementation sub-tasks can be updated only after Action Plan approval while the task is To Do or In Progress",
        currentStatus: task.status,
      }, { status: 409 });
    }
    // Default to marking complete; pass completed:false to reopen.
    const completed = payload.completed === undefined ? true : payload.completed === true;
    // Optional self-reported effort for this step.
    const minutesSpent = typeof payload.minutesSpent === "number" ? payload.minutesSpent : undefined;
    // ENV-118 (review): the tick and the continuation arm commit together, and
    // the "is this the last open item" count is read inside the same
    // transaction so it cannot observe a half-applied state.
    // The sub-task was found above, so this only fires on a concurrent delete.
    // Throwing rolls the whole transaction back rather than arming a
    // continuation for an action that did nothing.
    const SUBTASK_VANISHED = "env118:subtask-vanished";
    let ticked: { updated: NonNullable<Awaited<ReturnType<typeof setSubTaskCompletion>>>; remainingOpen: number };
    try {
      ticked = (await runWorkflowActionAtomically(
        { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: task.status },
        async (tx) => {
          const updated = await setSubTaskCompletion({
            subTaskId: subtaskId,
            completed,
            minutesSpent,
            actorUserId: agentUser.id,
            expectTaskId: task.id,
            client: tx,
          });
          if (!updated) throw new Error(SUBTASK_VANISHED);
          const remainingOpen = await tx.subTask.count({
            where: { taskId: task.id, completedAt: null, kind: { not: "review" } },
          });
          return { updated, remainingOpen };
        },
      )).value;
    } catch (err) {
      if (err instanceof Error && err.message === SUBTASK_VANISHED) {
        return NextResponse.json({ error: "Sub-task not found on this task" }, { status: 404 });
      }
      throw err;
    }
    const result = ticked.updated;
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);

    // When the LAST implementation item completes, this SAME turn receives the
    // terminal instruction. complete_subtask already arms the continuation
    // outbox atomically; do not dispatch a competing process while this model
    // still owns the lane. If it ends before ready_for_review, the outbox owns
    // the one successor turn.
    let allImplementationSubtasksComplete = false;
    if (
      result.completedAt !== null &&
      subtaskRow.kind !== "review" &&
      isAssignee &&
      task.status === "In Progress"
    ) {
      if (ticked.remainingOpen === 0) {
        allImplementationSubtasksComplete = true;
      }
    }
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
    } else if (!task.approvedOn || (task.status !== "To Do" && task.status !== "In Progress")) {
      return NextResponse.json({
        error: "Implementation sub-tasks can be removed only after Action Plan approval while the task is To Do or In Progress",
        currentStatus: task.status,
      }, { status: 409 });
    }
    const { value: removed } = await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: task.status },
      (tx) => deleteSubTaskItem({
        subTaskId: subtaskId,
        actorUserId: agentUser.id,
        expectTaskId: task.id,
        client: tx,
      }),
    );
    if (!removed) return NextResponse.json({ error: "Sub-task not found on this task" }, { status: 404 });
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
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
  // ENV-122: Resolve the active PmChannelRun for this workflow turn to wire
  // runId, provider, and model provenance into comment metadata.
  const workflowRun = await resolveActiveRunId(messageId, agent.slug);
  async function postWorkflowComment(
    body: string,
    kind: string,
    payloadExtra?: Record<string, unknown>,
  ) {
    const created = await db.comment.create({
      data: { taskId: requestTaskId, userId: requesterUserId, body, authorAgentSlug: requesterSlug, commentKind: "workflow_action", isGenerated: false, runId: workflowRun.id, provider: workflowRun.provider, model: workflowRun.model },
      select: { id: true },
    });
    await db.activityLog.create({
      data: {
        projectId: requestProjectId,
        taskId: requestTaskId,
        userId: requesterUserId,
        kind,
        targetAgent: requesterSlug,
        payload: JSON.stringify({ commentId: created.id, action, ...payloadExtra }),
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
      // A freshly provisioned deployment-validation task can already be based
      // on the Epic SHA that the previous child finalizer pushed. In that
      // state there is no task checkpoint to publish: accepting a permission
      // blocker would pause the task for an operation PM already completed.
      // Fail closed only when all three facts are proven at request time: the
      // registered task worktree is clean, it is still on its exact repository
      // baseline, and origin's Epic ref is that same SHA. Dirty/new work keeps
      // the normal owner-authorized checkpoint path.
      const repositoryBaseline = task.repositoryRun.baseSha?.trim() ?? "";
      if (repositoryBaseline) {
        const baselineWorktree = await inspectValidatedCandidateWorktree({
          worktreePath: task.repositoryRun.worktreePath,
          taskBranch,
          candidateSha: repositoryBaseline,
        });
        if (baselineWorktree.ok) {
          const publishedEpic = await inspectOriginBranch(task.project.repositoryPath, epicBranch);
          if (publishedEpic.ok && publishedEpic.sha === repositoryBaseline) {
            return NextResponse.json({
              error: `Nothing is waiting to be published: the clean ${taskBranch} worktree and origin/${epicBranch} already point to repository baseline ${repositoryBaseline}. Do not merge, commit, push, or request publish_checkpoint. Verify the configured deployment automation for this already-published SHA; if deployment failed or the target reports another SHA, flag a general external deployment blocker with that observed evidence.`,
              alreadyPublished: true,
              publishedSha: repositoryBaseline,
              taskBranch,
              epicBranch,
            }, { status: 409 });
          }
        }
      }
      permissionRequest = {
        kind: requestedPermissionKind,
        scope: permissionScope || `Publish the current ${task.workItemKey ?? taskBranch} checkpoint to ${epicBranch} for deployment-dependent verification.`,
        taskKey: task.workItemKey,
        taskBranch,
        epicBranch,
      };
    }
    // ENV-120. A formal blocker moves the task into a human-blocked state, so
    // the claim is validated as structured data before that happens. A
    // permission round is the one case PM can complete itself: the dependency
    // IS the reporter's grant, so the report is synthesized from the validated
    // permission request rather than demanded from the caller again.
    let blockerReport: FormalBlockerReport;
    if (permissionRequest) {
      const supplied = formalBlockerReportFromValue(payload.blockerReport);
      blockerReport = {
        blockedOn: "permission",
        requestedActor: supplied?.requestedActor ?? "the task reporter",
        requestedAction: permissionRequest.scope,
        evidence: supplied?.evidence ?? comment,
        diagnosticsAttempted: supplied?.diagnosticsAttempted?.length
          ? supplied.diagnosticsAttempted
          : ["No agent-side retry can grant this permission; the scope is owner-authorized by design."],
        resumeCondition: supplied?.resumeCondition
          ?? `The task reporter grants "${permissionRequest.scope}" on this blocker comment.`,
        reporterCanResolve: true,
        permission: permissionRequest,
      };
    } else {
      // Escalation is earned with DISTINCT diagnostic evidence, never with
      // elapsed time or a bare retry counter: count the earlier incident
      // rounds for this same failure whose diagnosis differs from this one.
      const candidate = formalBlockerReportFromValue(payload.blockerReport);
      let priorDistinctDiagnostics = 0;
      if (candidate) {
        const signature = blockerFailureSignature(candidate);
        const fingerprint = blockerDiagnosticsFingerprint(candidate);
        const incidents = await db.activityLog.findMany({
          where: { taskId: task.id, kind: "task.blocker.incident", targetAgent: agent.slug },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: { payload: true },
        });
        const distinct = new Set<string>();
        for (const row of incidents) {
          if (!row.payload) continue;
          try {
            const parsed = JSON.parse(row.payload) as {
              signature?: unknown;
              diagnosticsFingerprint?: unknown;
              report?: unknown;
            };
            // Recompute from the structured report when available. This keeps
            // historical incident rows usable after signature rules improve;
            // legacy rows without a report retain their stored identity.
            const priorReport = formalBlockerReportFromValue(parsed.report);
            const priorSignature = priorReport
              ? blockerFailureSignature(priorReport)
              : parsed.signature;
            if (priorSignature !== signature) continue;
            if (typeof parsed.diagnosticsFingerprint !== "string") continue;
            if (parsed.diagnosticsFingerprint === fingerprint) continue;
            distinct.add(parsed.diagnosticsFingerprint);
          } catch {
            // A malformed incident row cannot earn an escalation.
          }
        }
        priorDistinctDiagnostics = distinct.size;
      }

      const classification = classifyBlockerFailure(payload.blockerReport, {
        assigneeIdentifiers: [agent.slug, agentUser.username, agentUser.id],
        priorDistinctDiagnostics,
      });
      if (classification.outcome === "reject") {
        // No run action is recorded: a refused blocker is not a turn outcome.
        // The episode continues and the agent fixes the report or the work.
        return NextResponse.json({
          error: classification.message,
          rejectedRule: classification.rule,
          requiredFields: {
            blockedOn: "person | permission | external_service | decision | dependency",
            requestedActor: "who must act (never you)",
            requestedAction: "the exact action they must perform",
            evidence: "the observed failure: exact error text, endpoint or identifier",
            diagnosticsAttempted: ["what you already tried"],
            resumeCondition: "the observable condition that lets work resume",
            reporterCanResolve: "true | false",
          },
        }, { status: 422 });
      }
      if (classification.outcome === "incident") {
        // Recoverable technical failure: audited, but the task stays In
        // Progress and no decision owner is woken.
        await db.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: agentUser.id,
            kind: "task.blocker.incident",
            targetAgent: agent.slug,
            payload: JSON.stringify({
              action,
              rule: classification.rule,
              signature: candidate ? blockerFailureSignature(candidate) : null,
              diagnosticsFingerprint: candidate ? blockerDiagnosticsFingerprint(candidate) : null,
              priorDistinctDiagnostics,
              report: candidate,
            }),
          },
        });
        return NextResponse.json({
          error: classification.message,
          incident: true,
          rejectedRule: classification.rule,
          guidance: classification.guidance,
          priorDistinctDiagnostics,
        }, { status: 422 });
      }
      blockerReport = classification.report;
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
          authorAgentSlug: requesterSlug,
          commentKind: "blocker_notice",
          isGenerated: false,
          runId: workflowRun.id,
          provider: workflowRun.provider,
          model: workflowRun.model,
          body: [
            `**Blocker raised** by @${requesterUsername} (assignee):`,
            "",
            comment,
            ...(permissionRequest ? [
              "",
              `**Reporter permission requested:** ${permissionRequest.scope}`,
            ] : []),
            "",
            `**Blocked on:** ${blockerReport.blockedOn} — ${blockerReport.requestedActor}`,
            `**Requested action:** ${blockerReport.requestedAction}`,
            `**Evidence:** ${blockerReport.evidence}`,
            `**Diagnostics attempted:** ${blockerReport.diagnosticsAttempted.map((entry) => `\n- ${entry}`).join("")}`,
            `**Resume condition:** ${blockerReport.resumeCondition}`,
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
          payload: JSON.stringify({ action, commentId: row.id, permissionRequest, blockerReport }),
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
          `Blocked on ${blockerReport.blockedOn} (${blockerReport.requestedActor}) — required action: ${blockerReport.requestedAction}`,
          `Work resumes when: ${blockerReport.resumeCondition}`,
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
      // Nothing to clear: this branch writes no durable row, so there is no
      // mutation to bind the continuation arm to.
      await recordPmChannelRunWorkflowAction({
        taskId: task.id,
        agentSlug: agent.slug,
        messageId,
        action,
        withoutDomainMutation: true,
      });
      return NextResponse.json({ ok: true, taskId: task.id, cleared: "blocker", alreadyCleared: true });
    }

    const hasNewerIndependentAlert = await hasNewerIndependentTaskAlert(
      task.id,
      latestBlocker.createdAt,
    );
    const preserveIndependentAlert =
      task.repositoryRun?.phase === "operational_error" || hasNewerIndependentAlert;
    // ENV-118 (review): unblocking evidence, the cleared-blocker audit row, the
    // alert flag and the continuation arm are one transaction. Clearing a
    // blocker without scheduling the resumed turn is the same loss window as
    // `start`.
    const { value: created } = await runWorkflowActionAtomically(
      { taskId: task.id, agentSlug: agent.slug, messageId, action, taskState: task.status },
      async (tx) => {
        const row = await tx.comment.create({
          data: {
            taskId: task.id,
            userId: agentUser.id,
            authorAgentSlug: agent.slug,
            commentKind: "workflow_action",
            isGenerated: false,
            runId: workflowRun.id,
            provider: workflowRun.provider,
            model: workflowRun.model,
            body: [
              `**Blocker cleared** by @${agentUser.username} (assignee):`,
              "",
              comment,
              "",
              preserveIndependentAlert
                ? "Active implementation may resume, but a separate operational alert remains active."
                : "Active implementation has resumed.",
            ].join("\n"),
          },
          select: { id: true },
        });
        await tx.activityLog.create({
          data: {
            projectId: task.projectId,
            taskId: task.id,
            userId: agentUser.id,
            kind: "task.blocker.cleared",
            targetAgent: agent.slug,
            payload: JSON.stringify({ action, preserveIndependentAlert }),
          },
        });
        await tx.task.update({
          where: { id: task.id },
          data: { alertReporter: preserveIndependentAlert },
        });
        return row;
      },
    );
    revalidateTaskReplyScope(task.id, "comment");
    revalidateTaskReplyScope(task.id, "chat");
    revalidateTaskShell(task.id);
    revalidatePath(`/projects/${task.project.slug}/tasks/${task.id}`);
    revalidatePath(`/projects/${task.project.slug}`);
    publishBoardTouch(task.projectId);
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
      {
        // An extra-work blocker has a fixed shape: it is always a scope
        // DECISION owed by the reviewer/reporter, never a technical failure,
        // so PM can state the structured claim itself (WFI-007).
        blockerReport: {
          blockedOn: "decision",
          requestedActor: "the task reviewer or reporter",
          requestedAction: "Decide whether the requested extra scope is in or out of this task.",
          evidence: reason,
          diagnosticsAttempted: ["Assessed the requested extra work against the approved plan scope."],
          resumeCondition: "The reviewer or reporter records an in-scope / out-of-scope decision on this task.",
          reporterCanResolve: true,
        } satisfies FormalBlockerReport,
      },
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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ taskId: string }> },
) {
  const captured: { action?: WorkflowAction; taskId?: string; agentSlug?: string } = {};
  const response = await handleTaskWorkflowAction(req, ctx, captured);
  if (!response.ok || !captured.action) return response;

  let body: Record<string, unknown>;
  try {
    body = (await response.clone().json()) as Record<string, unknown>;
  } catch {
    return response;
  }
  if (body.ok !== true) return response;

  // taskState is read AFTER the action so the agent sees where the task
  // actually landed, not where the handler assumed it would.
  const current = captured.taskId
    ? await db.task.findUnique({
        where: { id: captured.taskId },
        select: { status: true, projectId: true },
      })
    : null;
  const result = workflowActionResult({
    action: captured.action,
    taskState: current?.status ?? null,
  });
  // ENV-123. Keep the operator-visible execution strip current on ordinary
  // transitions, not just on watchdog passes. Read after the action for the
  // same reason taskState is: this must report where the task actually landed.
  // Awaited but fail-soft — the action has already committed and a strip write
  // may never turn a successful transition into an error.
  if (captured.taskId) {
    await recordWorkflowActionExecutionState({
      taskId: captured.taskId,
      projectId: current?.projectId ?? null,
      action: captured.action,
      status: current?.status ?? null,
      blockedExternally: body.flagged === "blocker",
    });
  }
  // ENV-121. Cycle accounting is only useful if the agent can SEE it: an
  // episode that rolls over silently is indistinguishable from one that did
  // not, and the agent has no reason to checkpoint before its budget runs out.
  //
  // Read after the action, like taskState above, so this reports where the
  // episode actually landed. A rollover leaves the successor at cycleCount 0
  // with its predecessor closed as budget-exhausted, which is exactly the
  // signal the brief's EPISODE RULES tell the agent to watch for.
  //
  // A barrier-release response (the fenced turn's final checkpoint) already
  // carries its own terminal episode state and instruction. Re-deriving it
  // from history here would report the untouched successor and tell an agent
  // that just checkpointed to checkpoint again.
  if (captured.taskId && captured.agentSlug && body.episodeClosed !== true) {
    const [newest, previous] = await taskExecutionEpisodeHistory({
      taskId: captured.taskId,
      agentSlug: captured.agentSlug,
      take: 2,
    });
    if (newest) {
      result.episode = {
        episodeNo: newest.episodeNo,
        cycleCount: newest.cycleCount,
        cycleBudget: newest.cycleBudget,
        cyclesRemaining: Math.max(0, newest.cycleBudget - newest.cycleCount),
        toolCycleCount: newest.toolCycleCount,
        toolCycleBudget: newest.toolCycleBudget,
        toolCyclesRemaining: Math.max(0, newest.toolCycleBudget - newest.toolCycleCount),
        rolledOver:
          newest.cycleCount === 0 &&
          (previous?.closeReason === EPISODE_CLOSE_REASON.budgetExhausted ||
            previous?.closeReason === EPISODE_CLOSE_REASON.toolBudgetExhausted),
        nextEpisodeNo: null,
      };
    }
  }
  return NextResponse.json(
    {
      ...body,
      ...result,
      ...(result.episode?.rolledOver
        ? {
            episodeBudgetExhausted: true,
            instruction:
              "Your execution episode budget is spent. Record what you know with action=checkpoint (completedWork, evidence, openChecklist, nextAction, risks) and stop — PM dispatches the next episode with a fresh session briefed from that checkpoint.",
          }
        : {}),
    },
    { status: response.status },
  );
}
