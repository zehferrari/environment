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
  TaskWorkflowIntent,
  WorkflowCommandSource,
  WorkflowPublicAction,
  WorkflowActor,
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
): Record<string, unknown> {
  const actor: WorkflowActor = {
    id: ctx.actorId,
    kind: ctx.actorKind,
    ...(ctx.actorUsername !== null ? { username: ctx.actorUsername } : {}),
    ...(ctx.actorRole !== undefined ? { role: ctx.actorRole } : {}),
  };

  const base: Record<string, unknown> = {
    taskId: ctx.taskId,
    intent,
    actor,
    expectedWorkflowVersion: ctx.expectedWorkflowVersion,
    idempotencyKey: ctx.idempotencyKey,
    source: ctx.source,
  };

  if (ctx.workflowCycleId !== null) base["workflowCycleId"] = ctx.workflowCycleId;
  if (ctx.messageId !== null) base["messageId"] = ctx.messageId;
  if (ctx.executionContext) base["executionContext"] = ctx.executionContext;

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

function buildPayload(
  action: WorkflowPublicAction,
  intent: TaskWorkflowIntent,
  raw: Record<string, unknown>,
  ctx: NormalizerAuthContext,
): Record<string, unknown> | NormalizerResult {
  switch (intent) {
    // --- submit_plan ---
    case "submit_plan": {
      const actionPlan = getObject(raw, "actionPlan");
      if (!actionPlan) return fail("invalid_payload", "actionPlan is required");
      const inReplyTo = getString(raw, "inReplyToMessageId");
      const payload: Record<string, unknown> = { actionPlan };
      if (inReplyTo !== undefined) payload["inReplyToMessageId"] = inReplyTo;
      return payload;
    }

    // --- approve_plan ---
    case "approve_plan": {
      const actionPlanId = ctx.actionPlanId ?? getString(raw, "actionPlanId");
      if (!actionPlanId) return fail("invalid_payload", "actionPlanId is required");
      const actionPlanVersion = ctx.actionPlanVersion ?? getNumber(raw, "actionPlanVersion");
      if (actionPlanVersion === undefined) return fail("invalid_payload", "actionPlanVersion is required");
      const constraints = getString(raw, "constraints");
      const payload: Record<string, unknown> = { actionPlanId, actionPlanVersion };
      if (constraints !== undefined) payload["constraints"] = constraints;
      return payload;
    }

    // --- request_plan_changes ---
    case "request_plan_changes": {
      const actionPlanId = ctx.actionPlanId ?? getString(raw, "actionPlanId");
      if (!actionPlanId) return fail("invalid_payload", "actionPlanId is required");
      const actionPlanVersion = ctx.actionPlanVersion ?? getNumber(raw, "actionPlanVersion");
      if (actionPlanVersion === undefined) return fail("invalid_payload", "actionPlanVersion is required");
      const reviewerComment = getString(raw, "reviewerComment") ?? getString(raw, "comment");
      if (!reviewerComment) return fail("invalid_payload", "reviewerComment is required");
      return { actionPlanId, actionPlanVersion, reviewerComment };
    }

    // --- start_implementation ---
    case "start_implementation": {
      const payload: Record<string, unknown> = {};
      const worktreePath = ctx.worktreePath ?? getString(raw, "worktreePath");
      const branchName = ctx.branchName ?? getString(raw, "branchName");
      if (worktreePath !== undefined) payload["worktreePath"] = worktreePath;
      if (branchName !== undefined) payload["branchName"] = branchName;
      return payload;
    }

    // --- checkpoint ---
    case "checkpoint": {
      const payload: Record<string, unknown> = {};
      const completedWork = getStringArray(raw, "completedWork");
      const evidence = getStringArray(raw, "evidence");
      const openChecklist = getStringArray(raw, "openChecklist");
      const nextAction = getString(raw, "nextAction");
      const risks = getStringArray(raw, "risks");
      if (completedWork !== undefined) payload["completedWork"] = completedWork;
      if (evidence !== undefined) payload["evidence"] = evidence;
      if (openChecklist !== undefined) payload["openChecklist"] = openChecklist;
      if (nextAction !== undefined) payload["nextAction"] = nextAction;
      if (risks !== undefined) payload["risks"] = risks;
      return payload;
    }

    // --- submit_for_review ---
    case "submit_for_review": {
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha") ?? null;
      const baseSha = ctx.baseSha ?? getString(raw, "baseSha") ?? null;
      const repoTouched = getBoolean(raw, "repoTouched") ?? false;
      const worktreePath = ctx.worktreePath ?? getString(raw, "worktreePath");
      const branchName = ctx.branchName ?? getString(raw, "branchName");
      const comment = getString(raw, "comment");
      const payload: Record<string, unknown> = { candidateSha, baseSha, repoTouched };
      if (worktreePath !== undefined) payload["worktreePath"] = worktreePath;
      if (branchName !== undefined) payload["branchName"] = branchName;
      if (comment !== undefined) payload["comment"] = comment;
      return payload;
    }

    // --- request_review_changes ---
    case "request_review_changes": {
      const reviewRunId = ctx.reviewRunId ?? getString(raw, "reviewRunId");
      if (!reviewRunId) return fail("invalid_payload", "reviewRunId is required");
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha");
      if (!candidateSha) return fail("invalid_payload", "candidateSha is required");
      const reviewerComment = getString(raw, "reviewerComment") ?? getString(raw, "comment");
      if (!reviewerComment) return fail("invalid_payload", "reviewerComment is required");
      return { reviewRunId, candidateSha, reviewerComment };
    }

    // --- accept_review ---
    case "accept_review": {
      const reviewRunId = ctx.reviewRunId ?? getString(raw, "reviewRunId");
      if (!reviewRunId) return fail("invalid_payload", "reviewRunId is required");
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha");
      if (!candidateSha) return fail("invalid_payload", "candidateSha is required");
      return { reviewRunId, candidateSha };
    }

    // --- raise_blocker ---
    case "raise_blocker": {
      const blockerReport = getObject(raw, "blockerReport");
      if (!blockerReport) return fail("invalid_payload", "blockerReport is required");
      const comment = getString(raw, "comment");
      const permissionKind = getString(raw, "permissionKind");
      const permissionScope = getString(raw, "permissionScope");
      const payload: Record<string, unknown> = { blockerReport };
      if (comment !== undefined) payload["comment"] = comment;
      if (permissionKind !== undefined) payload["permissionKind"] = permissionKind;
      if (permissionScope !== undefined) payload["permissionScope"] = permissionScope;
      return payload;
    }

    // --- clear_blocker ---
    case "clear_blocker": {
      const blockerId = getString(raw, "blockerId");
      if (!blockerId) return fail("invalid_payload", "blockerId is required");
      const resolution = getString(raw, "resolution") ?? getString(raw, "comment");
      if (!resolution) return fail("invalid_payload", "resolution is required");
      return { blockerId, resolution };
    }

    // --- cancel_task ---
    case "cancel_task": {
      const reason = getString(raw, "reason");
      return { reason: reason ?? null };
    }

    // --- archive_task ---
    case "archive_task": {
      return {};
    }

    // --- triage_task ---
    case "triage_task": {
      const targetStatus = getString(raw, "targetStatus") ?? "To Do";
      if (targetStatus !== "To Do" && targetStatus !== "Backlog") {
        return fail("invalid_payload", "targetStatus must be 'To Do' or 'Backlog'");
      }
      const reason = getString(raw, "reason");
      const payload: Record<string, unknown> = { targetStatus };
      if (reason !== undefined) payload["reason"] = reason;
      return payload;
    }

    // --- assign_task ---
    case "assign_task": {
      const assigneeUsername = getString(raw, "assigneeUsername") ?? getString(raw, "assignee");
      if (!assigneeUsername) return fail("invalid_payload", "assigneeUsername is required");
      // assign_after_plan_approval sets afterPlanApproval=true
      const afterPlanApproval = action === "assign_after_plan_approval" ? true : (getBoolean(raw, "afterPlanApproval") ?? false);
      return { assigneeUsername, afterPlanApproval };
    }

    // --- raise_scope_blocker ---
    case "raise_scope_blocker": {
      const scopeDescription = getString(raw, "scopeDescription") ?? getString(raw, "comment");
      if (!scopeDescription) return fail("invalid_payload", "scopeDescription is required");
      const evidence = getStringArray(raw, "evidence");
      const requestedActor = getString(raw, "requestedActor");
      const payload: Record<string, unknown> = { scopeDescription };
      if (evidence !== undefined) payload["evidence"] = evidence;
      if (requestedActor !== undefined) payload["requestedActor"] = requestedActor;
      return payload;
    }

    // --- Mechanical intents (repository callbacks) ---
    case "repository_validation_succeeded":
    case "repository_validation_failed":
    case "repository_finalization_succeeded":
    case "repository_finalization_failed": {
      const procedureRunId = ctx.procedureRunId ?? getString(raw, "procedureRunId");
      const procedureStepId = ctx.procedureStepId ?? getString(raw, "procedureStepId");
      const jobId = ctx.jobId ?? getString(raw, "jobId");
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha");
      const baseSha = ctx.baseSha ?? getString(raw, "baseSha");
      if (!procedureRunId) return fail("invalid_payload", "procedureRunId is required");
      if (!procedureStepId) return fail("invalid_payload", "procedureStepId is required");
      if (!jobId) return fail("invalid_payload", "jobId is required");
      if (!candidateSha) return fail("invalid_payload", "candidateSha is required");
      if (!baseSha) return fail("invalid_payload", "baseSha is required");

      const succeeded = intent === "repository_validation_succeeded" || intent === "repository_finalization_succeeded";
      const payload: Record<string, unknown> = {
        procedureRunId, procedureStepId, jobId, candidateSha, baseSha,
        outcome: succeeded ? "succeeded" : "failed",
      };

      if (intent === "repository_finalization_succeeded") {
        const publishedSha = getString(raw, "publishedSha") ?? null;
        payload["publishedSha"] = publishedSha;
      }
      if (!succeeded) {
        const failureReason = getString(raw, "failureReason") ?? getString(raw, "reason") ?? null;
        payload["failureReason"] = failureReason;
      }
      return payload;
    }

    // --- publish_checkpoint ---
    case "publish_checkpoint": {
      const authorizationCommentId = getString(raw, "authorizationCommentId");
      if (!authorizationCommentId) return fail("invalid_payload", "authorizationCommentId is required");
      const candidateSha = ctx.candidateSha ?? getString(raw, "candidateSha");
      if (!candidateSha) return fail("invalid_payload", "candidateSha is required");
      const baseSha = ctx.baseSha ?? getString(raw, "baseSha");
      if (!baseSha) return fail("invalid_payload", "baseSha is required");
      return { authorizationCommentId, candidateSha, baseSha };
    }

    // --- add_subtask ---
    case "add_subtask": {
      const subtaskText = getString(raw, "subtaskText");
      if (!subtaskText) return fail("invalid_payload", "subtaskText is required");
      return { subtaskText };
    }

    // --- complete_subtask ---
    case "complete_subtask": {
      const subtaskId = getString(raw, "subtaskId");
      if (!subtaskId) return fail("invalid_payload", "subtaskId is required");
      const completed = getBoolean(raw, "completed") ?? true;
      const minutesSpent = getNumber(raw, "minutesSpent");
      const payload: Record<string, unknown> = { subtaskId, completed };
      if (minutesSpent !== undefined) payload["minutesSpent"] = minutesSpent;
      return payload;
    }

    // --- remove_subtask ---
    case "remove_subtask": {
      const subtaskId = getString(raw, "subtaskId");
      if (!subtaskId) return fail("invalid_payload", "subtaskId is required");
      return { subtaskId };
    }

    // --- request_subtask ---
    case "request_subtask": {
      const subtaskText = getString(raw, "subtaskText");
      if (!subtaskText) return fail("invalid_payload", "subtaskText is required");
      return { subtaskText };
    }

    // --- request_task ---
    case "request_task": {
      const taskTitle = getString(raw, "taskTitle") ?? getString(raw, "title");
      if (!taskTitle) return fail("invalid_payload", "taskTitle is required");
      const taskDescription = getString(raw, "taskDescription") ?? getString(raw, "description");
      const epicId = getString(raw, "epicId");
      const payload: Record<string, unknown> = { taskTitle };
      if (taskDescription !== undefined) payload["taskDescription"] = taskDescription;
      if (epicId !== undefined) payload["epicId"] = epicId;
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

  const payload = payloadResult as Record<string, unknown>;

  // Build the common command base.
  const base = buildBase(authContext, intent);
  base["payload"] = payload;

  return { ok: true, command: base as unknown as TaskWorkflowCommand };
}

// ---------------------------------------------------------------------------
// Re-export the action → intent mapping for testing and transport use.
// ---------------------------------------------------------------------------

export const PUBLIC_ACTION_TO_INTENT = ACTION_TO_INTENT;