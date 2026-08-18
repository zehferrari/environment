// ORCH-02 — Canonical workflow command and decision types.
//
// The orchestrator is the single boundary between workflow intents (typed
// domain language) and the transition kernel + outbox + procedure engine. An
// authorized actor submits a TaskWorkflowCommand; the orchestrator authorizes
// it, decides the transition + effects, and executes the decision in one
// transaction. Routes translate UI/API/agent actions into commands and return
// the projection.
//
// Invariants enforced here (§2 core invariants):
//   1. Single status writer — execute.ts calls applyTaskTransition; no other
//      module mutates Task.status.
//   2. Optimistic concurrency — expectedWorkflowVersion is checked; stale
//      commands return 409.
//   3. Cycle-scoped identity — idempotency keys include the cycle id.
//   4. Atomic decision and effects — the transition + cycle mutation +
//      outbox/procedure records commit in one transaction.
//   7. One active PM run per task/agent lane — enforced at execute.ts.
//   8. Immutable review decision — accept_review / request_review_changes
//      name the exact review lease/candidate/cycle and authorized actor.
//   9. Separate decision from execution — repository finalization records
//      both the reviewer (decisionActorId) and the monitor/worker
//      (executorActorId).
//  10. No inferred decisions — decide.ts is a pure function of state + command.

import type { TaskWorkflowStatus } from "@/lib/tasks/transition-kernel";

// --- Intent vocabulary (§5.2) --------------------------------------------
// Domain intent names, NOT UI status names. Mechanical callbacks use separate
// intents from human/agent decisions — e.g. Karen executes
// repository_finalization_succeeded; she does not execute accept_review.
export const TASK_WORKFLOW_INTENTS = [
  "submit_plan",
  "approve_plan",
  "request_plan_changes",
  "start_implementation",
  "checkpoint",
  "submit_for_review",
  "repository_validation_succeeded",
  "repository_validation_failed",
  "request_review_changes",
  "accept_review",
  "repository_finalization_succeeded",
  "repository_finalization_failed",
  "raise_blocker",
  "clear_blocker",
  "cancel_task",
  "archive_task",
] as const;

export type TaskWorkflowIntent = (typeof TASK_WORKFLOW_INTENTS)[number];

// Mechanical intents — only a monitor/worker may submit these. The decision
// actor for a mechanical intent is the executor, not a reviewer.
export const MECHANICAL_INTENTS: ReadonlySet<TaskWorkflowIntent> = new Set([
  "repository_validation_succeeded",
  "repository_validation_failed",
  "repository_finalization_succeeded",
  "repository_finalization_failed",
]);

export function isMechanicalIntent(intent: TaskWorkflowIntent): boolean {
  return MECHANICAL_INTENTS.has(intent);
}

// --- Actor (§5.1) ---------------------------------------------------------
export type WorkflowActor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
  // Monitor agents act as mechanical executors. Their actor id is recorded
  // separately as executorActorId; they cannot be the decision actor for
  // review-acceptance / plan-approval / changes-requested intents.
  role?: "reporter" | "reviewer" | "assignee" | "monitor" | "admin" | "operator" | null;
};

// --- Command (§5.1) -------------------------------------------------------
export type TaskWorkflowCommand = {
  taskId: string;
  intent: TaskWorkflowIntent;
  actor: WorkflowActor;
  expectedWorkflowVersion: number;
  // The cycle the command targets. For intents that open a cycle
  // (start_implementation), this is null/omitted and the orchestrator opens a
  // new one. For intents that act on an existing cycle, this is the active
  // cycle id — the orchestrator rejects if it does not match
  // Task.activeWorkflowCycleId.
  workflowCycleId?: string | null;
  idempotencyKey: string;
  source: string;
  messageId?: string | null;
  evidence?: Record<string, unknown>;
  // Optional structured payload for the intent (e.g. candidateSha for
  // submit_for_review, reviewerComment for request_review_changes).
  payload?: Record<string, unknown>;
};

// --- Decision (§5.3) ------------------------------------------------------
// The pure decision layer returns the transition + cycle operation + effects
// the orchestrator must durably record. The decision function must NOT access
// network, filesystem, OpenClaw gateway, Git, or spool directories.
export type CycleOperation = "none" | "open" | "update" | "close";

export type TaskProcedureType =
  | "prepare_todo_task"
  | "start_implementation_cycle"
  | "submit_candidate_for_review"
  | "return_review_for_changes"
  | "finalize_accepted_review";

export type WorkflowEffect =
  | { type: "task_notification"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "board_touch"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "branch_verify"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "review_finalize"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "epic_cleanup"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "epic_completion_review"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "epic_completion_review_approval"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "dependency_refill"; key: string; payload: Record<string, unknown>; availableAt?: Date };

export type OrchestrationDecision = {
  fromStatus: TaskWorkflowStatus;
  toStatus: TaskWorkflowStatus;
  // The transition kernel intent. Mapped from the domain intent because the
  // kernel's intent vocabulary is the legacy one (start, submit_review, ...).
  // The orchestrator owns the mapping; routes never call the kernel directly.
  kernelIntent:
    | "start"
    | "auto_start"
    | "submit_review"
    | "repository_validated"
    | "request_changes"
    | "repository_validation_failed"
    | "repository_reopen"
    | "accept_review"
    | "triage"
    | "approve_plan"
    | "reopen"
    | "queue"
    | "cancel"
    | "operator_override";
  cycleOperation: CycleOperation;
  cycleOutcome?: "completed" | "changes_requested" | "validation_failed" | "cancelled" | "abandoned";
  procedureType?: TaskProcedureType;
  effects: WorkflowEffect[];
  evidence: Record<string, unknown>;
  // The authorized decision actor for this transition. For mechanical
  // intents, this is the reviewer who authorized the underlying decision
  // (recovered from the review lease), NOT the monitor executing the callback.
  decisionActorId: string;
  // The mechanical executor (monitor/worker). Null for human/agent decisions.
  executorActorId?: string | null;
  // Rank for the transition (front of To Do for feedback/validation failure).
  rank?: "front" | "back";
  // Additional Task columns to set in the same transition kernel call (e.g.
  // approvedOn/approvedById for approve_plan, alertReporter:false on review
  // acceptance). The kernel applies these atomically with the status change.
  taskData?: Record<string, unknown>;
};

// --- Orchestrator result (§5.5) ------------------------------------------
export type OrchestratorResult =
  | { status: "replayed"; transitionId: string; workflowVersion: number; procedureId?: string | null }
  | { status: "accepted"; transitionId: string; workflowVersion: number; procedureId?: string | null; cycleId?: string | null }
  | { status: "stale"; reason: string }
  | { status: "forbidden"; reason: string }
  | { status: "invalid"; reason: string; details?: Record<string, unknown> }
  | { status: "operational"; reason: string };

// --- State snapshot passed to the decision function ----------------------
// The decision function is pure: it receives a snapshot of the task's current
// state and the command, and returns the decision. It must not touch the DB.
export type TaskStateSnapshot = {
  id: string;
  status: TaskWorkflowStatus;
  workflowVersion: number;
  projectId: string;
  epicId: string | null;
  assigneeId: string | null;
  actingManagerId: string | null;
  reporterId: string | null;
  approvedOn: Date | null;
  approvedById: string | null;
  activeWorkflowCycleId: string | null;
  // Resolved reviewer (acting manager -> actionable Epic acting manager ->
  // reporter) at decision time.
  resolvedReviewOwnerId: string | null;
  // Active review lease for the current cycle, if any.
  activeReviewRun?: {
    id: string;
    status: string;
    candidateSha: string;
    reviewerId: string | null;
  } | null;
  // Active repository run, if any.
  repositoryRun?: {
    phase: string;
    candidateSha: string | null;
    baseSha: string | null;
    repoTouched: boolean | null;
    reviewedSha: string | null;
  } | null;
  project: {
    onlyReportersCanApproveActionPlans: boolean;
    onlyReportersCanSetTasksDone: boolean;
    repositoryPath: string | null;
  };
  epic?: {
    status: string;
    actingManagerId: string | null;
  } | null;
};