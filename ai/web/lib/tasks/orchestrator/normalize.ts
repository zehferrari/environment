// PHASEE-02a — Canonical public-action normalizer.
//
// Exports normalizePublicAction(action, rawBody, authContext) which maps
// transport-level public actions to typed TaskWorkflowCommand union members.
//
// This is a PURE FUNCTION — no DB access, no side effects, no async.
// Aliases (ready_for_review/submit_review both → submit_for_review) are
// resolved HERE only. Evidence fields are extracted from authContext
// (server-resolved), NOT from rawBody (client JSON).
//
// CRITICAL: This is ONE exported normalizer with NO transport-specific
// variants. Wiring transports to import it is PHASEE-08/09 scope.

import type {
  AgentExecutionContext,
  DomainErrorCode,
  TaskWorkflowCommand,
  TaskWorkflowCommandBase,
  TaskWorkflowIntent,
  WorkflowCommandSource,
  WorkflowPublicAction,
  WorkflowActor,
  WorkflowSubtaskKind,
  // Payload types — imported so buildPayload returns typed payloads,
  // making the discriminated union enforceable at compile time.
  SubmitPlanPayload,
  ApprovePlanPayload,
  RequestPlanChangesPayload,
  StartImplementationPayload,
  CheckpointPayload,
  SubmitForReviewPayload,
  RequestReviewChangesPayload,
  AcceptReviewPayload,
  RaiseBlockerPayload,
  ClearBlockerPayload,
  CancelTaskPayload,
  ArchiveTaskPayload,
  TriageTaskPayload,
  AssignTaskPayload,
  RaiseScopeBlockerPayload,
  OverrideStatusPayload,
  RepositoryValidationSucceededPayload,
  RepositoryValidationFailedPayload,
  RepositoryFinalizationSucceededPayload,
  RepositoryFinalizationFailedPayload,
  PublishCheckpointPayload,
  AddSubtaskPayload,
  CompleteSubtaskPayload,
  RemoveSubtaskPayload,
  RequestSubtaskPayload,
  RequestTaskPayload,
} from "@/lib/tasks/orchestrator/types";
import {
  WORKFLOW_PUBLIC_ACTIONS,
} from "@/lib/tasks/orchestrator/types";

// ---------------------------------------------------------------------------
// Auth context — server-resolved fields passed by the transport.
// ---------------------------------------------------------------------------

export type NormalizerAuthContext = {
  taskId: string;
  actorId: string;
  actorKind: "human" | "agent";
  actorUsername: string | null;
  /** Server-resolved actor role (never from client JSON). */
  actorRole?: WorkflowActor["role"];
  actorCodingCapability?: boolean;
  expectedWorkflowVersion: number;
  workflowCycleId: string | null;
  idempotencyKey: string;
  messageId: string | null;
  /** Transport source. */
  source: WorkflowCommandSource;
  // Server-resolved evidence (never from client JSON)
  candidateSha?: string | null;
  baseSha?: string | null;
  worktreePath?: string | null;
  branchName?: string | null;
  actionPlanId?: string | null;
  actionPlanVersion?: number | null;
  reviewRunId?: string | null;
  procedureRunId?: string | null;
  procedureStepId?: string | null;
  jobId?: string | null;
  blockerId?: string | null;
  subtaskKind?: WorkflowSubtaskKind | null;
  // PM-channel episode context (spec §14)
  executionContext?: AgentExecutionContext | null;
};

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type NormalizerResult =
  | { ok: true; command: TaskWorkflowCommand }
  | { ok: false; code: DomainErrorCode; message: string };

// ---------------------------------------------------------------------------
// Public action → canonical intent mapping (spec §15 table)
// ---------------------------------------------------------------------------

const ACTION_TO_INTENT: ReadonlyMap<WorkflowPublicAction, TaskWorkflowIntent> = new Map([
  ["start", "start_implementation"],
  ["checkpoint", "checkpoint"],
  ["publish_checkpoint", "publish_checkpoint"],
  ["ready_for_review", "submit_for_review"],
  ["submit_review", "submit_for_review"],
  ["review_feedback", "request_review_changes"],
  ["review_done", "accept_review"],
  ["triage_to_todo", "triage_task"],
  ["approve_plan", "approve_plan"],
  ["submit_plan", "submit_plan"],
  ["assign_task", "assign_task"],
  ["assign_after_plan_approval", "assign_task"],
  ["add_subtask", "add_subtask"],
  ["complete_subtask", "complete_subtask"],
  ["remove_subtask", "remove_subtask"],
  ["request_subtask", "request_subtask"],
  ["request_task", "request_task"],
  ["flag_blocker", "raise_blocker"],
  ["clear_blocker", "clear_blocker"],
  ["flag_extra_work_blocker", "raise_scope_blocker"],
  ["override_status", "override_status"],
]);

// ---------------------------------------------------------------------------
// Untrusted client-supplied keys that are silently STRIPPED (not rejected).
// These are server-resolved fields that may appear in legacy rawBody shapes.
// ---------------------------------------------------------------------------

const STRIPPED_CLIENT_KEYS: ReadonlySet<string> = new Set([
  "role",
  "actorRole",
  "ownerId",
  "projectId",
  "assigneeId",
  "reporterId",
  "actingManagerId",
  "workflowVersion",
  "taskId",
  "token",
  "messageId",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function getString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  return isString(v) ? v : undefined;
}

function getBoolean(raw: Record<string, unknown>, key: string): boolean | undefined {
  const v = raw[key];
  return typeof v === "boolean" ? v : undefined;
}

function getNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const v = raw[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function getStringArray(raw: Record<string, unknown>, key: string): string[] | undefined {
  const v = raw[key];
  if (!Array.isArray(v)) return undefined;
  return v.every(isString) ? v : undefined;
}

function getObject(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = raw[key];
  return isObject(v) ? v : undefined;
}

function fail(code: DomainErrorCode, message: string): NormalizerResult {
  return { ok: false, code, message };
}

/** Build the common command base fields from authContext. */
function buildBase(
  ctx: NormalizerAuthContext,
  intent: TaskWorkflowIntent,
): TaskWorkflowCommandBase {
  const actor: WorkflowActor = {
    id: ctx.actorId,
    kind: ctx.actorKind,
    ...(ctx.actorUsername !== null ? { username: ctx.actorUsername } : {}),
    ...(ctx.actorRole !== undefined ? { role: ctx.actorRole } : {}),
    ...(ctx.actorCodingCapability !== undefined
      ? { codingCapability: ctx.actorCodingCapability }
      : {}),
  };

  const base: TaskWorkflowCommandBase = {
    taskId: ctx.taskId,
    intent,
    actor,
    expectedWorkflowVersion: ctx.expectedWorkflowVersion,
    idempotencyKey: ctx.idempotencyKey,
    source: ctx.source,
  };

  if (ctx.workflowCycleId !== null) base.workflowCycleId = ctx.workflowCycleId;
  if (ctx.messageId !== null) base.messageId = ctx.messageId;
  if (ctx.executionContext) base.executionContext = ctx.executionContext;

  return base;
}

/** Strip untrusted client-supplied keys from rawBody, returning a clean copy. */
function stripUntrusted(rawBody: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(rawBody)) {
    if (!STRIPPED_CLIENT_KEYS.has(key)) {
      clean[key] = rawBody[key];
    }
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Per-action payload builders.
// Each builder extracts safe fields from rawBody and server-resolved fields
// from authContext, returning the typed payload for the canonical intent.
// ---------------------------------------------------------------------------

type BuiltPayload =
  | SubmitPlanPayload
  | ApprovePlanPayload
  | RequestPlanChangesPayload
  | StartImplementationPayload
  | CheckpointPayload
  | SubmitForReviewPayload
  | RequestReviewChangesPayload
  | AcceptReviewPayload
  | RaiseBlockerPayload
  | ClearBlockerPayload
  | CancelTaskPayload
  | ArchiveTaskPayload
  | TriageTaskPayload
  | AssignTaskPayload
  | RaiseScopeBlockerPayload
  | OverrideStatusPayload
  | RepositoryValidationSucceededPayload
  | RepositoryValidationFailedPayload
  | RepositoryFinalizationSucceededPayload
  | RepositoryFinalizationFailedPayload
  | PublishCheckpointPayload
  | AddSubtaskPayload
  | CompleteSubtaskPayload
  | RemoveSubtaskPayload
  | RequestSubtaskPayload
  | RequestTaskPayload;

function buildPayload(
  action: WorkflowPublicAction,
  intent: TaskWorkflowIntent,
  raw: Record<string, unknown>,
  ctx: NormalizerAuthContext,
): BuiltPayload | NormalizerResult {
  switch (intent) {
    // --- submit_plan ---
    case "submit_plan": {
      const actionPlan = getObject(raw, "actionPlan");
      if (!actionPlan) return fail("invalid_payload", "actionPlan is required");
      const inReplyTo = getString(raw, "inReplyToMessageId");
      const payload: SubmitPlanPayload = {
        actionPlan: actionPlan as SubmitPlanPayload["actionPlan"],
        ...(inReplyTo !== undefined ? { inReplyToMessageId: inReplyTo } : {}),
      };
      return payload;
    }

    // --- approve_plan ---
    case "approve_plan": {
      const actionPlanId = ctx.actionPlanId;
      if (!actionPlanId) return fail("invalid_payload", "actionPlanId is required");
      const actionPlanVersion = ctx.actionPlanVersion ?? undefined;
      if (actionPlanVersion === undefined) return fail("invalid_payload", "actionPlanVersion is required");
      const constraints = getString(raw, "constraints") ?? getString(raw, "comment");
      const payload: ApprovePlanPayload = {
        actionPlanId,
        actionPlanVersion,
        ...(constraints !== undefined ? { constraints } : {}),
      };
      return payload;
    }

    // --- request_plan_changes ---
    case "request_plan_changes": {
      const actionPlanId = ctx.actionPlanId;
      if (!actionPlanId) return fail("invalid_payload", "actionPlanId is required");
      const actionPlanVersion = ctx.actionPlanVersion ?? undefined;
      if (actionPlanVersion === undefined) return fail("invalid_payload", "actionPlanVersion is required");
      const reviewerComment = getString(raw, "reviewerComment") ?? getString(raw, "comment");
      if (!reviewerComment) return fail("invalid_payload", "reviewerComment is required");
      const payload: RequestPlanChangesPayload = { actionPlanId, actionPlanVersion, reviewerComment };
      return payload;
    }

    // --- start_implementation ---
    case "start_implementation": {
      const worktreePath = ctx.worktreePath ?? undefined;
      const branchName = ctx.branchName ?? undefined;
      const payload: StartImplementationPayload = {
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(branchName !== undefined ? { branchName } : {}),
      };
      return payload;
    }

    // --- checkpoint ---
    case "checkpoint": {
      const completedWork = getStringArray(raw, "completedWork");
      const evidence = getStringArray(raw, "evidence");
      const openChecklist = getStringArray(raw, "openChecklist");
      const nextAction = getString(raw, "nextAction");
      const risks = getStringArray(raw, "risks");
      const payload: CheckpointPayload = {
        ...(completedWork !== undefined ? { completedWork } : {}),
        ...(evidence !== undefined ? { evidence } : {}),
        ...(openChecklist !== undefined ? { openChecklist } : {}),
        ...(nextAction !== undefined ? { nextAction } : {}),
        ...(risks !== undefined ? { risks } : {}),
      };
      return payload;
    }

    // --- submit_for_review ---
    case "submit_for_review": {
      const candidateSha = ctx.candidateSha ?? null;
      const baseSha = ctx.baseSha ?? null;
      const repoTouched = getBoolean(raw, "repoTouched") ?? false;
      const worktreePath = ctx.worktreePath ?? undefined;
      const branchName = ctx.branchName ?? undefined;
      const comment = getString(raw, "comment");
      const payload: SubmitForReviewPayload = {
        candidateSha,
        baseSha,
        repoTouched,
        ...(worktreePath !== undefined ? { worktreePath } : {}),
        ...(branchName !== undefined ? { branchName } : {}),
        ...(comment !== undefined ? { comment } : {}),
      };
      return payload;
    }

    // --- request_review_changes ---
    case "request_review_changes": {
      const reviewRunId = ctx.reviewRunId;
      if (!reviewRunId) return fail("invalid_payload", "reviewRunId is required");
      const candidateSha = ctx.candidateSha;
      if (!candidateSha) return fail("invalid_payload", "candidateSha is required");
      const reviewerComment = getString(raw, "reviewerComment") ?? getString(raw, "comment");
      if (!reviewerComment) return fail("invalid_payload", "reviewerComment is required");
      const payload: RequestReviewChangesPayload = { reviewRunId, candidateSha, reviewerComment };
      return payload;
    }

    // --- accept_review ---
    case "accept_review": {
      const reviewRunId = ctx.reviewRunId;
      if (!reviewRunId) return fail("invalid_payload", "reviewRunId is required");
      const candidateSha = ctx.candidateSha;
      if (!candidateSha) return fail("invalid_payload", "candidateSha is required");
      const payload: AcceptReviewPayload = { reviewRunId, candidateSha };
      return payload;
    }

    // --- raise_blocker ---
    case "raise_blocker": {
      const comment = getString(raw, "comment");
      const permissionKind = getString(raw, "permissionKind") as RaiseBlockerPayload["permissionKind"] | undefined;
      const permissionScope = getString(raw, "permissionScope");
      const suppliedReport = getObject(raw, "blockerReport");
      const blockerReport = suppliedReport ?? (permissionKind
        ? {
            blockedOn: "permission",
            requestedActor: "the task reporter",
            requestedAction: permissionScope ?? comment ?? "Grant the requested permission.",
            evidence: comment ?? permissionScope ?? "Permission is required by policy.",
            diagnosticsAttempted: [
              "No agent-side retry can grant this permission; the scope is owner-authorized by design.",
            ],
            resumeCondition: `The task reporter grants "${permissionScope ?? comment ?? "the requested permission"}" on the blocker comment.`,
            reporterCanResolve: true,
          }
        : null);
      if (!blockerReport) return fail("invalid_payload", "blockerReport is required");
      const payload: RaiseBlockerPayload = {
        blockerReport: blockerReport as RaiseBlockerPayload["blockerReport"],
        ...(comment !== undefined ? { comment } : {}),
        ...(permissionKind !== undefined ? { permissionKind } : {}),
        ...(permissionScope !== undefined ? { permissionScope } : {}),
      };
      return payload;
    }

    // --- clear_blocker ---
    case "clear_blocker": {
      const blockerId = ctx.blockerId;
      if (!blockerId) return fail("invalid_payload", "blockerId is required");
      const resolution = getString(raw, "resolution") ?? getString(raw, "comment");
      if (!resolution) return fail("invalid_payload", "resolution is required");
      const payload: ClearBlockerPayload = { blockerId, resolution };
      return payload;
    }

    // --- cancel_task ---
    case "cancel_task": {
      const reason = getString(raw, "reason");
      const payload: CancelTaskPayload = { reason: reason ?? null };
      return payload;
    }

    // --- archive_task ---
    case "archive_task": {
      const payload: ArchiveTaskPayload = {};
      return payload;
    }

    // --- triage_task ---
    case "triage_task": {
      const targetStatus = getString(raw, "targetStatus") ?? "To Do";
      if (targetStatus !== "To Do" && targetStatus !== "Backlog") {
        return fail("invalid_payload", "targetStatus must be 'To Do' or 'Backlog'");
      }
      const reason = getString(raw, "reason");
      const payload: TriageTaskPayload = {
        targetStatus,
        ...(reason !== undefined ? { reason } : {}),
      };
      return payload;
    }

    // --- assign_task ---
    case "assign_task": {
      const assigneeUsername = getString(raw, "assigneeUsername") ?? getString(raw, "assignee") ?? null;
      // assign_after_plan_approval sets afterPlanApproval=true
      const afterPlanApproval = action === "assign_after_plan_approval" ? true : (getBoolean(raw, "afterPlanApproval") ?? false);
      const payload: AssignTaskPayload = { assigneeUsername, afterPlanApproval };
      return payload;
    }

    // --- raise_scope_blocker ---
    case "raise_scope_blocker": {
      const scopeDescription = getString(raw, "scopeDescription") ?? getString(raw, "comment");
      if (!scopeDescription) return fail("invalid_payload", "scopeDescription is required");
      const evidence = getStringArray(raw, "evidence");
      const requestedActor = getString(raw, "requestedActor");
      const payload: RaiseScopeBlockerPayload = {
        scopeDescription,
        ...(evidence !== undefined ? { evidence } : {}),
        ...(requestedActor !== undefined ? { requestedActor } : {}),
      };
      return payload;
    }

    // --- override_status ---
    case "override_status": {
      const targetStatus = getString(raw, "targetStatus");
      if (
        targetStatus !== "Backlog" &&
        targetStatus !== "To Do" &&
        targetStatus !== "In Progress" &&
        targetStatus !== "Review" &&
        targetStatus !== "Done"
      ) {
        return fail("invalid_payload", "targetStatus must be a workflow status");
      }
      const reason = getString(raw, "reason");
      const payload: OverrideStatusPayload = {
        targetStatus,
        ...(reason !== undefined ? { reason } : {}),
      };
      return payload;
    }

    // --- Mechanical intents (repository callbacks) ---
    case "repository_validation_succeeded": {
      const procedureRunId = ctx.procedureRunId ?? getString(raw, "procedureRunId");
      const procedureStepId = ctx.procedureStepId ?? getString(raw, "procedureStepId");
      const jobId = ctx.jobId ?? getString(raw, "jobId") ?? null;
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha") ?? null;
      const baseSha = ctx.baseSha ?? getString(raw, "baseSha") ?? null;
      if (!procedureRunId) return fail("invalid_payload", "procedureRunId is required");
      if (!procedureStepId) return fail("invalid_payload", "procedureStepId is required");
      const payload: RepositoryValidationSucceededPayload = {
        procedureRunId, procedureStepId,
        jobId: jobId === "" ? null : jobId,
        candidateSha: candidateSha === "" ? null : candidateSha,
        baseSha: baseSha === "" ? null : baseSha,
        outcome: "succeeded",
      };
      return payload;
    }

    case "repository_validation_failed": {
      const procedureRunId = ctx.procedureRunId ?? getString(raw, "procedureRunId");
      const procedureStepId = ctx.procedureStepId ?? getString(raw, "procedureStepId");
      const jobId = ctx.jobId ?? getString(raw, "jobId") ?? null;
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha") ?? null;
      const baseSha = ctx.baseSha ?? getString(raw, "baseSha") ?? null;
      if (!procedureRunId) return fail("invalid_payload", "procedureRunId is required");
      if (!procedureStepId) return fail("invalid_payload", "procedureStepId is required");
      const failureReason = getString(raw, "failureReason") ?? getString(raw, "reason") ?? null;
      const payload: RepositoryValidationFailedPayload = {
        procedureRunId, procedureStepId,
        jobId: jobId === "" ? null : jobId,
        candidateSha: candidateSha === "" ? null : candidateSha,
        baseSha: baseSha === "" ? null : baseSha,
        outcome: "failed",
        ...(failureReason !== null ? { failureReason } : {}),
      };
      return payload;
    }

    case "repository_finalization_succeeded": {
      const procedureRunId = ctx.procedureRunId ?? getString(raw, "procedureRunId");
      const procedureStepId = ctx.procedureStepId ?? getString(raw, "procedureStepId");
      const jobId = ctx.jobId ?? getString(raw, "jobId") ?? null;
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha") ?? null;
      const baseSha = ctx.baseSha ?? getString(raw, "baseSha") ?? null;
      if (!procedureRunId) return fail("invalid_payload", "procedureRunId is required");
      if (!procedureStepId) return fail("invalid_payload", "procedureStepId is required");
      const publishedSha = getString(raw, "publishedSha") ?? null;
      const payload: RepositoryFinalizationSucceededPayload = {
        procedureRunId, procedureStepId,
        jobId: jobId === "" ? null : jobId,
        candidateSha: candidateSha === "" ? null : candidateSha,
        baseSha: baseSha === "" ? null : baseSha,
        outcome: "succeeded",
        ...(publishedSha !== null ? { publishedSha } : {}),
      };
      return payload;
    }

    case "repository_finalization_failed": {
      const procedureRunId = ctx.procedureRunId ?? getString(raw, "procedureRunId");
      const procedureStepId = ctx.procedureStepId ?? getString(raw, "procedureStepId");
      const jobId = ctx.jobId ?? getString(raw, "jobId") ?? null;
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha") ?? null;
      const baseSha = ctx.baseSha ?? getString(raw, "baseSha") ?? null;
      if (!procedureRunId) return fail("invalid_payload", "procedureRunId is required");
      if (!procedureStepId) return fail("invalid_payload", "procedureStepId is required");
      const failureReason = getString(raw, "failureReason") ?? getString(raw, "reason") ?? null;
      const payload: RepositoryFinalizationFailedPayload = {
        procedureRunId, procedureStepId,
        jobId: jobId === "" ? null : jobId,
        candidateSha: candidateSha === "" ? null : candidateSha,
        baseSha: baseSha === "" ? null : baseSha,
        outcome: "failed",
        ...(failureReason !== null ? { failureReason } : {}),
      };
      return payload;
    }

    // --- publish_checkpoint ---
    case "publish_checkpoint": {
      const authorizationCommentId = getString(raw, "authorizationCommentId");
      if (!authorizationCommentId) return fail("invalid_payload", "authorizationCommentId is required");
      const candidateSha = ctx.candidateSha ?? undefined;
      const baseSha = ctx.baseSha ?? undefined;
      const comment = getString(raw, "comment");
      const payload: PublishCheckpointPayload = {
        authorizationCommentId,
        ...(candidateSha !== undefined ? { candidateSha } : {}),
        ...(baseSha !== undefined ? { baseSha } : {}),
        ...(comment !== undefined ? { comment } : {}),
      };
      return payload;
    }

    // --- add_subtask ---
    case "add_subtask": {
      const subtaskText = getString(raw, "subtaskText");
      if (!subtaskText) return fail("invalid_payload", "subtaskText is required");
      const rawKind = ctx.subtaskKind ?? getString(raw, "subtaskKind") ?? "implementation";
      if (rawKind !== "implementation" && rawKind !== "review") {
        return fail("invalid_payload", "subtaskKind must be implementation or review");
      }
      const payload: AddSubtaskPayload = { subtaskText, subtaskKind: rawKind };
      return payload;
    }

    // --- complete_subtask ---
    case "complete_subtask": {
      const subtaskId = getString(raw, "subtaskId");
      if (!subtaskId) return fail("invalid_payload", "subtaskId is required");
      const subtaskKind = ctx.subtaskKind;
      if (!subtaskKind) return fail("invalid_payload", "subtaskId must identify a sub-task on this task");
      const completed = getBoolean(raw, "completed") ?? true;
      const minutesSpent = getNumber(raw, "minutesSpent");
      const payload: CompleteSubtaskPayload = {
        subtaskId, subtaskKind, completed,
        ...(minutesSpent !== undefined ? { minutesSpent } : {}),
      };
      return payload;
    }

    // --- remove_subtask ---
    case "remove_subtask": {
      const subtaskId = getString(raw, "subtaskId");
      if (!subtaskId) return fail("invalid_payload", "subtaskId is required");
      const subtaskKind = ctx.subtaskKind;
      if (!subtaskKind) return fail("invalid_payload", "subtaskId must identify a sub-task on this task");
      const payload: RemoveSubtaskPayload = { subtaskId, subtaskKind };
      return payload;
    }

    // --- request_subtask ---
    case "request_subtask": {
      const subtaskText = getString(raw, "subtaskText");
      if (!subtaskText) return fail("invalid_payload", "subtaskText is required");
      const reason = getString(raw, "reason") ?? getString(raw, "comment");
      if (!reason) return fail("invalid_payload", "comment is required");
      const payload: RequestSubtaskPayload = { subtaskText, reason };
      return payload;
    }

    // --- request_task ---
    case "request_task": {
      const taskTitle = getString(raw, "taskTitle") ?? getString(raw, "title") ?? getString(raw, "subtaskText");
      if (!taskTitle) return fail("invalid_payload", "taskTitle is required");
      const taskDescription = getString(raw, "taskDescription") ?? getString(raw, "description");
      const epicId = getString(raw, "epicId");
      const reason = getString(raw, "reason") ?? getString(raw, "comment");
      if (!reason) return fail("invalid_payload", "comment is required");
      const payload: RequestTaskPayload = {
        taskTitle,
        ...(taskDescription !== undefined ? { taskDescription } : {}),
        ...(epicId !== undefined ? { epicId } : {}),
        reason,
      };
      return payload;
    }

    default:
      return fail("unknown_intent", `normalizePublicAction: unsupported intent ${intent}`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Normalize a transport-level public action into a typed TaskWorkflowCommand.
 *
 * Pure function — no DB access, no side effects, synchronous.
 *
 * - Aliases (ready_for_review/submit_review both → submit_for_review) are
 *   resolved HERE only.
 * - Evidence fields (candidateSha, baseSha, reviewRunId, etc.) are extracted
 *   from authContext (server-resolved), NOT from rawBody (client JSON).
 * - Untrusted client-supplied server-resolved fields (role, ownerId, etc.)
 *   are silently STRIPPED from rawBody, not rejected.
 * - Idempotency key construction is canonical and stable across replays.
 *
 * @param action - The public action string from the transport.
 * @param rawBody - The raw request body from the transport (client JSON).
 * @param authContext - Server-resolved authentication and evidence context.
 * @returns `{ ok: true, command }` or `{ ok: false, code, message }`.
 */
export function normalizePublicAction(
  action: WorkflowPublicAction,
  rawBody: Record<string, unknown>,
  authContext: NormalizerAuthContext,
): NormalizerResult {
  // Validate the action is known.
  if (!WORKFLOW_PUBLIC_ACTIONS.includes(action)) {
    return fail("unknown_intent", `Unknown public action: ${action}`);
  }

  // Map to canonical intent.
  const intent = ACTION_TO_INTENT.get(action);
  if (!intent) {
    return fail("unknown_intent", `No canonical intent mapping for action: ${action}`);
  }

  // Strip untrusted client-supplied keys from rawBody.
  const cleanRaw = stripUntrusted(rawBody);

  // Build the typed payload for this intent.
  const payloadResult = buildPayload(action, intent, cleanRaw, authContext);
  if ("ok" in payloadResult && !payloadResult.ok) {
    return payloadResult as NormalizerResult;
  }

  // buildPayload returns a BuiltPayload (typed per intent) or a NormalizerResult.
  // After the guard above, payloadResult is a BuiltPayload. Each case in
  // buildPayload annotates its local with the concrete payload type, so
  // typos and wrong shapes fail at the construction site, not at runtime.
  const payload = payloadResult;

  // Build the common command base.
  const base = buildBase(authContext, intent);

  // Construct the typed command. The `as` cast is benign: buildPayload
  // returns the concrete typed payload for this intent, and the discriminated
  // union on `intent` guarantees the payload matches the variant. TypeScript
  // cannot prove spread-narrowing, but each case's payload is compile-time
  // checked against its variant's payload type.
  const command = { ...base, payload } as TaskWorkflowCommand;

  return { ok: true, command };
}

// ---------------------------------------------------------------------------
// Re-export the action → intent mapping for testing and transport use.
// ---------------------------------------------------------------------------

export const PUBLIC_ACTION_TO_INTENT = ACTION_TO_INTENT;
