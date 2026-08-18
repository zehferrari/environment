// ORCH-02 — State/cycle/version/repository preconditions for workflow commands.
//
// Guards are pure functions of (state, command). They run AFTER authorization
// and BEFORE the decision function. A guard failure returns a stale/invalid
// result; the orchestrator does not record a transition.
//
// Guards enforce invariants 2 (optimistic concurrency), 5 (one open cycle),
// 6 (one active procedure per type/cycle), and the cycle/candidate/lease
// preconditions for review intents.

import type { TaskWorkflowIntent } from "@/lib/tasks/orchestrator/types";
import type { TaskStateSnapshot } from "@/lib/tasks/orchestrator/types";

export type GuardResult =
  | { ok: true }
  | { ok: false; status: "stale" | "invalid"; reason: string };

// --- Optimistic concurrency (invariant 2) --------------------------------
export function guardWorkflowVersion(state: TaskStateSnapshot, expectedVersion: number): GuardResult {
  if (state.workflowVersion !== expectedVersion) {
    return {
      ok: false,
      status: "stale",
      reason: `Task workflow version changed concurrently: expected ${expectedVersion}, found ${state.workflowVersion}.`,
    };
  }
  return { ok: true };
}

// --- Status precondition --------------------------------------------------
export function guardStatus(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
  allowedStatuses: ReadonlyArray<TaskStateSnapshot["status"]>,
): GuardResult {
  if (!allowedStatuses.includes(state.status)) {
    return {
      ok: false,
      status: "stale",
      reason: `Intent ${intent} requires task status ${allowedStatuses.join(" or ")}, found ${state.status}.`,
    };
  }
  return { ok: true };
}

// --- Approved-plan precondition -------------------------------------------
export function guardApprovedPlan(state: TaskStateSnapshot, intent: TaskWorkflowIntent): GuardResult {
  if (!state.approvedOn) {
    return {
      ok: false,
      status: "invalid",
      reason: `Intent ${intent} requires an approved Action Plan.`,
    };
  }
  return { ok: true };
}

// --- Cycle preconditions --------------------------------------------------
// start_implementation requires NO active cycle (it opens one).
// submit_for_review / checkpoint require an active cycle.
// review intents require an active cycle whose id matches the command.
export function guardCyclePrecondition(
  state: TaskStateSnapshot,
  intent: TaskWorkflowIntent,
  commandCycleId: string | null | undefined,
): GuardResult {
  const hasActiveCycle = Boolean(state.activeWorkflowCycleId);
  if (intent === "start_implementation") {
    if (hasActiveCycle) {
      return {
        ok: false,
        status: "invalid",
        reason: "Cannot start a new implementation cycle while another cycle is open.",
      };
    }
    return { ok: true };
  }
  // All other implementation/review intents require an active cycle.
  if (!hasActiveCycle) {
    return {
      ok: false,
      status: "invalid",
      reason: `Intent ${intent} requires an active workflow cycle, but the task has none.`,
    };
  }
  // If the command names a specific cycle, it must match the active one.
  // This prevents a stale cycle from submitting a review candidate (invariant
  // from §4.5: "a stale cycle cannot submit a review candidate").
  if (commandCycleId && commandCycleId !== state.activeWorkflowCycleId) {
    return {
      ok: false,
      status: "stale",
      reason: `Command targets cycle ${commandCycleId}, but the active cycle is ${state.activeWorkflowCycleId}.`,
    };
  }
  return { ok: true };
}

// --- Review lease precondition (invariant 8) ------------------------------
// accept_review / request_review_changes require an active, awaiting_review
// lease on the active cycle. The lease candidate must match the repository
// candidate (the reviewer decides on an exact candidate, not a moving branch).
export function guardReviewLease(
  state: TaskStateSnapshot,
  intent: "accept_review" | "request_review_changes",
  expectedCandidateSha?: string | null,
): GuardResult {
  const lease = state.activeReviewRun;
  if (!lease) {
    return {
      ok: false,
      status: "invalid",
      reason: `Intent ${intent} requires an active review lease, but none exists for the active cycle.`,
    };
  }
  if (lease.status !== "awaiting_review") {
    return {
      ok: false,
      status: "stale",
      reason: `Intent ${intent} requires an awaiting_review lease, but the lease is ${lease.status}.`,
    };
  }
  // P1-6: verify the candidate SHA matches if the command provides one.
  if (expectedCandidateSha && lease.candidateSha !== expectedCandidateSha) {
    return {
      ok: false,
      status: "stale",
      reason: `Intent ${intent} targets candidate ${expectedCandidateSha}, but the lease candidate is ${lease.candidateSha}.`,
    };
  }
  return { ok: true };
}

// --- Repository preconditions for submit_for_review -----------------------
// submit_for_review requires the repository run to be in a state that allows
// candidate submission (active or action_required). It must not be validating
// (already in flight) or completed.
export function guardRepositoryForSubmit(state: TaskStateSnapshot): GuardResult {
  const repo = state.repositoryRun;
  if (!repo) return { ok: true }; // non-code task
  if (repo.phase === "validating" || repo.phase === "finalizing") {
    return {
      ok: false,
      status: "stale",
      reason: `Cannot submit for review while repository is ${repo.phase}.`,
    };
  }
  return { ok: true };
}

// --- Aggregate guard ------------------------------------------------------
// Runs the intent's required guards in order. Returns the first failure.
export function runGuards(
  state: TaskStateSnapshot,
  command: { intent: TaskWorkflowIntent; expectedWorkflowVersion: number; workflowCycleId?: string | null },
): GuardResult {
  const versionGuard = guardWorkflowVersion(state, command.expectedWorkflowVersion);
  if (!versionGuard.ok) return versionGuard;

  switch (command.intent) {
    case "submit_plan":
      return guardStatus(state, command.intent, ["Backlog", "To Do"]);

    case "approve_plan":
      return guardStatus(state, command.intent, ["Backlog", "To Do"]);

    case "request_plan_changes":
      return guardStatus(state, command.intent, ["Backlog", "To Do"]);

    case "start_implementation":
      // P1-8: start_implementation requires an approved plan, no blockers,
      // and no active cycle. The WIP check is enforced by the legacy
      // move-status/auto-start code; the orchestrator guard covers the
      // cycle + plan + blocker preconditions.
      return runGuardsChain([
        guardStatus(state, command.intent, ["To Do"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "checkpoint":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "submit_for_review":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardApprovedPlan(state, command.intent),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardRepositoryForSubmit(state),
      ]);

    case "repository_validation_succeeded":
    case "repository_validation_failed":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "request_review_changes":
      return runGuardsChain([
        guardStatus(state, command.intent, ["Review"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardReviewLease(state, "request_review_changes", state.activeReviewRun?.candidateSha),
      ]);

    case "accept_review":
      return runGuardsChain([
        guardStatus(state, command.intent, ["Review"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
        guardReviewLease(state, "accept_review", state.activeReviewRun?.candidateSha),
      ]);

    case "repository_finalization_succeeded":
    case "repository_finalization_failed":
      return runGuardsChain([
        guardStatus(state, command.intent, ["Review"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "raise_blocker":
    case "clear_blocker":
      return runGuardsChain([
        guardStatus(state, command.intent, ["In Progress", "To Do", "Review"]),
        guardCyclePrecondition(state, command.intent, command.workflowCycleId),
      ]);

    case "cancel_task":
      return guardStatus(state, command.intent, ["To Do", "In Progress", "Review", "Backlog"]);

    case "archive_task":
      return guardStatus(state, command.intent, ["Done"]);

    default:
      return { ok: false, status: "invalid", reason: `Unknown intent ${command.intent}` };
  }
}

function runGuardsChain(results: GuardResult[]): GuardResult {
  for (const result of results) {
    if (!result.ok) return result;
  }
  return { ok: true };
}