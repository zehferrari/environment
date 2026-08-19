// PHASEE-02a — Per-intent payload validation schemas.
//
// Exports validateCommandPayload(intent, rawPayload) which validates the
// payload field of a TaskWorkflowCommand variant against its typed schema.
// Pure functions only — no DB access, no side effects, no async.
//
// Malformed payloads return a stable DomainErrorCode, never a raw exception.
// Untrusted client-provided fields (actor role, owner IDs, project IDs) are
// explicitly rejected — only server-resolved values are accepted.

import type {
  TaskWorkflowIntent,
  DomainErrorCode,
} from "@/lib/tasks/orchestrator/types";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type PayloadValidationResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: DomainErrorCode; message: string; details?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Runtime type helpers
// ---------------------------------------------------------------------------

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || isString(v);
}

function isStringArray(v: unknown): v is string[] {
  return isArray(v) && v.every(isString);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TEXT = 10_000;
const MAX_ID = 100;
const MAX_SUMMARY = 500;
const MAX_SUBTASK = 500;
const MAX_TASK_TITLE = 500;
const MAX_SCOPE = 5_000;
const MAX_REASON = 1_000;
const MAX_ACTION = 500;
const MAX_RESUME = 1_000;
const MAX_PERMISSION_SCOPE = 500;

/** Client-supplied keys that are server-resolved only. If present in
 * rawPayload, validation rejects them with invalid_payload. */
const REJECTED_CLIENT_KEYS: ReadonlySet<string> = new Set([
  "role",
  "actorRole",
  "ownerId",
  "projectId",
  "assigneeId",
  "reporterId",
  "actingManagerId",
  "workflowVersion",
]);

// ---------------------------------------------------------------------------
// Common validation helpers
// ---------------------------------------------------------------------------

function checkRejectedKeys(raw: Record<string, unknown>): string | null {
  for (const key of REJECTED_CLIENT_KEYS) {
    if (key in raw) {
      return key;
    }
  }
  return null;
}

function requireString(raw: Record<string, unknown>, field: string, maxLen: number = MAX_TEXT): { ok: true; value: string } | { ok: false; message: string } {
  const v = raw[field];
  if (!isString(v)) return { ok: false, message: `${field} must be a string` };
  if (v.length > maxLen) return { ok: false, message: `${field} exceeds max length ${maxLen}` };
  return { ok: true, value: v };
}

function requireStringOrNull(raw: Record<string, unknown>, field: string, maxLen: number = MAX_TEXT): { ok: true; value: string | null } | { ok: false; message: string } {
  const v = raw[field];
  if (v === undefined) return { ok: true, value: null };
  if (!isStringOrNull(v)) return { ok: false, message: `${field} must be a string or null` };
  if (isString(v) && v.length > maxLen) return { ok: false, message: `${field} exceeds max length ${maxLen}` };
  return { ok: true, value: v };
}

function requireBoolean(raw: Record<string, unknown>, field: string): { ok: true; value: boolean } | { ok: false; message: string } {
  const v = raw[field];
  if (!isBoolean(v)) return { ok: false, message: `${field} must be a boolean` };
  return { ok: true, value: v };
}

function requireNumber(raw: Record<string, unknown>, field: string): { ok: true; value: number } | { ok: false; message: string } {
  const v = raw[field];
  if (!isNumber(v)) return { ok: false, message: `${field} must be a number` };
  return { ok: true, value: v };
}

function requirePositiveNumber(raw: Record<string, unknown>, field: string): { ok: true; value: number } | { ok: false; message: string } {
  const r = requireNumber(raw, field);
  if (!r.ok) return r;
  if (r.value <= 0) return { ok: false, message: `${field} must be a positive number` };
  return r;
}

function requireStringArray(raw: Record<string, unknown>, field: string): { ok: true; value: string[] } | { ok: false; message: string } {
  const v = raw[field];
  if (v === undefined) return { ok: true, value: [] };
  if (!isStringArray(v)) return { ok: false, message: `${field} must be an array of strings` };
  return { ok: true, value: v };
}

function optionalString(raw: Record<string, unknown>, field: string, maxLen: number = MAX_TEXT): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const v = raw[field];
  if (v === undefined) return { ok: true, value: undefined };
  if (!isString(v)) return { ok: false, message: `${field} must be a string` };
  if (v.length > maxLen) return { ok: false, message: `${field} exceeds max length ${maxLen}` };
  return { ok: true, value: v };
}

function optionalNumberOrNull(raw: Record<string, unknown>, field: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const v = raw[field];
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!isNumber(v)) return { ok: false, message: `${field} must be a number or null` };
  return { ok: true, value: v };
}

function fail(code: DomainErrorCode, message: string, details?: Record<string, unknown>): PayloadValidationResult {
  return { ok: false, code, message, details };
}

function ok(payload: Record<string, unknown>): PayloadValidationResult {
  return { ok: true, payload };
}

// ---------------------------------------------------------------------------
// Per-intent validators
// ---------------------------------------------------------------------------

function validateSubmitPlan(raw: Record<string, unknown>): PayloadValidationResult {
  const actionPlanRaw = raw["actionPlan"];
  if (!isObject(actionPlanRaw)) return fail("invalid_payload", "actionPlan must be an object");
  const ap = actionPlanRaw;

  const summary = requireString(ap, "summary", MAX_SUMMARY);
  if (!summary.ok) return fail("invalid_payload", summary.message);

  const stepsRaw = ap["steps"];
  if (!isArray(stepsRaw)) return fail("invalid_payload", "steps must be an array");
  if (stepsRaw.length === 0) return fail("invalid_payload", "steps must not be empty");

  const steps: Record<string, unknown>[] = [];
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = stepsRaw[i];
    if (!isObject(s)) return fail("invalid_payload", `step[${i}] must be an object`);
    const id = requireString(s, "id", MAX_ID);
    if (!id.ok) return fail("invalid_payload", `step[${i}].${id.message}`);
    const title = requireString(s, "title", MAX_SUMMARY);
    if (!title.ok) return fail("invalid_payload", `step[${i}].${title.message}`);
    const criteria = requireStringArray(s, "acceptanceCriteria");
    if (!criteria.ok) return fail("invalid_payload", `step[${i}].${criteria.message}`);
    const kind = s["kind"];
    if (kind !== "sequential" && kind !== "parallel") return fail("invalid_payload", `step[${i}].kind must be "sequential" or "parallel"`);
    const step: Record<string, unknown> = { id: id.value, title: title.value, acceptanceCriteria: criteria.value, kind };
    if (s["assigneeId"] !== undefined) {
      const aId = requireStringOrNull(s, "assigneeId", MAX_ID);
      if (!aId.ok) return fail("invalid_payload", `step[${i}].${aId.message}`);
      step["assigneeId"] = aId.value;
    }
    steps.push(step);
  }

  const inReplyTo = optionalString(raw, "inReplyToMessageId", MAX_ID);
  if (!inReplyTo.ok) return fail("invalid_payload", inReplyTo.message);

  const payload: Record<string, unknown> = {
    actionPlan: { summary: summary.value, steps },
  };
  if (inReplyTo.value !== undefined) payload["inReplyToMessageId"] = inReplyTo.value;
  return ok(payload);
}

function validateApprovePlan(raw: Record<string, unknown>): PayloadValidationResult {
  const planId = requireString(raw, "actionPlanId", MAX_ID);
  if (!planId.ok) return fail("invalid_payload", planId.message);
  const version = requirePositiveNumber(raw, "actionPlanVersion");
  if (!version.ok) return fail("invalid_payload", version.message);
  const constraints = optionalString(raw, "constraints", MAX_TEXT);
  if (!constraints.ok) return fail("invalid_payload", constraints.message);

  const payload: Record<string, unknown> = { actionPlanId: planId.value, actionPlanVersion: version.value };
  if (constraints.value !== undefined) payload["constraints"] = constraints.value;
  return ok(payload);
}

function validateRequestPlanChanges(raw: Record<string, unknown>): PayloadValidationResult {
  const planId = requireString(raw, "actionPlanId", MAX_ID);
  if (!planId.ok) return fail("invalid_payload", planId.message);
  const version = requirePositiveNumber(raw, "actionPlanVersion");
  if (!version.ok) return fail("invalid_payload", version.message);
  const comment = requireString(raw, "reviewerComment", MAX_TEXT);
  if (!comment.ok) return fail("invalid_payload", comment.message);
  if (comment.value.length === 0) return fail("invalid_payload", "reviewerComment must not be empty");

  return ok({ actionPlanId: planId.value, actionPlanVersion: version.value, reviewerComment: comment.value });
}

function validateStartImplementation(raw: Record<string, unknown>): PayloadValidationResult {
  const worktreePath = requireStringOrNull(raw, "worktreePath", MAX_TEXT);
  if (!worktreePath.ok) return fail("invalid_payload", worktreePath.message);
  const branchName = requireStringOrNull(raw, "branchName", MAX_ID);
  if (!branchName.ok) return fail("invalid_payload", branchName.message);

  const payload: Record<string, unknown> = {};
  if (worktreePath.value !== null) payload["worktreePath"] = worktreePath.value;
  if (branchName.value !== null) payload["branchName"] = branchName.value;
  return ok(payload);
}

function validateCheckpoint(raw: Record<string, unknown>): PayloadValidationResult {
  const completedWork = requireStringArray(raw, "completedWork");
  if (!completedWork.ok) return fail("invalid_payload", completedWork.message);
  const evidence = requireStringArray(raw, "evidence");
  if (!evidence.ok) return fail("invalid_payload", evidence.message);
  const openChecklist = requireStringArray(raw, "openChecklist");
  if (!openChecklist.ok) return fail("invalid_payload", openChecklist.message);
  const nextAction = optionalString(raw, "nextAction", MAX_REASON);
  if (!nextAction.ok) return fail("invalid_payload", nextAction.message);
  const risks = requireStringArray(raw, "risks");
  if (!risks.ok) return fail("invalid_payload", risks.message);

  const payload: Record<string, unknown> = {};
  if (completedWork.value.length > 0) payload["completedWork"] = completedWork.value;
  if (evidence.value.length > 0) payload["evidence"] = evidence.value;
  if (openChecklist.value.length > 0) payload["openChecklist"] = openChecklist.value;
  if (nextAction.value !== undefined) payload["nextAction"] = nextAction.value;
  if (risks.value.length > 0) payload["risks"] = risks.value;
  return ok(payload);
}

function validateSubmitForReview(raw: Record<string, unknown>): PayloadValidationResult {
  const candidateSha = requireStringOrNull(raw, "candidateSha", MAX_ID);
  if (!candidateSha.ok) return fail("invalid_payload", candidateSha.message);
  const baseSha = requireStringOrNull(raw, "baseSha", MAX_ID);
  if (!baseSha.ok) return fail("invalid_payload", baseSha.message);
  const repoTouched = requireBoolean(raw, "repoTouched");
  if (!repoTouched.ok) return fail("invalid_payload", repoTouched.message);

  // When repo is touched, candidateSha and baseSha must be non-null strings.
  if (repoTouched.value) {
    if (!candidateSha.value) return fail("missing_evidence", "candidateSha is required when repoTouched is true");
    if (!baseSha.value) return fail("missing_evidence", "baseSha is required when repoTouched is true");
  }

  const worktreePath = requireStringOrNull(raw, "worktreePath", MAX_TEXT);
  if (!worktreePath.ok) return fail("invalid_payload", worktreePath.message);
  const branchName = requireStringOrNull(raw, "branchName", MAX_ID);
  if (!branchName.ok) return fail("invalid_payload", branchName.message);
  const comment = optionalString(raw, "comment", MAX_TEXT);
  if (!comment.ok) return fail("invalid_payload", comment.message);

  const payload: Record<string, unknown> = {
    candidateSha: candidateSha.value,
    baseSha: baseSha.value,
    repoTouched: repoTouched.value,
  };
  if (worktreePath.value !== null) payload["worktreePath"] = worktreePath.value;
  if (branchName.value !== null) payload["branchName"] = branchName.value;
  if (comment.value !== undefined) payload["comment"] = comment.value;
  return ok(payload);
}

function validateRequestReviewChanges(raw: Record<string, unknown>): PayloadValidationResult {
  const reviewRunId = requireString(raw, "reviewRunId", MAX_ID);
  if (!reviewRunId.ok) return fail("invalid_payload", reviewRunId.message);
  const candidateSha = requireString(raw, "candidateSha", MAX_ID);
  if (!candidateSha.ok) return fail("invalid_payload", candidateSha.message);
  const comment = requireString(raw, "reviewerComment", MAX_TEXT);
  if (!comment.ok) return fail("invalid_payload", comment.message);
  if (comment.value.length === 0) return fail("invalid_payload", "reviewerComment must not be empty");

  return ok({ reviewRunId: reviewRunId.value, candidateSha: candidateSha.value, reviewerComment: comment.value });
}

function validateAcceptReview(raw: Record<string, unknown>): PayloadValidationResult {
  const reviewRunId = requireString(raw, "reviewRunId", MAX_ID);
  if (!reviewRunId.ok) return fail("invalid_payload", reviewRunId.message);
  const candidateSha = requireString(raw, "candidateSha", MAX_ID);
  if (!candidateSha.ok) return fail("invalid_payload", candidateSha.message);

  return ok({ reviewRunId: reviewRunId.value, candidateSha: candidateSha.value });
}

function validateRaiseBlocker(raw: Record<string, unknown>): PayloadValidationResult {
  const blockerRaw = raw["blockerReport"];
  if (!isObject(blockerRaw)) return fail("invalid_payload", "blockerReport must be an object");
  const br = blockerRaw;

  const blockedOn = br["blockedOn"];
  if (!isString(blockedOn) || !["person", "permission", "external_service", "decision", "dependency"].includes(blockedOn)) {
    return fail("invalid_payload", "blockerReport.blockedOn must be one of: person, permission, external_service, decision, dependency");
  }

  const requestedActor = requireStringOrNull(br, "requestedActor", MAX_ID);
  if (!requestedActor.ok) return fail("invalid_payload", `blockerReport.${requestedActor.message}`);

  const requestedAction = requireString(br, "requestedAction", MAX_ACTION);
  if (!requestedAction.ok) return fail("invalid_payload", `blockerReport.${requestedAction.message}`);

  const evidence = requireStringArray(br, "evidence");
  if (!evidence.ok) return fail("invalid_payload", `blockerReport.${evidence.message}`);

  const diagnostics = requireStringArray(br, "diagnosticsAttempted");
  if (!diagnostics.ok) return fail("invalid_payload", `blockerReport.${diagnostics.message}`);

  const resumeCondition = requireString(br, "resumeCondition", MAX_RESUME);
  if (!resumeCondition.ok) return fail("invalid_payload", `blockerReport.${resumeCondition.message}`);

  const reporterCanResolve = requireBoolean(br, "reporterCanResolve");
  if (!reporterCanResolve.ok) return fail("invalid_payload", `blockerReport.${reporterCanResolve.message}`);

  const blockerReport: Record<string, unknown> = {
    blockedOn,
    requestedActor: requestedActor.value,
    requestedAction: requestedAction.value,
    evidence: evidence.value,
    diagnosticsAttempted: diagnostics.value,
    resumeCondition: resumeCondition.value,
    reporterCanResolve: reporterCanResolve.value,
  };

  const payload: Record<string, unknown> = { blockerReport };

  // Optional permission fields
  const permissionKind = br["permissionKind"];
  if (permissionKind !== undefined) {
    if (permissionKind !== "reporter_approval" && permissionKind !== "publish_checkpoint" && permissionKind !== null) {
      return fail("invalid_payload", "permissionKind must be 'reporter_approval', 'publish_checkpoint', or null");
    }
    payload["permissionKind"] = permissionKind;
  }

  const permissionScope = optionalString(raw, "permissionScope", MAX_PERMISSION_SCOPE);
  if (!permissionScope.ok) return fail("invalid_payload", permissionScope.message);
  if (permissionScope.value !== undefined) payload["permissionScope"] = permissionScope.value;

  const comment = optionalString(raw, "comment", MAX_TEXT);
  if (!comment.ok) return fail("invalid_payload", comment.message);
  if (comment.value !== undefined) payload["comment"] = comment.value;

  return ok(payload);
}

function validateClearBlocker(raw: Record<string, unknown>): PayloadValidationResult {
  const blockerId = requireString(raw, "blockerId", MAX_ID);
  if (!blockerId.ok) return fail("invalid_payload", blockerId.message);
  const resolution = requireString(raw, "resolution", MAX_TEXT);
  if (!resolution.ok) return fail("invalid_payload", resolution.message);
  if (resolution.value.length === 0) return fail("invalid_payload", "resolution must not be empty");

  return ok({ blockerId: blockerId.value, resolution: resolution.value });
}

function validateCancelTask(raw: Record<string, unknown>): PayloadValidationResult {
  const reason = requireStringOrNull(raw, "reason", MAX_REASON);
  if (!reason.ok) return fail("invalid_payload", reason.message);
  return ok({ reason: reason.value });
}

function validateArchiveTask(): PayloadValidationResult {
  return ok({});
}

function validateTriageTask(raw: Record<string, unknown>): PayloadValidationResult {
  const targetStatus = raw["targetStatus"];
  if (targetStatus !== "To Do" && targetStatus !== "Backlog") {
    return fail("invalid_payload", "targetStatus must be 'To Do' or 'Backlog'");
  }
  const reason = requireStringOrNull(raw, "reason", MAX_REASON);
  if (!reason.ok) return fail("invalid_payload", reason.message);

  const payload: Record<string, unknown> = { targetStatus };
  if (reason.value !== null) payload["reason"] = reason.value;
  return ok(payload);
}

function validateAssignTask(raw: Record<string, unknown>): PayloadValidationResult {
  const assigneeUsername = requireString(raw, "assigneeUsername", MAX_ID);
  if (!assigneeUsername.ok) return fail("invalid_payload", assigneeUsername.message);
  const afterPlanApproval = requireBoolean(raw, "afterPlanApproval");
  if (!afterPlanApproval.ok) return fail("invalid_payload", afterPlanApproval.message);

  return ok({ assigneeUsername: assigneeUsername.value, afterPlanApproval: afterPlanApproval.value });
}

function validateRaiseScopeBlocker(raw: Record<string, unknown>): PayloadValidationResult {
  const scopeDescription = requireString(raw, "scopeDescription", MAX_SCOPE);
  if (!scopeDescription.ok) return fail("invalid_payload", scopeDescription.message);
  if (scopeDescription.value.length === 0) return fail("invalid_payload", "scopeDescription must not be empty");

  const evidence = requireStringArray(raw, "evidence");
  if (!evidence.ok) return fail("invalid_payload", evidence.message);
  const requestedActor = requireStringOrNull(raw, "requestedActor", MAX_ID);
  if (!requestedActor.ok) return fail("invalid_payload", requestedActor.message);

  const payload: Record<string, unknown> = { scopeDescription: scopeDescription.value };
  if (evidence.value.length > 0) payload["evidence"] = evidence.value;
  if (requestedActor.value !== null) payload["requestedActor"] = requestedActor.value;
  return ok(payload);
}

function validateRepositoryCallback(raw: Record<string, unknown>, expectedOutcome: "succeeded" | "failed", intentName: string): PayloadValidationResult {
  const procedureRunId = requireString(raw, "procedureRunId", MAX_ID);
  if (!procedureRunId.ok) return fail("invalid_payload", procedureRunId.message);
  const procedureStepId = requireString(raw, "procedureStepId", MAX_ID);
  if (!procedureStepId.ok) return fail("invalid_payload", procedureStepId.message);
  const jobId = requireStringOrNull(raw, "jobId", MAX_ID);
  if (!jobId.ok) return fail("invalid_payload", jobId.message);
  const candidateSha = requireStringOrNull(raw, "candidateSha", MAX_ID);
  if (!candidateSha.ok) return fail("invalid_payload", candidateSha.message);
  const baseSha = requireStringOrNull(raw, "baseSha", MAX_ID);
  if (!baseSha.ok) return fail("invalid_payload", baseSha.message);
  const outcome = raw["outcome"];
  if (outcome !== expectedOutcome) {
    return fail("invalid_payload", `outcome must be "${expectedOutcome}" for ${intentName}`);
  }

  // Empty strings are malformed evidence for SHAs and job IDs — normalize to null
  // so they skip equality checks in procedure-runner instead of producing spurious mismatches.
  const normalizedJobId = jobId.value === "" ? null : jobId.value;
  const normalizedCandidateSha = candidateSha.value === "" ? null : candidateSha.value;
  const normalizedBaseSha = baseSha.value === "" ? null : baseSha.value;

  const payload: Record<string, unknown> = {
    procedureRunId: procedureRunId.value,
    procedureStepId: procedureStepId.value,
    jobId: normalizedJobId,
    candidateSha: normalizedCandidateSha,
    baseSha: normalizedBaseSha,
    outcome: expectedOutcome,
  };

  // Succeeded finalization: optional publishedSha
  if (expectedOutcome === "succeeded" && intentName === "repository_finalization_succeeded") {
    const publishedSha = requireStringOrNull(raw, "publishedSha", MAX_ID);
    if (!publishedSha.ok) return fail("invalid_payload", publishedSha.message);
    payload["publishedSha"] = publishedSha.value;
  }

  // Failed: optional failureReason
  if (expectedOutcome === "failed") {
    const failureReason = requireStringOrNull(raw, "failureReason", MAX_TEXT);
    if (!failureReason.ok) return fail("invalid_payload", failureReason.message);
    payload["failureReason"] = failureReason.value;
  }

  return ok(payload);
}

function validatePublishCheckpoint(raw: Record<string, unknown>): PayloadValidationResult {
  const authorizationCommentId = requireString(raw, "authorizationCommentId", MAX_ID);
  if (!authorizationCommentId.ok) return fail("invalid_payload", authorizationCommentId.message);
  const candidateSha = requireString(raw, "candidateSha", MAX_ID);
  if (!candidateSha.ok) return fail("invalid_payload", candidateSha.message);
  const baseSha = requireString(raw, "baseSha", MAX_ID);
  if (!baseSha.ok) return fail("invalid_payload", baseSha.message);

  return ok({ authorizationCommentId: authorizationCommentId.value, candidateSha: candidateSha.value, baseSha: baseSha.value });
}

function validateAddSubtask(raw: Record<string, unknown>): PayloadValidationResult {
  const subtaskText = requireString(raw, "subtaskText", MAX_SUBTASK);
  if (!subtaskText.ok) return fail("invalid_payload", subtaskText.message);
  if (subtaskText.value.length === 0) return fail("invalid_payload", "subtaskText must not be empty");
  return ok({ subtaskText: subtaskText.value });
}

function validateCompleteSubtask(raw: Record<string, unknown>): PayloadValidationResult {
  const subtaskId = requireString(raw, "subtaskId", MAX_ID);
  if (!subtaskId.ok) return fail("invalid_payload", subtaskId.message);
  const completed = requireBoolean(raw, "completed");
  if (!completed.ok) return fail("invalid_payload", completed.message);
  const minutesSpent = optionalNumberOrNull(raw, "minutesSpent");
  if (!minutesSpent.ok) return fail("invalid_payload", minutesSpent.message);

  const payload: Record<string, unknown> = { subtaskId: subtaskId.value, completed: completed.value };
  if (minutesSpent.value !== null) payload["minutesSpent"] = minutesSpent.value;
  return ok(payload);
}

function validateRemoveSubtask(raw: Record<string, unknown>): PayloadValidationResult {
  const subtaskId = requireString(raw, "subtaskId", MAX_ID);
  if (!subtaskId.ok) return fail("invalid_payload", subtaskId.message);
  return ok({ subtaskId: subtaskId.value });
}

function validateRequestSubtask(raw: Record<string, unknown>): PayloadValidationResult {
  const subtaskText = requireString(raw, "subtaskText", MAX_SUBTASK);
  if (!subtaskText.ok) return fail("invalid_payload", subtaskText.message);
  if (subtaskText.value.length === 0) return fail("invalid_payload", "subtaskText must not be empty");
  return ok({ subtaskText: subtaskText.value });
}

function validateRequestTask(raw: Record<string, unknown>): PayloadValidationResult {
  const taskTitle = requireString(raw, "taskTitle", MAX_TASK_TITLE);
  if (!taskTitle.ok) return fail("invalid_payload", taskTitle.message);
  if (taskTitle.value.length === 0) return fail("invalid_payload", "taskTitle must not be empty");

  const taskDescription = requireStringOrNull(raw, "taskDescription", MAX_TEXT);
  if (!taskDescription.ok) return fail("invalid_payload", taskDescription.message);
  const epicId = requireStringOrNull(raw, "epicId", MAX_ID);
  if (!epicId.ok) return fail("invalid_payload", epicId.message);

  const payload: Record<string, unknown> = { taskTitle: taskTitle.value };
  if (taskDescription.value !== null) payload["taskDescription"] = taskDescription.value;
  if (epicId.value !== null) payload["epicId"] = epicId.value;
  return ok(payload);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Validate a raw payload against the schema for the given intent.
 *
 * Returns `{ ok: true, payload }` with the validated and normalized payload,
 * or `{ ok: false, code, message }` with a stable DomainErrorCode.
 *
 * Pure function — no DB access, no side effects, never throws.
 * Untrusted client-provided fields (actor role, owner IDs, project IDs,
 * workflowVersion) are explicitly rejected.
 */
export function validateCommandPayload(
  intent: TaskWorkflowIntent,
  rawPayload: unknown,
): PayloadValidationResult {
  if (!isObject(rawPayload)) {
    return fail("invalid_payload", "payload must be an object");
  }

  // Reject untrusted client-provided server-resolved fields.
  const rejectedKey = checkRejectedKeys(rawPayload);
  if (rejectedKey) {
    return fail("invalid_payload", `Client-supplied field "${rejectedKey}" is server-resolved only and must not appear in the payload`);
  }

  const raw = rawPayload as Record<string, unknown>;

  switch (intent) {
    case "submit_plan": return validateSubmitPlan(raw);
    case "approve_plan": return validateApprovePlan(raw);
    case "request_plan_changes": return validateRequestPlanChanges(raw);
    case "start_implementation": return validateStartImplementation(raw);
    case "checkpoint": return validateCheckpoint(raw);
    case "submit_for_review": return validateSubmitForReview(raw);
    case "request_review_changes": return validateRequestReviewChanges(raw);
    case "accept_review": return validateAcceptReview(raw);
    case "raise_blocker": return validateRaiseBlocker(raw);
    case "clear_blocker": return validateClearBlocker(raw);
    case "cancel_task": return validateCancelTask(raw);
    case "archive_task": return validateArchiveTask();
    case "triage_task": return validateTriageTask(raw);
    case "assign_task": return validateAssignTask(raw);
    case "raise_scope_blocker": return validateRaiseScopeBlocker(raw);
    case "repository_validation_succeeded":
      return validateRepositoryCallback(raw, "succeeded", "repository_validation_succeeded");
    case "repository_validation_failed":
      return validateRepositoryCallback(raw, "failed", "repository_validation_failed");
    case "repository_finalization_succeeded":
      return validateRepositoryCallback(raw, "succeeded", "repository_finalization_succeeded");
    case "repository_finalization_failed":
      return validateRepositoryCallback(raw, "failed", "repository_finalization_failed");
    case "publish_checkpoint": return validatePublishCheckpoint(raw);
    case "add_subtask": return validateAddSubtask(raw);
    case "complete_subtask": return validateCompleteSubtask(raw);
    case "remove_subtask": return validateRemoveSubtask(raw);
    case "request_subtask": return validateRequestSubtask(raw);
    case "request_task": return validateRequestTask(raw);
    default:
      return fail("unknown_intent", `validateCommandPayload: unsupported intent ${intent}`);
  }
}