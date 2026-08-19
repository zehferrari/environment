type TaskActivityKindRow = {
  taskId?: string | null;
  kind: string;
  payload?: string | null;
  createdAt?: Date | string | number | null;
};

type TaskBlockerCommentRow = {
  id: string;
  taskId: string | null;
  createdAt: Date | string | number;
};

export const BLOCKER_PERMISSION_KINDS = [
  "reporter_approval",
  "publish_checkpoint",
] as const;

export type BlockerPermissionKind = (typeof BLOCKER_PERMISSION_KINDS)[number];

export type BlockerPermissionRequest = {
  kind: BlockerPermissionKind;
  scope: string;
  taskKey?: string | null;
  taskBranch?: string | null;
  epicBranch?: string | null;
};

// ENV-120. A formal blocker is a claim that a HUMAN or EXTERNAL party must act
// before implementation can continue. Free prose cannot be checked, so the
// claim is carried as structured data and validated before it is allowed to
// move the task into a human-blocked state.
export const FORMAL_BLOCKER_BLOCKED_ON = [
  "person",
  "permission",
  "external_service",
  "decision",
  "dependency",
] as const;

export type FormalBlockerBlockedOn = (typeof FORMAL_BLOCKER_BLOCKED_ON)[number];

export type FormalBlockerReport = {
  blockedOn: FormalBlockerBlockedOn;
  /** Who must act. Never the assignee — that is the rejection case below. */
  requestedActor: string;
  /** The concrete action that party must perform. */
  requestedAction: string;
  /** Observed failure evidence: exact error text, endpoint, identifier. */
  evidence: string;
  /** Distinct diagnoses already attempted. An empty list is not a blocker. */
  diagnosticsAttempted: string[];
  /** The observable condition that means work can resume. */
  resumeCondition: string;
  reporterCanResolve: boolean;
  /** Present only when this blocker is also a scoped permission request. */
  permission?: BlockerPermissionRequest | null;
};

export type WaitForHumanBlockerOverride = {
  kind: "wait_for_human";
  targetStatus: string | null;
  reason: string | null;
};

export type ActiveFormalBlocker = {
  commentId: string | null;
  permissionRequest: BlockerPermissionRequest | null;
  report: FormalBlockerReport | null;
  raisedAt: Date | string | number | null;
  /** Present only for the blocker created by a human status override. */
  override: WaitForHumanBlockerOverride | null;
};

export type BlockerPermissionGrant = {
  authorizationCommentId: string | null;
  grantedAt: Date | string | number | null;
};

export type ActiveFormalBlockerState = ActiveFormalBlocker & {
  permissionGrant: BlockerPermissionGrant | null;
};

const FORMAL_BLOCKER_KINDS = new Set([
  "task.blocker",
  "task.extra_work.blocker",
  "task.blocker.cleared",
]);

export function isBlockerPermissionKind(value: unknown): value is BlockerPermissionKind {
  return typeof value === "string" && (BLOCKER_PERMISSION_KINDS as readonly string[]).includes(value);
}

export function isFormalBlockerBlockedOn(value: unknown): value is FormalBlockerBlockedOn {
  return typeof value === "string" && (FORMAL_BLOCKER_BLOCKED_ON as readonly string[]).includes(value);
}

/**
 * A permission round is closed by the grant itself only when the grant IS the
 * whole dependency. A publish_checkpoint round stays open until its authorized
 * attempt settles, because the single-use authorization must remain resolvable
 * from the active blocker while the runner consumes it
 * (see lib/tasks/checkpoint-blocker.ts).
 */
export function blockerRoundClosesOnGrant(kind: BlockerPermissionKind) {
  return kind === "reporter_approval";
}

function parsedPayload(payload: string | null | undefined) {
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function timestamp(value: Date | string | number) {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export function blockerMetadataFromPayload(payload: string | null | undefined): ActiveFormalBlocker {
  const parsed = parsedPayload(payload);
  const commentId = typeof parsed?.commentId === "string" && parsed.commentId.trim()
    ? parsed.commentId
    : null;
  // Rows written before ENV-120 carry no report. They stay readable: the
  // structured fields simply resolve to null.
  const report = formalBlockerReportFromValue(parsed?.blockerReport);
  const rawOverride = parsed?.override;
  const override: WaitForHumanBlockerOverride | null =
    rawOverride && typeof rawOverride === "object"
      && (rawOverride as Record<string, unknown>).kind === "wait_for_human"
      ? {
          kind: "wait_for_human",
          targetStatus: typeof (rawOverride as Record<string, unknown>).targetStatus === "string"
            ? (rawOverride as Record<string, unknown>).targetStatus as string
            : null,
          reason: typeof (rawOverride as Record<string, unknown>).reason === "string"
            ? (rawOverride as Record<string, unknown>).reason as string
            : null,
        }
      : null;
  const rawRequest = parsed?.permissionRequest;
  if (!rawRequest || typeof rawRequest !== "object") {
    return { commentId, permissionRequest: null, report, raisedAt: null, override };
  }
  const request = rawRequest as Record<string, unknown>;
  if (!isBlockerPermissionKind(request.kind) || typeof request.scope !== "string" || !request.scope.trim()) {
    return { commentId, permissionRequest: null, report, raisedAt: null, override };
  }
  return {
    commentId,
    permissionRequest: {
      kind: request.kind,
      scope: request.scope.trim(),
      taskKey: typeof request.taskKey === "string" ? request.taskKey : null,
      taskBranch: typeof request.taskBranch === "string" ? request.taskBranch : null,
      epicBranch: typeof request.epicBranch === "string" ? request.epicBranch : null,
    },
    report,
    raisedAt: null,
    override,
  };
}

// ------------------------------------------------------------------
// ENV-120 — structured blocker report: parsing, validation, classification
// ------------------------------------------------------------------
//
// These are PURE functions over plain shapes. No Prisma, no request object:
// the rules that decide "is this a real human blocker?" must be exercisable
// from a fixture, because that is the only way the decision stays
// deterministic rather than a per-turn judgement call.

export const FORMAL_BLOCKER_RULES = [
  "missing_report",
  "unknown_blocked_on",
  "missing_requested_actor",
  "requested_actor_is_assignee",
  "missing_requested_action",
  "missing_evidence",
  "no_diagnostics_attempted",
  "missing_resume_condition",
  "resume_condition_not_concrete",
  "recoverable_tool_failure",
  "retry_with_fresh_session",
] as const;

export type FormalBlockerRule = (typeof FORMAL_BLOCKER_RULES)[number];

export type FormalBlockerValidation =
  | { ok: true; report: FormalBlockerReport }
  | { ok: false; rule: FormalBlockerRule; message: string };

export type BlockerFailureClassification =
  | { outcome: "accept"; report: FormalBlockerReport }
  | { outcome: "reject"; rule: FormalBlockerRule; message: string }
  | { outcome: "incident"; rule: FormalBlockerRule; message: string; guidance: string };

export type BlockerClassificationContext = {
  /** Every identifier that resolves to the assignee: username, slug, user id. */
  assigneeIdentifiers: readonly (string | null | undefined)[];
  /**
   * How many EARLIER incident rounds for this same failure signature already
   * recorded a diagnosis distinct from the current one. Elapsed time and bare
   * retry counts are deliberately not inputs: only distinct diagnostic
   * evidence can promote a technical failure to a human blocker.
   */
  priorDistinctDiagnostics?: number;
};

/**
 * Blocker classes whose dependency is a technical system rather than a named
 * human decision. Only these can be downgraded to an internal incident.
 */
const TECHNICAL_BLOCKED_ON = new Set<FormalBlockerBlockedOn>([
  "external_service",
  "dependency",
]);

/** Distinct diagnoses required before a technical failure may become a blocker. */
export const FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES = 2;

/** Prior incident rounds (with distinct evidence) required for the same escalation. */
export const FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS = 1;

const SELF_ACTOR_TOKENS = new Set(["me", "myself", "self", "assignee", "agent", "i"]);

const VAGUE_RESUME_CONDITIONS = new Set([
  "unblocked",
  "resolved",
  "fixed",
  "done",
  "asap",
  "soon",
  "tbd",
  "n/a",
  "na",
  "unknown",
  "when it works",
  "when unblocked",
  "when resolved",
  "when fixed",
]);

// Fault shapes a fresh browser/session/process legitimately retries. A single
// occurrence of one of these is never a human blocker.
const RETRYABLE_EVIDENCE = [
  /\bbrowser\b/i,
  /\bplaywright\b/i,
  /\bchromium\b/i,
  /\bstale (element|ref)/i,
  /\bpage crashed\b/i,
  /\bsession (expired|closed|not created)\b/i,
  /\btimed? ?out\b/i,
  /\bETIMEDOUT\b/,
  /\bECONNRESET\b/,
  /\bECONNREFUSED\b/,
  /\bEPIPE\b/,
  /\bsocket hang up\b/i,
  /\b(429|502|503|504)\b/,
];

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeActor(value: string) {
  // "@barekbaal", "the assignee" and "Assignee" are the same claim.
  return normalizeText(value)
    .replace(/^@+/, "")
    .replace(/^(the|this|a)\s+/i, "")
    .toLowerCase();
}

/**
 * Identity of one diagnosis. Case and trailing punctuation are not new
 * evidence: restating "re-ran the push" with a full stop must not count as a
 * second distinct diagnosis, because distinct diagnoses are what earn an
 * escalation out of the internal incident state.
 */
function diagnosisKey(value: string) {
  return value.toLowerCase().replace(/[.!?;,\s]+$/, "");
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const text = normalizeText(entry);
    if (!text) continue;
    const key = diagnosisKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** Read a persisted report back off an activity payload. Never throws. */
export function formalBlockerReportFromValue(value: unknown): FormalBlockerReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!isFormalBlockerBlockedOn(raw.blockedOn)) return null;
  const requestedActor = normalizeText(raw.requestedActor);
  const requestedAction = normalizeText(raw.requestedAction);
  const evidence = normalizeText(raw.evidence);
  const resumeCondition = normalizeText(raw.resumeCondition);
  if (!requestedActor || !requestedAction || !evidence || !resumeCondition) return null;
  const permission = raw.permission && typeof raw.permission === "object"
    ? (raw.permission as Record<string, unknown>)
    : null;
  return {
    blockedOn: raw.blockedOn,
    requestedActor,
    requestedAction,
    evidence,
    diagnosticsAttempted: stringList(raw.diagnosticsAttempted),
    resumeCondition,
    reporterCanResolve: raw.reporterCanResolve === true,
    permission: permission && isBlockerPermissionKind(permission.kind) && typeof permission.scope === "string"
      ? {
        kind: permission.kind,
        scope: permission.scope,
        taskKey: typeof permission.taskKey === "string" ? permission.taskKey : null,
        taskBranch: typeof permission.taskBranch === "string" ? permission.taskBranch : null,
        epicBranch: typeof permission.epicBranch === "string" ? permission.epicBranch : null,
      }
      : null,
  };
}

/**
 * Shape validation only: every required field is present, typed and non-empty.
 * Whether the claim is a genuine external dependency is classifyBlockerFailure.
 */
export function validateFormalBlockerReport(input: unknown): FormalBlockerValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      rule: "missing_report",
      message:
        "blockerReport is required: { blockedOn, requestedActor, requestedAction, evidence, diagnosticsAttempted[], resumeCondition, reporterCanResolve }",
    };
  }
  const raw = input as Record<string, unknown>;
  if (!isFormalBlockerBlockedOn(raw.blockedOn)) {
    return {
      ok: false,
      rule: "unknown_blocked_on",
      message: `blockerReport.blockedOn must be one of ${FORMAL_BLOCKER_BLOCKED_ON.join(", ")}`,
    };
  }
  const requestedActor = normalizeText(raw.requestedActor);
  if (!requestedActor) {
    return {
      ok: false,
      rule: "missing_requested_actor",
      message: "blockerReport.requestedActor must name the person, team or service that has to act",
    };
  }
  const requestedAction = normalizeText(raw.requestedAction);
  if (!requestedAction) {
    return {
      ok: false,
      rule: "missing_requested_action",
      message: "blockerReport.requestedAction must state the exact action that party must perform",
    };
  }
  const evidence = normalizeText(raw.evidence);
  if (!evidence) {
    return {
      ok: false,
      rule: "missing_evidence",
      message: "blockerReport.evidence must quote the observed failure: exact error text, endpoint or identifier",
    };
  }
  const diagnosticsAttempted = stringList(raw.diagnosticsAttempted);
  if (diagnosticsAttempted.length === 0) {
    return {
      ok: false,
      rule: "no_diagnostics_attempted",
      message: "blockerReport.diagnosticsAttempted must list what you actually tried before escalating",
    };
  }
  const resumeCondition = normalizeText(raw.resumeCondition);
  if (!resumeCondition) {
    return {
      ok: false,
      rule: "missing_resume_condition",
      message: "blockerReport.resumeCondition must state the observable condition that lets work resume",
    };
  }
  if (resumeCondition.length < 12 || VAGUE_RESUME_CONDITIONS.has(resumeCondition.toLowerCase())) {
    return {
      ok: false,
      rule: "resume_condition_not_concrete",
      message: `blockerReport.resumeCondition is not concrete ("${resumeCondition}"): name the observable state that proves the dependency is gone`,
    };
  }
  return {
    ok: true,
    report: {
      blockedOn: raw.blockedOn,
      requestedActor,
      requestedAction,
      evidence,
      diagnosticsAttempted,
      resumeCondition,
      reporterCanResolve: raw.reporterCanResolve === true,
      permission: null,
    },
  };
}

/**
 * Stable identity for "the same external dependency", used to group incident
 * rounds within one task/assignee query.
 *
 * Evidence is deliberately excluded. A useful retry adds observations to (and
 * often rewrites the opening of) its evidence paragraph; deriving identity
 * from those first characters reset priorDistinctDiagnostics to zero on every
 * improved report and made the bounded escalation path unreachable. The
 * diagnostic fingerprint below remains evidence-sensitive, so repeating the
 * same work still earns nothing. A different dependency owner or dependency
 * type starts a new incident group.
 */
export function blockerFailureSignature(report: FormalBlockerReport) {
  return `${report.blockedOn}:${normalizeActor(report.requestedActor)}`;
}

/** Stable identity for "this diagnosis", used to require DISTINCT evidence. */
export function blockerDiagnosticsFingerprint(report: FormalBlockerReport) {
  return report.diagnosticsAttempted
    .map(diagnosisKey)
    .sort()
    .join("|");
}

function looksRetryable(report: FormalBlockerReport) {
  const haystack = `${report.evidence} ${report.diagnosticsAttempted.join(" ")}`;
  return RETRYABLE_EVIDENCE.some((pattern) => pattern.test(haystack));
}

/**
 * The deterministic gate in front of a human-blocked state.
 *
 *  accept   — a real external dependency; raise the formal blocker.
 *  reject   — the claim is malformed or self-directed; the agent fixes the
 *             report (or the work) and the task never leaves execution.
 *  incident — a recoverable technical failure. Record it, keep the task In
 *             Progress, and let the agent retry. Escalation is possible only
 *             through the bounded distinct-diagnosis policy below — never
 *             because time passed or because a retry counter ticked.
 */
export function classifyBlockerFailure(
  input: unknown,
  context: BlockerClassificationContext,
): BlockerFailureClassification {
  const validation = validateFormalBlockerReport(input);
  if (!validation.ok) return { outcome: "reject", rule: validation.rule, message: validation.message };
  const report = validation.report;

  const assignee = new Set(
    context.assigneeIdentifiers
      .filter((value): value is string => typeof value === "string" && value.trim() !== "")
      .map(normalizeActor),
  );
  const actor = normalizeActor(report.requestedActor);
  if (assignee.has(actor) || SELF_ACTOR_TOKENS.has(actor)) {
    return {
      outcome: "reject",
      rule: "requested_actor_is_assignee",
      message: `blockerReport.requestedActor resolves to you ("${report.requestedActor}"). Work you can perform yourself is not a formal blocker.`,
    };
  }

  if (!TECHNICAL_BLOCKED_ON.has(report.blockedOn)) {
    // person / permission / decision: the dependency IS a human. There is no
    // retry that resolves it, so it never becomes an internal incident.
    return { outcome: "accept", report };
  }

  const distinctDiagnoses = new Set(report.diagnosticsAttempted.map(diagnosisKey)).size;
  const priorDistinct = Math.max(0, context.priorDistinctDiagnostics ?? 0);
  const escalationEarned =
    distinctDiagnoses >= FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES &&
    priorDistinct >= FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS;
  if (escalationEarned) return { outcome: "accept", report };

  const retryable = looksRetryable(report);
  return {
    outcome: "incident",
    rule: retryable ? "retry_with_fresh_session" : "recoverable_tool_failure",
    message: retryable
      ? `The evidence describes a fault a fresh browser/session retry can clear ("${report.evidence.slice(0, 120)}"). That is not a human blocker.`
      : `A ${report.blockedOn.replace("_", " ")} failure with ${distinctDiagnoses} distinct diagnosis/diagnoses and ${priorDistinct} earlier incident round(s) is still recoverable.`,
    guidance:
      `Recorded as an internal incident; the task stays In Progress and nobody was paged. Retry with a fresh session, then escalate only with at least ${FORMAL_BLOCKER_MIN_DISTINCT_DIAGNOSES} distinct diagnoses after at least ${FORMAL_BLOCKER_MIN_PRIOR_INCIDENTS} earlier incident round carrying different evidence.`,
  };
}

/** Resolve each task's active blocker and the exact comment that raised it. */
export function activeFormalBlockersByTask(
  newestFirstRows: readonly TaskActivityKindRow[],
  legacyBlockerComments: readonly TaskBlockerCommentRow[] = [],
) {
  const resolved = new Set<string>();
  const active = new Map<string, ActiveFormalBlocker>();

  for (const row of newestFirstRows) {
    if (!row.taskId || resolved.has(row.taskId) || !FORMAL_BLOCKER_KINDS.has(row.kind)) {
      continue;
    }
    resolved.add(row.taskId);
    if (row.kind !== "task.blocker.cleared") {
      const metadata = blockerMetadataFromPayload(row.payload);
      if (!metadata.commentId && row.createdAt != null) {
        const activityTime = timestamp(row.createdAt);
        const legacyComment = legacyBlockerComments.find((comment) => (
          comment.taskId === row.taskId &&
          Math.abs(timestamp(comment.createdAt) - activityTime) <= 1_000
        ));
        active.set(row.taskId, {
          ...metadata,
          commentId: legacyComment?.id ?? null,
          raisedAt: row.createdAt ?? null,
        });
      } else {
        active.set(row.taskId, { ...metadata, raisedAt: row.createdAt ?? null });
      }
    }
  }

  return active;
}

export function blockerPermissionGrantForComment(
  newestFirstRows: readonly Pick<TaskActivityKindRow, "kind" | "payload" | "createdAt">[],
  blockerCommentId: string,
) {
  for (const row of newestFirstRows) {
    if (row.kind !== "task.blocker.permission.granted") continue;
    const parsed = parsedPayload(row.payload);
    if (parsed?.blockerCommentId === blockerCommentId) {
      return {
        authorizationCommentId: typeof parsed.authorizationCommentId === "string"
          ? parsed.authorizationCommentId
          : null,
        grantedAt: row.createdAt ?? null,
      };
    }
  }
  return null;
}

/** Resolve active blockers together with the permission round attached to them. */
export function activeFormalBlockerStatesByTask(
  newestFirstRows: readonly TaskActivityKindRow[],
  legacyBlockerComments: readonly TaskBlockerCommentRow[] = [],
) {
  const active = activeFormalBlockersByTask(newestFirstRows, legacyBlockerComments);
  const states = new Map<string, ActiveFormalBlockerState>();
  for (const [taskId, blocker] of active) {
    states.set(taskId, {
      ...blocker,
      permissionGrant: blocker.commentId
        ? blockerPermissionGrantForComment(newestFirstRows, blocker.commentId)
        : null,
    });
  }
  return states;
}

/**
 * A granted permission round is no longer waiting on a human. It remains
 * visible until the authorized operation settles, but execution recovery must
 * keep waking the assignee so the capability is actually used.
 */
export function formalBlockerNeedsExternalInput(blocker: ActiveFormalBlockerState) {
  return !blocker.permissionRequest || !blocker.permissionGrant?.authorizationCommentId;
}

export function activeCheckpointBlockerUsesAuthorization(
  blocker: ActiveFormalBlockerState | null | undefined,
  authorizationCommentId: string,
) {
  return Boolean(
    blocker?.commentId &&
    blocker.permissionRequest?.kind === "publish_checkpoint" &&
    blocker.permissionGrant?.authorizationCommentId === authorizationCommentId,
  );
}

/**
 * Resolve the current formal-blocker state from task activity ordered newest
 * first. `alertReporter` cannot be used for this because repository and
 * administrative alerts share that broader flag.
 */
export function activeFormalBlockerTaskIds(
  newestFirstRows: readonly TaskActivityKindRow[],
) {
  return new Set(activeFormalBlockersByTask(newestFirstRows).keys());
}
