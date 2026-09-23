// ORCH-02 — Task shell/procedure status projection for UI and agents.
//
// Serializes the current workflow state — status, cycle, active procedure,
// resolved reviewer, allowed next intents, operational-error state — for the
// task detail UI and the agent context builder. The projection is read-only;
// it never mutates state.
//
// This is the single shape agents and humans see. Agent prompts (ORCH-09) and
// the task Execution/Activity UI both consume it.
//
// PHASEE-10 — Expanded to expose engine ownership, command receipts, episode
// state, repository state, and actor-specific allowed actions. The projection
// is consumed by the doctor --json phaseE section and the cohort/dashboard
// endpoints as the operator-visible surface.

import { db } from "@/lib/db";
import {
  TASK_WORKFLOW_INTENTS,
  type TaskWorkflowIntent,
  type WorkflowActorRole,
} from "@/lib/tasks/orchestrator/types";
import {
  resolveReviewOwnerId,
} from "@/lib/tasks/workflow-actors";
import { getActiveTaskWorkflowCycle } from "@/lib/tasks/workflow-cycle";
import type { TaskStateSnapshot } from "@/lib/tasks/orchestrator/types";

export type EngineOwnership = "legacy" | "orchestrator_v2";

export type CommandReceiptSummary = {
  idempotencyKey: string;
  intent: string;
  actorUserId: string | null;
  decisionActorId: string | null;
  createdAt: Date;
  status: string;
  result: string | null;
  replayed: boolean;
};

export type EpisodeState = {
  episodeNo: number;
  agentSlug: string;
  status: string;
  cycleCount: number;
  cycleBudget: number;
  checkpointSummary: {
    completedWork: string[];
    nextAction: string | null;
    openChecklist: string[];
  } | null;
};

export type RepositoryState = {
  phase: string;
  candidateSha: string | null;
  baseSha: string | null;
  repoTouched: boolean | null;
  procedureRunId: string | null;
  procedureStepId: string | null;
};

export type TaskWorkflowProjection = {
  taskId: string;
  status: string;
  workflowVersion: number;
  // PHASEE-10 — Engine ownership
  workflowEngine: EngineOwnership;
  workflowEnginePinnedAt: Date | null;
  activeCycle: {
    id: string;
    sequence: number;
    status: string;
    outcome: string | null;
    candidateSha: string | null;
    baseSha: string | null;
    // PHASEE-10 — Cycle-level engine ownership
    workflowEngine: EngineOwnership;
  } | null;
  // PHASEE-10 — Command receipt summary (last receipt for this task)
  lastCommandReceipt: CommandReceiptSummary | null;
  // PHASEE-10 — Episode state (current/most recent open episode)
  episodeState: EpisodeState | null;
  // PHASEE-10 — Repository state
  repositoryState: RepositoryState | null;
  resolvedReviewerId: string | null;
  activeReviewLease: {
    id: string;
    status: string;
    candidateSha: string;
    reviewerId: string | null;
  } | null;
  activeProcedure: {
    type: string;
    status: string;
    currentStep: string | null;
  } | null;
  // The next intents the current viewer/actor is allowed to submit. Computed
  // from the task status + cycle state; the actual authorization check runs
  // at command time, but this list guides the UI/agent prompt.
  // PHASEE-10 — Optionally filtered by actorRole.
  allowedIntents: TaskWorkflowIntent[];
  operationalError: string | null;
};

/**
 * Build the workflow projection for a task. Reads only.
 *
 * PHASEE-10 — Expanded to include engine ownership, command receipt summary,
 * episode state, and repository state. The projection is consumed by the
 * doctor --json phaseE section and the cohort/dashboard endpoints as the
 * operator-visible surface.
 */
export async function buildTaskWorkflowProjection(taskId: string): Promise<TaskWorkflowProjection | null> {
  const task = await db.task.findUnique({
    where: { id: taskId, deletedAt: null },
    select: {
      id: true,
      status: true,
      workflowVersion: true,
      projectId: true,
      epicId: true,
      assigneeId: true,
      actingManagerId: true,
      reporterId: true,
      approvedOn: true,
      approvedById: true,
      activeWorkflowCycleId: true,
      // PHASEE-10 — Engine ownership
      workflowEngine: true,
      workflowEnginePinnedAt: true,
      project: {
        select: {
          onlyReportersCanApproveActionPlans: true,
          onlyReportersCanSetTasksDone: true,
          repositoryPath: true,
        },
      },
      epic: { select: { status: true, actingManagerId: true, approvedOn: true } },
      repositoryRun: {
        select: {
          phase: true,
          candidateSha: true,
          baseSha: true,
          repoTouched: true,
          reviewedSha: true,
          lastError: true,
          // PHASEE-10 — procedure correlation
          workflowCycleId: true,
        },
      },
    },
  });
  if (!task) return null;

  const activeCycle = await getActiveTaskWorkflowCycle(taskId);
  const reviewRun = activeCycle
    ? await db.reviewRun.findUnique({
        where: { workflowCycleId: activeCycle.id },
        select: { id: true, status: true, candidateSha: true, reviewerId: true, baseSha: true, repoTouched: true, validationOutcome: true },
      })
    : null;

  // Find the active procedure run for this task (most recent non-completed).
  const activeProcedureRun = await db.taskProcedureRun.findFirst({
    where: {
      taskId,
      status: { in: ["queued", "running", "operational_error"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, type: true, status: true, currentStep: true },
  });

  // PHASEE-10 — Fetch the last command receipt for this task.
  const lastReceipt = await db.taskWorkflowCommandReceipt.findFirst({
    where: { taskId },
    orderBy: { createdAt: "desc" },
    select: {
      idempotencyKey: true,
      intent: true,
      actorUserId: true,
      decisionActorId: true,
      createdAt: true,
      status: true,
      result: true,
    },
  });

  // PHASEE-10 — Fetch the current/most recent open execution episode.
  const currentEpisode = await db.taskExecutionEpisode.findFirst({
    where: { taskId, status: "open" },
    orderBy: { episodeNo: "desc" },
    select: {
      episodeNo: true,
      agentSlug: true,
      status: true,
      cycleCount: true,
      cycleBudget: true,
      completedWork: true,
      nextAction: true,
      openChecklist: true,
    },
  });

  // PHASEE-10 — Fetch procedure run/step correlation for repository state.
  const repoProcedureRun = task.repositoryRun?.workflowCycleId
    ? await db.taskProcedureRun.findFirst({
        where: { workflowCycleId: task.repositoryRun.workflowCycleId },
        orderBy: { createdAt: "desc" },
        select: { id: true, currentStep: true },
      })
    : null;

  const snapshot: TaskStateSnapshot = {
    id: task.id,
    status: task.status as TaskStateSnapshot["status"],
    workflowVersion: task.workflowVersion,
    projectId: task.projectId,
    epicId: task.epicId,
    assigneeId: task.assigneeId,
    actingManagerId: task.actingManagerId,
    reporterId: task.reporterId,
    approvedOn: task.approvedOn,
    approvedById: task.approvedById,
    activeWorkflowCycleId: task.activeWorkflowCycleId,
    resolvedReviewOwnerId: resolveReviewOwnerId({
      actingManagerId: task.actingManagerId,
      reporterId: task.reporterId,
      epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId, approvedOn: task.epic.approvedOn } : null,
    }),
    activeReviewRun: reviewRun
      ? { id: reviewRun.id, status: reviewRun.status, candidateSha: reviewRun.candidateSha, reviewerId: reviewRun.reviewerId, baseSha: reviewRun.baseSha, repoTouched: reviewRun.repoTouched, validationOutcome: reviewRun.validationOutcome }
      : null,
    repositoryRun: task.repositoryRun
      ? {
          phase: task.repositoryRun.phase,
          candidateSha: task.repositoryRun.candidateSha,
          baseSha: task.repositoryRun.baseSha,
          repoTouched: task.repositoryRun.repoTouched,
          reviewedSha: task.repositoryRun.reviewedSha,
        }
      : null,
    project: {
      onlyReportersCanApproveActionPlans: task.project.onlyReportersCanApproveActionPlans,
      onlyReportersCanSetTasksDone: task.project.onlyReportersCanSetTasksDone,
      repositoryPath: task.project.repositoryPath,
    },
    epic: task.epic ? { status: task.epic.status, actingManagerId: task.epic.actingManagerId, approvedOn: task.epic.approvedOn } : null,
  };

  const operationalError =
    task.repositoryRun?.phase === "operational_error" ? task.repositoryRun.lastError : null;

  // PHASEE-10 — Parse episode checkpoint summary.
  const episodeState: EpisodeState | null = currentEpisode
    ? {
        episodeNo: currentEpisode.episodeNo,
        agentSlug: currentEpisode.agentSlug,
        status: currentEpisode.status,
        cycleCount: currentEpisode.cycleCount,
        cycleBudget: currentEpisode.cycleBudget,
        checkpointSummary: currentEpisode.completedWork || currentEpisode.nextAction || currentEpisode.openChecklist
          ? {
              completedWork: currentEpisode.completedWork ? safeJsonParseArray(currentEpisode.completedWork) : [],
              nextAction: currentEpisode.nextAction ?? null,
              openChecklist: currentEpisode.openChecklist ? safeJsonParseArray(currentEpisode.openChecklist) : [],
            }
          : null,
      }
    : null;

  // PHASEE-10 — Parse receipt replayed flag.
  const lastCommandReceipt: CommandReceiptSummary | null = lastReceipt
    ? {
        idempotencyKey: lastReceipt.idempotencyKey,
        intent: lastReceipt.intent,
        actorUserId: lastReceipt.actorUserId,
        decisionActorId: lastReceipt.decisionActorId,
        createdAt: lastReceipt.createdAt,
        status: lastReceipt.status,
        result: lastReceipt.result,
        replayed: lastReceipt.status === "accepted" && lastReceipt.result.includes("\"replayed\""),
      }
    : null;

  const engineOwnership = (task.workflowEngine === "orchestrator_v2" ? "orchestrator_v2" : "legacy") as EngineOwnership;
  const cycleEngineOwnership = activeCycle
    ? (activeCycle.workflowEngine === "orchestrator_v2" ? "orchestrator_v2" : "legacy") as EngineOwnership
    : null;

  return {
    taskId: task.id,
    status: task.status,
    workflowVersion: task.workflowVersion,
    workflowEngine: engineOwnership,
    workflowEnginePinnedAt: task.workflowEnginePinnedAt,
    activeCycle: activeCycle
      ? {
          id: activeCycle.id,
          sequence: activeCycle.sequence,
          status: activeCycle.status,
          outcome: activeCycle.outcome,
          candidateSha: activeCycle.candidateSha,
          baseSha: activeCycle.baseSha,
          // Expose the durable cycle row, even when it contradicts the task.
          // Doctor/reconciliation surfaces the mismatch as a stop condition.
          workflowEngine: cycleEngineOwnership!,
        }
      : null,
    lastCommandReceipt,
    episodeState,
    repositoryState: task.repositoryRun
      ? {
          phase: task.repositoryRun.phase,
          candidateSha: task.repositoryRun.candidateSha,
          baseSha: task.repositoryRun.baseSha,
          repoTouched: task.repositoryRun.repoTouched,
          procedureRunId: repoProcedureRun?.id ?? null,
          procedureStepId: repoProcedureRun?.currentStep ?? null,
        }
      : null,
    resolvedReviewerId: snapshot.resolvedReviewOwnerId,
    activeReviewLease: reviewRun
      ? {
          id: reviewRun.id,
          status: reviewRun.status,
          candidateSha: reviewRun.candidateSha,
          reviewerId: reviewRun.reviewerId,
        }
      : null,
    activeProcedure: activeProcedureRun
      ? {
          type: activeProcedureRun.type,
          status: activeProcedureRun.status,
          currentStep: activeProcedureRun.currentStep,
        }
      : null,
    allowedIntents: computeAllowedIntents(snapshot),
    operationalError,
  };
}

/**
 * Compute the set of intents that are structurally allowed for the task's
 * current state. This is a UI/prompt hint; the actual authorization check
 * runs at command time. An intent appears here if its guards would pass
 * (status + cycle + lease preconditions), regardless of actor identity.
 *
 * PHASEE-10 — When `actorRole` is provided, the returned intents are filtered
 * to only those the given role is permitted to submit. When omitted, the
 * full structurally-allowed set is returned (backward compatible).
 */
export function computeAllowedIntents(
  state: TaskStateSnapshot,
  actorRole?: WorkflowActorRole,
): TaskWorkflowIntent[] {
  const allowed: TaskWorkflowIntent[] = [];
  const status = state.status;
  const hasActiveCycle = Boolean(state.activeWorkflowCycleId);
  const hasAwaitingLease = state.activeReviewRun?.status === "awaiting_review";

  if (status === "Backlog" || status === "To Do") {
    if (!state.approvedOn) {
      allowed.push("submit_plan", "approve_plan", "request_plan_changes");
    } else {
      allowed.push("start_implementation");
    }
  }
  if (status === "To Do" && !hasActiveCycle && state.approvedOn) {
    allowed.push("start_implementation");
  }
  if (status === "In Progress" && hasActiveCycle) {
    allowed.push("checkpoint", "submit_for_review", "raise_blocker", "clear_blocker");
  }
  if (status === "Review" && hasActiveCycle) {
    if (hasAwaitingLease) {
      allowed.push("accept_review", "request_review_changes");
    }
    allowed.push("repository_finalization_succeeded", "repository_finalization_failed");
  }
  if (state.approvedOn && ["To Do", "In Progress", "Review"].includes(status)) allowed.push("request_plan_revision");
  if (status === "Done") {
    allowed.push("archive_task");
  }
  // Cancel is allowed from most non-Done statuses.
  if (status !== "Done") {
    allowed.push("cancel_task");
  }
  // Dedupe while preserving order.
  const deduped = Array.from(new Set(allowed));

  // PHASEE-10 — Filter by actor role when provided.
  if (!actorRole) return deduped;
  return deduped.filter((intent) => isIntentAllowedForRole(intent, actorRole));
}

/**
 * PHASEE-10 — Role-based intent filtering.
 * Maps each intent to the roles permitted to submit it.
 */
function isIntentAllowedForRole(intent: TaskWorkflowIntent, role: WorkflowActorRole): boolean {
  if (!role) return true;
  // Cast to string for comparison to avoid TS narrowing after the admin/operator early return.
  const r: string = role;

  // Admin/operator can submit any intent.
  if (r === "admin" || r === "operator") return true;

  // Mechanical intents — only monitor role.
  if (
    intent === "repository_validation_succeeded" ||
    intent === "repository_validation_failed" ||
    intent === "repository_finalization_succeeded" ||
    intent === "repository_finalization_failed" ||
    intent === "worktree_revalidation_failed"
  ) {
    return r === "monitor";
  }

  // Operational intents — assignee or admin.
  if (
    intent === "checkpoint" ||
    intent === "add_subtask" ||
    intent === "complete_subtask" ||
    intent === "remove_subtask" ||
    intent === "request_subtask" ||
    intent === "request_task" ||
    intent === "publish_checkpoint"
  ) {
    return r === "assignee" || r === "admin" || r === "operator";
  }

  // Plan-related intents.
  if (intent === "request_plan_revision") return ["assignee", "reviewer", "reporter", "admin", "operator"].includes(r);
  if (intent === "submit_plan") {
    return r === "assignee" || r === "admin" || r === "operator";
  }
  if (intent === "approve_plan" || intent === "request_plan_changes") {
    return r === "reviewer" || r === "reporter" || r === "admin" || r === "operator";
  }

  // Implementation intents.
  if (intent === "start_implementation" || intent === "submit_for_review") {
    return r === "assignee" || r === "admin" || r === "operator";
  }

  // Blocker intents.
  if (intent === "raise_blocker" || intent === "clear_blocker") {
    return r === "assignee" || r === "admin" || r === "operator";
  }

  // Review decision intents.
  if (intent === "accept_review" || intent === "request_review_changes") {
    return r === "reviewer" || r === "admin" || r === "operator";
  }

  // Triage/assignment.
  if (intent === "triage_task" || intent === "assign_task") {
    return r === "admin" || r === "operator" || r === "reporter";
  }

  // Scope blocker.
  if (intent === "raise_scope_blocker") {
    return r === "assignee" || r === "admin" || r === "operator";
  }

  // Cancel/archive — any role with authority.
  if (intent === "cancel_task" || intent === "archive_task") {
    return r === "admin" || r === "operator" || r === "reporter";
  }

  return false;
}

/**
 * PHASEE-10 — Safely parse a JSON-encoded string array.
 */
function safeJsonParseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export { TASK_WORKFLOW_INTENTS };
