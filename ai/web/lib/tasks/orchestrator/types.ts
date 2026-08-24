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

// ---------------------------------------------------------------------------
// §15 — Command source: every transport that submits workflow commands.
// ---------------------------------------------------------------------------

export type WorkflowCommandSource =
  | "agent"
  | "browser"
  | "automation"
  | "callback"
  | "operator"
  | "pm-service";

// ---------------------------------------------------------------------------
// §14 — AgentExecutionContext: authenticated PM-channel episode integration.
// Passed into the command when the agent workflow route submits through the
// orchestrator. The orchestrator must atomically settle the current run,
// update final checkpoints, arm/suppress continuation, handle episode
// rollover, and produce the response projection — all inside the same
// transaction as the workflow transition.
// ---------------------------------------------------------------------------

export type AgentExecutionContext = {
  agentSlug: string;
  pmChannelRunId: string;
  sourceMessageId: string;
  publicAction: WorkflowPublicAction;
  expectedEpisodeId: string | null;
};

// ---------------------------------------------------------------------------
// §15 — Public action vocabulary (transport-level actions the route accepts).
// These are the raw action strings the agent workflow route, browser server
// actions, and operator tools send. The normalizer (normalize.ts) maps them
// to canonical domain intents.
// ---------------------------------------------------------------------------

export const WORKFLOW_PUBLIC_ACTIONS = [
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
  "override_status",
] as const;

export type WorkflowPublicAction = (typeof WORKFLOW_PUBLIC_ACTIONS)[number];

// ---------------------------------------------------------------------------
// §5.2 — Intent vocabulary (domain intent names, NOT UI status names).
// Mechanical callbacks use separate intents from human/agent decisions —
// e.g. Karen executes repository_finalization_succeeded; she does not
// execute accept_review.
//
// Extended with new intents from spec §15:
//   - triage_task, assign_task, raise_scope_blocker
// ---------------------------------------------------------------------------

export const TASK_WORKFLOW_INTENTS = [
  // Decision intents (human/agent)
  "submit_plan",
  "approve_plan",
  "request_plan_changes",
  "start_implementation",
  "checkpoint",
  "submit_for_review",
  "request_review_changes",
  "accept_review",
  "raise_blocker",
  "clear_blocker",
  "cancel_task",
  "archive_task",
  // New decision intents (spec §15)
  "triage_task",
  "assign_task",
  "raise_scope_blocker",
  "override_status",
  "epic_child_update",
  // Mechanical intents (monitor/worker only)
  "repository_validation_succeeded",
  "repository_validation_failed",
  "repository_finalization_succeeded",
  "repository_finalization_failed",
  "worktree_revalidation_failed",
  // Operational intents (spec §15 design choice: typed in the command boundary)
  "publish_checkpoint",
  "add_subtask",
  "complete_subtask",
  "remove_subtask",
  "request_subtask",
  "request_task",
] as const;

export type TaskWorkflowIntent = (typeof TASK_WORKFLOW_INTENTS)[number];

// Mechanical intents — only a monitor/worker may submit these. The decision
// actor for a mechanical intent is the executor, not a reviewer.
export const MECHANICAL_INTENTS: ReadonlySet<TaskWorkflowIntent> = new Set([
  "repository_validation_succeeded",
  "repository_validation_failed",
  "repository_finalization_succeeded",
  "repository_finalization_failed",
  "worktree_revalidation_failed",
]);

export function isMechanicalIntent(intent: TaskWorkflowIntent): boolean {
  return MECHANICAL_INTENTS.has(intent);
}

// Operational intents — checklist/subtask/checkpoint actions that participate
// in episode continuation and workflow truth but do not always change status.
// They are typed in the command boundary (spec §15 design choice 1) so
// checklist completion remains atomic with its PM-channel action disposition.
export const OPERATIONAL_INTENTS: ReadonlySet<TaskWorkflowIntent> = new Set([
  "publish_checkpoint",
  "add_subtask",
  "complete_subtask",
  "remove_subtask",
  "request_subtask",
  "request_task",
]);

export function isOperationalIntent(intent: TaskWorkflowIntent): boolean {
  return OPERATIONAL_INTENTS.has(intent);
}

// ---------------------------------------------------------------------------
// §5.1 — Actor
// ---------------------------------------------------------------------------
// WorkflowActor.role is SERVER-RESOLVED ONLY. Transports must never copy it
// from request JSON; the orchestrator/authorize.ts resolves the role from
// authenticated context (assignment, reviewer resolution, registry lookup).
// The normalizer strips any client-supplied role field.

export type WorkflowActorRole =
  | "reporter"
  | "reviewer"
  | "assignee"
  | "monitor"
  | "admin"
  | "operator"
  | null;

export type WorkflowActor = {
  id: string;
  kind: "human" | "agent";
  username?: string | null;
  // SERVER-RESOLVED ONLY — never copied from request JSON. The transport
  // may leave this undefined; authorize.ts sets it from assignment/registry.
  role?: WorkflowActorRole;
  // SERVER-RESOLVED ONLY — whether the actor has coding capability.
  // Resolved upstream from the DB agent record (agent.role === "coding")
  // and carried on the actor so authorizeCommand stays a pure function.
  codingCapability?: boolean;
};

export type WorkflowSubtaskKind = "implementation" | "review";

// ---------------------------------------------------------------------------
// Per-intent payload types (discriminated union).
// Each intent carries a concrete payload type instead of Record<string, unknown>.
// ---------------------------------------------------------------------------

// --- Decision intent payloads ---------------------------------------------

export type SubmitPlanPayload = {
  actionPlan: {
    summary: string;
    steps: Array<{
      id: string;
      title: string;
      acceptanceCriteria: string[];
      kind: "sequential" | "parallel";
      assigneeId?: string | null;
    }>;
  };
  /** In-reply-to message ID for threading. */
  inReplyToMessageId?: string | null;
};

export type ApprovePlanPayload = {
  actionPlanId: string;
  actionPlanVersion: number;
  /** Optional constraints the reviewer wants the assignee to hold to. */
  constraints?: string | null;
};

export type RequestPlanChangesPayload = {
  actionPlanId: string;
  actionPlanVersion: number;
  reviewerComment: string;
};

export type StartImplementationPayload = {
  /** Worktree path (server-resolved from worktree creation). */
  worktreePath?: string | null;
  /** Branch name (server-resolved from repository contract). */
  branchName?: string | null;
};

export type CheckpointPayload = {
  completedWork?: string[];
  evidence?: string[];
  openChecklist?: string[];
  nextAction?: string;
  risks?: string[];
};

export type SubmitForReviewPayload = {
  /** Candidate SHA (server-resolved from worktree HEAD). */
  candidateSha: string | null;
  /** Base SHA (server-resolved from Epic branch tip). */
  baseSha: string | null;
  /** Whether the task touched the repository. */
  repoTouched: boolean;
  /** Worktree path for the candidate. */
  worktreePath?: string | null;
  /** Branch name for the candidate. */
  branchName?: string | null;
  /** Ready-for-review note. */
  comment?: string | null;
};

export type RequestReviewChangesPayload = {
  reviewRunId: string;
  candidateSha: string;
  /** Non-empty reviewer comment within size limit. */
  reviewerComment: string;
};

export type AcceptReviewPayload = {
  reviewRunId: string;
  candidateSha: string;
};

export type RaiseBlockerPayload = {
  blockerReport: {
    blockedOn: "person" | "permission" | "external_service" | "decision" | "dependency";
    requestedActor: string | null;
    requestedAction: string;
    evidence: string | string[];
    diagnosticsAttempted: string[];
    resumeCondition: string;
    reporterCanResolve: boolean;
  };
  /** Optional permission request for reporter-only blockers. */
  permissionKind?: "reporter_approval" | "publish_checkpoint" | null;
  permissionScope?: string | null;
  /** General blocker comment. */
  comment?: string | null;
};

export type ClearBlockerPayload = {
  blockerId: string;
  /** Resolution evidence. */
  resolution: string;
};

export type CancelTaskPayload = {
  reason?: string | null;
};

export type ArchiveTaskPayload = Record<string, never>;

// --- New decision intent payloads (spec §15) ------------------------------

export type TriageTaskPayload = {
  /** Target status after triage (To Do or Backlog). */
  targetStatus: "To Do" | "Backlog";
  reason?: string | null;
};

export type AssignTaskPayload = {
  /** Username of the agent/human to assign. */
  assigneeUsername: string | null;
  /** Whether to assign after plan approval (vs. immediate). */
  afterPlanApproval: boolean;
};

export type OverrideStatusPayload = {
  targetStatus: "Backlog" | "To Do" | "In Progress" | "Review" | "Done";
  reason?: string | null;
};

/**
 * Internal Epic adapter command. This is intentionally not a public workflow
 * action: authenticated Epic/browser transports use it to keep child status,
 * queue rank, assignment, archive, and plan-revision writes in one canonical
 * command transaction.
 */
export type EpicChildUpdatePayload = {
  epicId: string;
  targetStatus: "Backlog" | "To Do" | "In Progress" | "Review" | "Done";
  reason: string;
  rank: "front" | "back";
  clearAssignee: boolean;
  clearArchive: boolean;
  archive: boolean;
  resetPlanApproval: boolean;
  comment?: string | null;
  notification?: {
    targetUserId: string;
    reason: string;
    body: string;
  } | null;
};

export type RaiseScopeBlockerPayload = {
  /** Description of the extra work needed. */
  scopeDescription: string;
  /** Evidence supporting the scope expansion. */
  evidence?: string[];
  /** Requested actor for approval. */
  requestedActor?: string | null;
};

// --- Mechanical intent payloads -------------------------------------------

export type RepositoryValidationSucceededPayload = {
  procedureRunId: string;
  procedureStepId: string;
  /** Job ID from the repository run. May be null when the callback is
   * invoked from a procedure context that does not have the original
   * jobId in scope — PHASEE-07 will fence on exact correlation. */
  jobId: string | null;
  /** Candidate SHA under validation. May be null when the callback
   * context does not have the SHA in scope (PHASEE-07 will fence on
   * exact correlation). */
  candidateSha: string | null;
  /** Base SHA of the Epic branch at callback time. May be null when
   * absent — null means "skip the base-sha equality check", not "". */
  baseSha: string | null;
  outcome: "succeeded";
};

export type RepositoryValidationFailedPayload = {
  procedureRunId: string;
  procedureStepId: string;
  jobId: string | null;
  candidateSha: string | null;
  baseSha: string | null;
  outcome: "failed";
  /** Failure reason / diagnostics. */
  failureReason?: string | null;
};

export type WorktreeRevalidationFailedPayload = {
  procedureRunId: string;
  procedureStepId: string;
  /** Worktree revalidation failure reason / diagnostics. */
  failureReason: string;
  outcome: "failed";
};

export type RepositoryFinalizationSucceededPayload = {
  procedureRunId: string;
  procedureStepId: string;
  jobId: string | null;
  candidateSha: string | null;
  baseSha: string | null;
  outcome: "succeeded";
  /** Published Epic branch SHA after merge. */
  publishedSha?: string | null;
};

export type RepositoryFinalizationFailedPayload = {
  procedureRunId: string;
  procedureStepId: string;
  jobId: string | null;
  candidateSha: string | null;
  baseSha: string | null;
  outcome: "failed";
  failureReason?: string | null;
};

// --- Operational intent payloads ------------------------------------------

export type PublishCheckpointPayload = {
  /** Authorization comment ID from the owner grant. */
  authorizationCommentId: string;
  /** Candidate SHA to publish. */
  candidateSha?: string | null;
  /** Base SHA (Epic branch tip at the time). */
  baseSha?: string | null;
  /** Optional operator-facing note carried to the durable checkpoint job. */
  comment?: string | null;
};

export type AddSubtaskPayload = {
  subtaskText: string;
  subtaskKind: WorkflowSubtaskKind;
};

export type CompleteSubtaskPayload = {
  subtaskId: string;
  subtaskKind: WorkflowSubtaskKind;
  completed: boolean;
  minutesSpent?: number | null;
};

export type RemoveSubtaskPayload = {
  subtaskId: string;
  subtaskKind: WorkflowSubtaskKind;
};

export type RequestSubtaskPayload = {
  subtaskText: string;
  reason: string;
};

export type RequestTaskPayload = {
  taskTitle: string;
  taskDescription?: string | null;
  epicId?: string | null;
  reason: string;
};

// ---------------------------------------------------------------------------
// Discriminated union: TaskWorkflowCommand keyed by intent.
// Each variant carries a typed payload instead of Record<string, unknown>.
// ---------------------------------------------------------------------------

/** Common fields shared by every command variant. */
export type TaskWorkflowCommandBase = {
  taskId: string;
  intent: TaskWorkflowIntent;
  actor: WorkflowActor;
  expectedWorkflowVersion: number;
  /** The cycle the command targets. For intents that open a cycle
   * (start_implementation), this is null/omitted and the orchestrator opens a
   * new one. For intents that act on an existing cycle, this is the active
   * cycle id — the orchestrator rejects if it does not match
   * Task.activeWorkflowCycleId. */
  workflowCycleId?: string | null;
  idempotencyKey: string;
  /** Transport source. New code MUST use WorkflowCommandSource; the string
   * type is retained for backward compatibility with existing procedure
   * handlers that use internal source labels. */
  source: WorkflowCommandSource | string;
  messageId?: string | null;
  /** Optional authenticated PM-channel execution context (spec §14). */
  executionContext?: AgentExecutionContext | null;
  /** Legacy evidence bag — retained for backward compatibility with existing
   * modules that pass evidence alongside the typed payload. New code SHOULD
   * use the typed payload instead; this field will be removed once all
   * consumers are migrated. */
  evidence?: Record<string, unknown>;
};

/** Map intent → payload type. Used to build the discriminated union. */
interface IntentPayloadMap {
  submit_plan: SubmitPlanPayload;
  approve_plan: ApprovePlanPayload;
  request_plan_changes: RequestPlanChangesPayload;
  start_implementation: StartImplementationPayload;
  checkpoint: CheckpointPayload;
  submit_for_review: SubmitForReviewPayload;
  request_review_changes: RequestReviewChangesPayload;
  accept_review: AcceptReviewPayload;
  raise_blocker: RaiseBlockerPayload;
  clear_blocker: ClearBlockerPayload;
  cancel_task: CancelTaskPayload;
  archive_task: ArchiveTaskPayload;
  triage_task: TriageTaskPayload;
  assign_task: AssignTaskPayload;
  raise_scope_blocker: RaiseScopeBlockerPayload;
  override_status: OverrideStatusPayload;
  epic_child_update: EpicChildUpdatePayload;
  repository_validation_succeeded: RepositoryValidationSucceededPayload;
  repository_validation_failed: RepositoryValidationFailedPayload;
  worktree_revalidation_failed: WorktreeRevalidationFailedPayload;
  repository_finalization_succeeded: RepositoryFinalizationSucceededPayload;
  repository_finalization_failed: RepositoryFinalizationFailedPayload;
  publish_checkpoint: PublishCheckpointPayload;
  add_subtask: AddSubtaskPayload;
  complete_subtask: CompleteSubtaskPayload;
  remove_subtask: RemoveSubtaskPayload;
  request_subtask: RequestSubtaskPayload;
  request_task: RequestTaskPayload;
}

/** Discriminated union: TaskWorkflowCommand is keyed by `intent`, each variant
 * carrying a typed `payload` from IntentPayloadMap. */
export type TaskWorkflowCommand = {
  [K in TaskWorkflowIntent]: TaskWorkflowCommandBase & {
    intent: K;
    payload: IntentPayloadMap[K];
  };
}[TaskWorkflowIntent];

// ---------------------------------------------------------------------------
// Legacy-compatible command shape for backward compatibility.
// Existing modules that construct TaskWorkflowCommand with generic
// payload/evidence can use this type during migration. New code MUST use the
// discriminated union above.
// ---------------------------------------------------------------------------

export type LegacyTaskWorkflowCommand = TaskWorkflowCommandBase & {
  intent: TaskWorkflowIntent;
  payload?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Domain error codes (spec §18 — stable error codes with HTTP mapping).
// ---------------------------------------------------------------------------

export const DOMAIN_ERROR_CODES = [
  "invalid_payload",
  "missing_evidence",
  "stale_version",
  "idempotency_conflict",
  "forbidden",
  "not_assignee",
  "not_reviewer",
  "not_authorized",
  "not_coding_capable",
  "lease_mismatch",
  "candidate_mismatch",
  "cycle_mismatch",
  "epic_not_actionable",
  "prerequisites_unmet",
  "wip_conflict",
  "branch_collision",
  "checklist_incomplete",
  "blocker_unresolved",
  "plan_evidence_invalid",
  "callback_correlation_mismatch",
  "operational_error",
  "unknown_intent",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

// HTTP status mapping for OrchestratorResult (spec §18).
export const RESULT_HTTP_STATUS: ReadonlyMap<string, number> = new Map([
  ["replayed", 200],
  ["accepted", 202],
  ["stale", 409],
  ["forbidden", 403],
  ["invalid", 422],
  ["operational", 503],
]);

// Domain error code → HTTP status mapping.
export const DOMAIN_ERROR_HTTP_STATUS: ReadonlyMap<DomainErrorCode, number> = new Map([
  ["invalid_payload", 422],
  ["missing_evidence", 422],
  ["stale_version", 409],
  ["idempotency_conflict", 409],
  ["forbidden", 403],
  ["not_assignee", 403],
  ["not_reviewer", 403],
  ["not_authorized", 403],
  ["not_coding_capable", 403],
  ["lease_mismatch", 409],
  ["candidate_mismatch", 409],
  ["cycle_mismatch", 409],
  ["epic_not_actionable", 409],
  ["prerequisites_unmet", 409],
  ["wip_conflict", 409],
  ["branch_collision", 409],
  ["checklist_incomplete", 422],
  ["blocker_unresolved", 422],
  ["plan_evidence_invalid", 422],
  ["callback_correlation_mismatch", 409],
  ["operational_error", 503],
  ["unknown_intent", 422],
]);

// ---------------------------------------------------------------------------
// §5.3 — Decision types (unchanged from ORCH-02, re-exported).
// ---------------------------------------------------------------------------

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
  | { type: "dependency_refill"; key: string; payload: Record<string, unknown>; availableAt?: Date }
  | { type: "repository_checkpoint"; key: string; payload: Record<string, unknown>; availableAt?: Date };

export type OrchestrationDecision = {
  fromStatus: TaskWorkflowStatus;
  toStatus: TaskWorkflowStatus;
  kernelIntent:
    | "start"
    | "auto_start"
    | "submit_review"
    | "repository_validated"
    | "request_changes"
    | "repository_validation_failed"
    | "worktree_revalidation_failed"
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
  decisionActorId: string;
  executorActorId?: string | null;
  rank?: "front" | "back";
  taskData?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// §5.5 / §18 — Orchestrator result.
// Extended with domain error code for stable cross-transport error reporting.
// ---------------------------------------------------------------------------

export type OrchestratorResult =
  | {
      status: "replayed";
      transitionId: string | null;
      workflowVersion: number;
      procedureId?: string | null;
      cycleId?: string | null;
      actionEffect?: string;
      episode?: AgentExecutionEpisodeProjection | null;
      taskState?: string | null;
      checkpoint?: string;
      nextAction?: string;
      disposition?: string;
      turnComplete?: boolean;
      successorScheduled?: boolean;
    }
  | {
      status: "accepted";
      transitionId: string | null;
      workflowVersion: number;
      procedureId?: string | null;
      cycleId?: string | null;
      actionEffect?: string;
      episode?: AgentExecutionEpisodeProjection | null;
      taskState?: string | null;
      checkpoint?: string;
      nextAction?: string;
      disposition?: string;
      turnComplete?: boolean;
      successorScheduled?: boolean;
    }
  | { status: "stale"; reason: string; domainCode?: DomainErrorCode }
  | { status: "forbidden"; reason: string; domainCode?: DomainErrorCode }
  | { status: "invalid"; reason: string; details?: Record<string, unknown>; domainCode?: DomainErrorCode }
  | { status: "operational"; reason: string; domainCode?: DomainErrorCode };

export type AgentExecutionEpisodeProjection = {
  episodeNo: number;
  cycleCount: number;
  cycleBudget: number;
  cyclesRemaining: number;
  toolCycleCount: number;
  toolCycleBudget: number;
  toolCyclesRemaining: number;
  rolledOver: boolean;
  nextEpisodeNo: number | null;
};

// ---------------------------------------------------------------------------
// State snapshot passed to the decision function (unchanged).
// ---------------------------------------------------------------------------

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
  resolvedReviewOwnerId: string | null;
  activeReviewRun?: {
    id: string;
    status: string;
    candidateSha: string;
    reviewerId: string | null;
    baseSha: string | null;
    repoTouched: boolean;
    validationOutcome: string;
  } | null;
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
  // --- Extended fields for §10 guards (PHASEE-03) ---
  // These are populated by loadTaskAggregate and are optional on
  // TaskStateSnapshot so existing callers that construct snapshots
  // manually still compile. Guards that need them check for undefined.
  unresolvedPrerequisites?: Array<{ id: string; title: string; status: string }>;
  otherInProgressTaskForAssignee?: { id: string; title: string } | null;
  otherInProgressTaskOnBranch?: { id: string; title: string; branchName: string | null } | null;
  openChecklist?: { count: number; ids: string[] };
  activeBlocker?: {
    commentId: string | null;
    permissionRequest: { kind: string; scope: string } | null;
    permissionGrant?: {
      authorizationCommentId: string | null;
      grantedAt: Date | null;
    } | null;
    override?: {
      kind: "wait_for_human";
      targetStatus: string | null;
      reason: string | null;
    } | null;
  } | null;
  actionPlan?: {
    id: string;
    version: number;
    status: string;
    approvedOn: Date | null;
    steps: Array<{ id: string; stepId: string; title: string; kind: string; assigneeId: string | null; rank: number }>;
  } | null;
};
